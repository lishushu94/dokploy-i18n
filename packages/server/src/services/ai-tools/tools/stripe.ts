import {
	findOrganizationById,
	findServersByUserId,
	findUserById,
	IS_CLOUD,
	updateUser,
} from "@dokploy/server";
import { findMemberById } from "@dokploy/server/services/user";
import { TRPCError } from "@trpc/server";
import Stripe from "stripe";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

const CONFIRM_STRIPE_CHECKOUT_SESSION_CREATE =
	"CONFIRM_STRIPE_CHECKOUT_SESSION_CREATE" as const;
const CONFIRM_STRIPE_PORTAL_SESSION_CREATE =
	"CONFIRM_STRIPE_PORTAL_SESSION_CREATE" as const;

const WEBSITE_URL =
	process.env.NODE_ENV === "development"
		? "http://localhost:3000"
		: process.env.SITE_URL;

const getStripeItems = (serverQuantity: number, isAnnual: boolean) => {
	const basePriceMonthlyId = process.env.BASE_PRICE_MONTHLY_ID!;
	const baseAnnualMonthlyId = process.env.BASE_ANNUAL_MONTHLY_ID!;

	return [
		{
			price: isAnnual ? baseAnnualMonthlyId : basePriceMonthlyId,
			quantity: serverQuantity,
		},
	];
};

const accessDenied = <T>(message: string, data: T): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const requireOrgOwner = async <T>(ctx: ToolContext, data: T) => {
	const m = await findMemberById(ctx.userId, ctx.organizationId);
	if (m.role !== "owner")
		return accessDenied("Only organization owner can access billing", data);
	return null;
};

const stripeGetProducts: Tool<Record<string, never>, unknown> = {
	name: "stripe_products_list",
	description:
		"List available Stripe products and active subscriptions for the owner.",
	category: "stripe",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, {
			products: [],
			subscriptions: [],
		});
		if (denied) return denied;
		const org = await findOrganizationById(ctx.organizationId);
		const ownerId = org?.ownerId;
		if (!ownerId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Organization owner not found",
			});
		}
		const user = await findUserById(ownerId);
		const stripeCustomerId = user.stripeCustomerId;

		const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
			apiVersion: "2024-09-30.acacia",
		});

		const products = await stripe.products.list({
			expand: ["data.default_price"],
			active: true,
		});

		if (!stripeCustomerId) {
			return {
				success: true,
				message: "Products",
				data: {
					products: products.data,
					subscriptions: [],
				},
			};
		}

		const subscriptions = await stripe.subscriptions.list({
			customer: stripeCustomerId,
			status: "active",
			expand: ["data.items.data.price"],
		});

		return {
			success: true,
			message: "Products",
			data: {
				products: products.data,
				subscriptions: subscriptions.data,
			},
		};
	},
};

const stripeCreateCheckoutSession: Tool<
	{
		productId: string;
		serverQuantity: number;
		isAnnual: boolean;
		confirm: typeof CONFIRM_STRIPE_CHECKOUT_SESSION_CREATE;
	},
	{ sessionId: string }
> = {
	name: "stripe_checkout_session_create",
	description:
		"Create a Stripe Checkout session for subscription purchase. Requires approval + confirm.",
	category: "stripe",
	parameters: z.object({
		productId: z.string().min(1),
		serverQuantity: z.number().min(1),
		isAnnual: z.boolean(),
		confirm: z.literal(CONFIRM_STRIPE_CHECKOUT_SESSION_CREATE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { sessionId: "" });
		if (denied) return denied;

		const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
			apiVersion: "2024-09-30.acacia",
		});

		const items = getStripeItems(params.serverQuantity, params.isAnnual);
		const user = await findUserById(ctx.userId);

		let stripeCustomerId = user.stripeCustomerId;
		if (stripeCustomerId) {
			const customer = await stripe.customers.retrieve(stripeCustomerId);
			if (customer.deleted) {
				await updateUser(user.id, { stripeCustomerId: null });
				stripeCustomerId = null;
			}
		}

		const session = await stripe.checkout.sessions.create({
			mode: "subscription",
			line_items: items,
			...(stripeCustomerId && {
				customer: stripeCustomerId,
			}),
			metadata: {
				adminId: user.id,
			},
			allow_promotion_codes: true,
			success_url: `${WEBSITE_URL}/dashboard/settings/servers?success=true`,
			cancel_url: `${WEBSITE_URL}/dashboard/settings/billing`,
		});

		return {
			success: true,
			message: "Checkout session created",
			data: { sessionId: session.id },
		};
	},
};

const stripeCreateCustomerPortalSession: Tool<
	{ confirm: typeof CONFIRM_STRIPE_PORTAL_SESSION_CREATE },
	{ url: string }
> = {
	name: "stripe_portal_session_create",
	description:
		"Create a Stripe Customer Portal session. Requires approval + confirm.",
	category: "stripe",
	parameters: z.object({
		confirm: z.literal(CONFIRM_STRIPE_PORTAL_SESSION_CREATE),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, { url: "" });
		if (denied) return denied;

		const user = await findUserById(ctx.userId);
		if (!user.stripeCustomerId) {
			return {
				success: false,
				message: "Stripe Customer ID not found",
				error: "BAD_REQUEST",
				data: { url: "" },
			};
		}

		const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
			apiVersion: "2024-09-30.acacia",
		});

		try {
			const session = await stripe.billingPortal.sessions.create({
				customer: user.stripeCustomerId,
				return_url: `${WEBSITE_URL}/dashboard/settings/billing`,
			});

			return {
				success: true,
				message: "Portal session created",
				data: { url: session.url },
			};
		} catch {
			return {
				success: true,
				message: "Portal session created",
				data: { url: "" },
			};
		}
	},
};

const stripeCanCreateMoreServers: Tool<Record<string, never>, boolean> = {
	name: "stripe_can_create_more_servers",
	description:
		"Check whether the owner can create more servers based on subscription/server limit.",
	category: "stripe",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		const org = await findOrganizationById(ctx.organizationId);
		const ownerId = org?.ownerId;
		if (!ownerId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Organization owner not found",
			});
		}
		const user = await findUserById(ownerId);
		const servers = await findServersByUserId(ownerId);

		if (!IS_CLOUD) {
			return { success: true, message: "OK", data: true };
		}

		return {
			success: true,
			message: "OK",
			data: servers.length < user.serversQuantity,
		};
	},
};

export function registerStripeTools() {
	toolRegistry.register(stripeGetProducts);
	toolRegistry.register(stripeCreateCheckoutSession);
	toolRegistry.register(stripeCreateCustomerPortalSession);
	toolRegistry.register(stripeCanCreateMoreServers);
}

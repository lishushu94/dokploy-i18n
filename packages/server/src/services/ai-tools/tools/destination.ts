import { db } from "@dokploy/server/db";
import { destinations as destinationsTable } from "@dokploy/server/db/schema";
import {
	createDestintation,
	findDestinationById,
	removeDestinationById,
	updateDestinationById,
} from "@dokploy/server/services/destination";
import { findMemberById } from "@dokploy/server/services/user";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type DestinationMasked = {
	destinationId: string;
	name: string;
	provider: string | null;
	accessKey: string;
	bucket: string;
	region: string;
	endpoint: string;
	createdAt: string;
	secretAccessKeyMasked: true;
	secretAccessKeyPresent: boolean;
};

const toIsoString = (v: unknown): string => {
	if (v instanceof Date) return v.toISOString();
	return String(v ?? "");
};

const toMaskedDestination = (d: {
	destinationId: string;
	name: string;
	provider: string | null;
	accessKey: string;
	bucket: string;
	region: string;
	endpoint: string;
	createdAt: unknown;
	secretAccessKey: string;
}): DestinationMasked => {
	return {
		destinationId: d.destinationId,
		name: d.name,
		provider: d.provider ?? null,
		accessKey: d.accessKey,
		bucket: d.bucket,
		region: d.region,
		endpoint: d.endpoint,
		createdAt: toIsoString(d.createdAt),
		secretAccessKeyMasked: true,
		secretAccessKeyPresent: Boolean(d.secretAccessKey),
	};
};

const requireOrgAdmin = async <T>(
	ctx: ToolContext,
	data: T,
): Promise<ToolResult<T> | null> => {
	const member = await findMemberById(ctx.userId, ctx.organizationId);
	if (member.role !== "owner" && member.role !== "admin") {
		return {
			success: false,
			message: "Only organization owner/admin can manage destinations",
			error: "UNAUTHORIZED",
			data,
		};
	}
	return null;
};

const destinationList: Tool<Record<string, never>, DestinationMasked[]> = {
	name: "destination_list",
	description:
		"List S3 destinations for the current organization. secretAccessKey is never returned.",
	category: "backup",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const items = await db.query.destinations.findMany({
			where: eq(destinationsTable.organizationId, ctx.organizationId),
			orderBy: [desc(destinationsTable.createdAt)],
		});

		return {
			success: true,
			message: `Found ${items.length} destination(s)`,
			data: items.map((d) =>
				toMaskedDestination({
					destinationId: d.destinationId,
					name: d.name,
					provider: d.provider ?? null,
					accessKey: d.accessKey,
					bucket: d.bucket,
					region: d.region,
					endpoint: d.endpoint,
					createdAt: d.createdAt,
					secretAccessKey: d.secretAccessKey,
				}),
			),
		};
	},
};

const destinationGet: Tool<{ destinationId: string }, DestinationMasked> = {
	name: "destination_get",
	description:
		"Get a single S3 destination by ID for the current organization. secretAccessKey is never returned.",
	category: "backup",
	parameters: z.object({
		destinationId: z.string().min(1),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const destination = await findDestinationById(params.destinationId);
		if (destination.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Destination access denied",
				error: "UNAUTHORIZED",
				data: {
					destinationId: params.destinationId,
					name: "",
					provider: null,
					accessKey: "",
					bucket: "",
					region: "",
					endpoint: "",
					createdAt: "",
					secretAccessKeyMasked: true,
					secretAccessKeyPresent: false,
				},
			};
		}

		return {
			success: true,
			message: "Destination retrieved",
			data: toMaskedDestination({
				destinationId: destination.destinationId,
				name: destination.name,
				provider: destination.provider ?? null,
				accessKey: destination.accessKey,
				bucket: destination.bucket,
				region: destination.region,
				endpoint: destination.endpoint,
				createdAt: destination.createdAt,
				secretAccessKey: destination.secretAccessKey,
			}),
		};
	},
};

const destinationCreate: Tool<
	{
		name: string;
		provider: string;
		accessKey: string;
		secretAccessKey: string;
		bucket: string;
		region: string;
		endpoint: string;
		confirm: "CONFIRM_DESTINATION_CHANGE";
	},
	{ destinationId: string }
> = {
	name: "destination_create",
	description:
		"Create an S3 destination for backups. Requires approval + confirm. secretAccessKey is never returned.",
	category: "backup",
	parameters: z.object({
		name: z.string().min(1),
		provider: z.string(),
		accessKey: z.string().min(1),
		secretAccessKey: z.string().min(1),
		bucket: z.string().min(1),
		region: z.string().min(1),
		endpoint: z.string().min(1),
		confirm: z.literal("CONFIRM_DESTINATION_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgAdmin(ctx, { destinationId: "" });
		if (denied) return denied;

		const created = await createDestintation(
			{
				name: params.name,
				provider: params.provider,
				accessKey: params.accessKey,
				secretAccessKey: params.secretAccessKey,
				bucket: params.bucket,
				region: params.region,
				endpoint: params.endpoint,
			},
			ctx.organizationId,
		);

		return {
			success: true,
			message: "Destination created",
			data: { destinationId: created.destinationId },
		};
	},
};

const destinationUpdate: Tool<
	{
		destinationId: string;
		name?: string;
		provider?: string;
		accessKey?: string;
		secretAccessKey?: string;
		bucket?: string;
		region?: string;
		endpoint?: string;
		confirm: "CONFIRM_DESTINATION_CHANGE";
	},
	{ updated: boolean }
> = {
	name: "destination_update",
	description:
		"Update an existing S3 destination. Requires approval + confirm. secretAccessKey is never returned.",
	category: "backup",
	parameters: z
		.object({
			destinationId: z.string().min(1),
			name: z.string().min(1).optional(),
			provider: z.string().optional(),
			accessKey: z.string().min(1).optional(),
			secretAccessKey: z.string().min(1).optional(),
			bucket: z.string().min(1).optional(),
			region: z.string().min(1).optional(),
			endpoint: z.string().min(1).optional(),
			confirm: z.literal("CONFIRM_DESTINATION_CHANGE"),
		})
		.superRefine((v, ctx2) => {
			const hasAny =
				v.name !== undefined ||
				v.provider !== undefined ||
				v.accessKey !== undefined ||
				v.secretAccessKey !== undefined ||
				v.bucket !== undefined ||
				v.region !== undefined ||
				v.endpoint !== undefined;
			if (!hasAny) {
				ctx2.addIssue({
					code: "custom",
					message: "At least one field must be provided to update",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgAdmin(ctx, { updated: false });
		if (denied) return denied;

		const current = await findDestinationById(params.destinationId);
		if (current.organizationId !== ctx.organizationId) {
			return { success: false, message: "Destination access denied" };
		}

		const updated = await updateDestinationById(params.destinationId, {
			organizationId: ctx.organizationId,
			name: params.name,
			provider: params.provider,
			accessKey: params.accessKey,
			secretAccessKey: params.secretAccessKey,
			bucket: params.bucket,
			region: params.region,
			endpoint: params.endpoint,
		});

		return {
			success: true,
			message: "Destination updated",
			data: { updated: Boolean(updated) },
		};
	},
};

const destinationDelete: Tool<
	{ destinationId: string; confirm: "CONFIRM_DESTINATION_CHANGE" },
	{ deleted: boolean }
> = {
	name: "destination_delete",
	description:
		"Delete an S3 destination. Requires approval + confirm. secretAccessKey is never returned.",
	category: "backup",
	parameters: z.object({
		destinationId: z.string().min(1),
		confirm: z.literal("CONFIRM_DESTINATION_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgAdmin(ctx, { deleted: false });
		if (denied) return denied;

		const current = await findDestinationById(params.destinationId);
		if (current.organizationId !== ctx.organizationId) {
			return { success: false, message: "Destination access denied" };
		}

		const deleted = await removeDestinationById(
			params.destinationId,
			ctx.organizationId,
		);

		return {
			success: true,
			message: "Destination deleted",
			data: { deleted: Boolean(deleted) },
		};
	},
};

export function registerDestinationTools() {
	toolRegistry.register(destinationList);
	toolRegistry.register(destinationGet);
	toolRegistry.register(destinationCreate);
	toolRegistry.register(destinationUpdate);
	toolRegistry.register(destinationDelete);
}

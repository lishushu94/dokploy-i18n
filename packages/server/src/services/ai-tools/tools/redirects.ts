import {
	apiCreateRedirect,
	apiFindOneRedirect,
	apiUpdateRedirect,
} from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import {
	createRedirect,
	findRedirectById,
	removeRedirectById,
	updateRedirectById,
} from "@dokploy/server/services/redirect";
import { findMemberById } from "@dokploy/server/services/user";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type RedirectSummary = {
	redirectId: string;
	applicationId: string;
	regex: string;
	replacement: string;
	permanent: boolean;
	createdAt: string;
};

const toIsoString = (v: unknown): string => {
	if (v instanceof Date) return v.toISOString();
	return String(v ?? "");
};

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const accessDenied = <T>(message: string, data: T): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const toSummary = (r: {
	redirectId: string;
	applicationId: string;
	regex: string;
	replacement: string;
	permanent: boolean;
	createdAt: unknown;
}): RedirectSummary => ({
	redirectId: r.redirectId,
	applicationId: r.applicationId,
	regex: r.regex,
	replacement: r.replacement,
	permanent: Boolean(r.permanent),
	createdAt: toIsoString(r.createdAt),
});

const domainListRedirects: Tool<{ applicationId: string }, RedirectSummary[]> =
	{
		name: "domain_list_redirects",
		description: "List redirects for an application.",
		category: "domain",
		parameters: z.object({
			applicationId: z.string().min(1).describe("Application ID"),
		}),
		riskLevel: "low",
		requiresApproval: false,
		execute: async (params, ctx) => {
			await requireOrgMember(ctx);
			const app = await findApplicationById(params.applicationId);
			if (app.environment.project.organizationId !== ctx.organizationId) {
				return accessDenied("Application access denied", []);
			}

			return {
				success: true,
				message: `Found ${app.redirects.length} redirect(s)`,
				data: app.redirects.map((r) =>
					toSummary({
						redirectId: r.redirectId,
						applicationId: r.applicationId,
						regex: r.regex,
						replacement: r.replacement,
						permanent: r.permanent,
						createdAt: r.createdAt,
					}),
				),
			};
		},
	};

const domainGetRedirect: Tool<{ redirectId: string }, RedirectSummary> = {
	name: "domain_get_redirect",
	description: "Get a redirect by ID.",
	category: "domain",
	parameters: apiFindOneRedirect,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const redirect = await findRedirectById(params.redirectId);
		const app = await findApplicationById(redirect.applicationId);
		if (app.environment.project.organizationId !== ctx.organizationId) {
			return accessDenied("Application access denied", {
				redirectId: params.redirectId,
				applicationId: "",
				regex: "",
				replacement: "",
				permanent: false,
				createdAt: "",
			});
		}

		return {
			success: true,
			message: "Redirect retrieved",
			data: toSummary({
				redirectId: redirect.redirectId,
				applicationId: redirect.applicationId,
				regex: redirect.regex,
				replacement: redirect.replacement,
				permanent: redirect.permanent,
				createdAt: redirect.createdAt,
			}),
		};
	},
};

const domainCreateRedirect: Tool<
	z.infer<typeof apiCreateRedirect> & { confirm: "CONFIRM_REDIRECT_CHANGE" },
	{ created: boolean }
> = {
	name: "domain_create_redirect",
	description:
		"Create a redirect for an application (requires approval + confirm).",
	category: "domain",
	parameters: apiCreateRedirect.extend({
		confirm: z.literal("CONFIRM_REDIRECT_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const app = await findApplicationById(params.applicationId);
		if (app.environment.project.organizationId !== ctx.organizationId) {
			return accessDenied("Application access denied", { created: false });
		}

		const ok = await createRedirect({
			applicationId: params.applicationId,
			regex: params.regex,
			replacement: params.replacement,
			permanent: params.permanent,
		});

		return {
			success: true,
			message: ok
				? "Redirect created"
				: "Redirect creation requested (no details returned)",
			data: { created: Boolean(ok) },
		};
	},
};

const domainUpdateRedirect: Tool<
	z.infer<typeof apiUpdateRedirect> & { confirm: "CONFIRM_REDIRECT_CHANGE" },
	RedirectSummary
> = {
	name: "domain_update_redirect",
	description: "Update a redirect (requires approval + confirm).",
	category: "domain",
	parameters: apiUpdateRedirect.extend({
		confirm: z.literal("CONFIRM_REDIRECT_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const current = await findRedirectById(params.redirectId);
		const app = await findApplicationById(current.applicationId);
		if (app.environment.project.organizationId !== ctx.organizationId) {
			return accessDenied("Application access denied", {
				redirectId: params.redirectId,
				applicationId: "",
				regex: "",
				replacement: "",
				permanent: false,
				createdAt: "",
			});
		}

		const updated = await updateRedirectById(params.redirectId, {
			regex: params.regex,
			replacement: params.replacement,
			permanent: params.permanent,
		});

		return {
			success: true,
			message: "Redirect updated",
			data: toSummary({
				redirectId: updated.redirectId,
				applicationId: updated.applicationId,
				regex: updated.regex,
				replacement: updated.replacement,
				permanent: updated.permanent,
				createdAt: updated.createdAt,
			}),
		};
	},
};

const domainDeleteRedirect: Tool<
	{ redirectId: string; confirm: "CONFIRM_REDIRECT_DELETE" },
	{ deleted: boolean; redirectId: string }
> = {
	name: "domain_delete_redirect",
	description: "Delete a redirect (requires approval + confirm).",
	category: "domain",
	parameters: z.object({
		redirectId: z.string().min(1),
		confirm: z.literal("CONFIRM_REDIRECT_DELETE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const current = await findRedirectById(params.redirectId);
		const app = await findApplicationById(current.applicationId);
		if (app.environment.project.organizationId !== ctx.organizationId) {
			return accessDenied("Application access denied", {
				deleted: false,
				redirectId: params.redirectId,
			});
		}

		await removeRedirectById(params.redirectId);
		return {
			success: true,
			message: "Redirect deleted",
			data: { deleted: true, redirectId: params.redirectId },
		};
	},
};

export function registerRedirectTools() {
	toolRegistry.register(domainListRedirects);
	toolRegistry.register(domainGetRedirect);
	toolRegistry.register(domainCreateRedirect);
	toolRegistry.register(domainUpdateRedirect);
	toolRegistry.register(domainDeleteRedirect);
}

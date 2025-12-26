import {
	apiCreateSecurity,
	apiFindOneSecurity,
	apiUpdateSecurity,
} from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import {
	createSecurity,
	deleteSecurityById,
	findSecurityById,
	updateSecurityById,
} from "@dokploy/server/services/security";
import { findMemberById } from "@dokploy/server/services/user";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

const CONFIRM_SECURITY_CHANGE = "CONFIRM_SECURITY_CHANGE" as const;
const CONFIRM_SECURITY_DELETE = "CONFIRM_SECURITY_DELETE" as const;
const CONFIRM_SECURITY_REVEAL = "CONFIRM_SECURITY_REVEAL" as const;

type SecurityMasked = {
	securityId: string;
	applicationId: string;
	username: string;
	createdAt: string;
	passwordMasked: true;
	passwordPresent: boolean;
};

type SecurityRevealed = {
	securityId: string;
	applicationId: string;
	username: string;
	createdAt: string;
	password: string;
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

const ensureSecurityAccess = async <T>(
	ctx: ToolContext,
	security: Awaited<ReturnType<typeof findSecurityById>>,
	data: T,
): Promise<ToolResult<T> | null> => {
	const app = await findApplicationById(security.applicationId);
	if (app.environment.project.organizationId !== ctx.organizationId) {
		return accessDenied("Security access denied", data);
	}
	return null;
};

const toMasked = (
	s: Awaited<ReturnType<typeof findSecurityById>>,
): SecurityMasked => ({
	securityId: s.securityId,
	applicationId: s.applicationId,
	username: s.username,
	createdAt: s.createdAt,
	passwordMasked: true,
	passwordPresent: Boolean(s.password),
});

const securityGet: Tool<z.infer<typeof apiFindOneSecurity>, SecurityMasked> = {
	name: "security_get",
	description:
		"Get a security record by ID (masked). Use security_reveal_password to show the password.",
	category: "server",
	parameters: apiFindOneSecurity,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const s = await findSecurityById(params.securityId);
		const masked = toMasked(s);
		const denied = await ensureSecurityAccess(ctx, s, masked);
		if (denied) return denied;
		return {
			success: true,
			message: "Security retrieved (masked)",
			data: masked,
		};
	},
};

const securityRevealPassword: Tool<
	z.infer<typeof apiFindOneSecurity> & {
		confirm: typeof CONFIRM_SECURITY_REVEAL;
	},
	SecurityRevealed
> = {
	name: "security_reveal_password",
	description:
		"Reveal the plaintext password for a security record (requires approval + confirm).",
	category: "server",
	parameters: apiFindOneSecurity.extend({
		confirm: z.literal(CONFIRM_SECURITY_REVEAL),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const s = await findSecurityById(params.securityId);
		const denied = await ensureSecurityAccess(ctx, s, {
			securityId: params.securityId,
			applicationId: "",
			username: "",
			createdAt: "",
			password: "",
		});
		if (denied) {
			return {
				success: false,
				message: denied.message,
				error: denied.error,
				data: denied.data,
			};
		}
		const { confirm: _confirm } = params;
		return {
			success: true,
			message: "Security password revealed",
			data: {
				securityId: s.securityId,
				applicationId: s.applicationId,
				username: s.username,
				createdAt: s.createdAt,
				password: s.password,
			},
		};
	},
};

const securityCreate: Tool<
	z.infer<typeof apiCreateSecurity> & {
		confirm: typeof CONFIRM_SECURITY_CHANGE;
	},
	{ created: boolean }
> = {
	name: "security_create",
	description: "Create a security record (requires approval + confirm).",
	category: "server",
	parameters: apiCreateSecurity.extend({
		confirm: z.literal(CONFIRM_SECURITY_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const app = await findApplicationById(params.applicationId);
		if (app.environment.project.organizationId !== ctx.organizationId) {
			return accessDenied("Application access denied", { created: false });
		}
		const { confirm: _confirm, ...input } = params;
		await createSecurity(input);
		return {
			success: true,
			message: "Security created",
			data: { created: true },
		};
	},
};

const securityUpdate: Tool<
	z.infer<typeof apiUpdateSecurity> & {
		confirm: typeof CONFIRM_SECURITY_CHANGE;
	},
	{ updated: boolean }
> = {
	name: "security_update",
	description: "Update a security record (requires approval + confirm).",
	category: "server",
	parameters: apiUpdateSecurity.extend({
		confirm: z.literal(CONFIRM_SECURITY_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const current = await findSecurityById(params.securityId);
		const denied = await ensureSecurityAccess(ctx, current, { updated: false });
		if (denied) {
			return {
				success: false,
				message: denied.message,
				error: denied.error,
				data: { updated: false },
			};
		}
		const { confirm: _confirm, securityId, ...rest } = params;
		await updateSecurityById(securityId, rest);
		return {
			success: true,
			message: "Security updated",
			data: { updated: true },
		};
	},
};

const securityDelete: Tool<
	z.infer<typeof apiFindOneSecurity> & {
		confirm: typeof CONFIRM_SECURITY_DELETE;
	},
	{ deleted: boolean; securityId: string }
> = {
	name: "security_delete",
	description: "Delete a security record (requires approval + confirm).",
	category: "server",
	parameters: apiFindOneSecurity.extend({
		confirm: z.literal(CONFIRM_SECURITY_DELETE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const current = await findSecurityById(params.securityId);
		const denied = await ensureSecurityAccess(ctx, current, {
			deleted: false,
			securityId: params.securityId,
		});
		if (denied) return denied;
		const { confirm: _confirm } = params;
		await deleteSecurityById(params.securityId);
		return {
			success: true,
			message: "Security deleted",
			data: { deleted: true, securityId: params.securityId },
		};
	},
};

export function registerSecurityTools() {
	toolRegistry.register(securityGet);
	toolRegistry.register(securityRevealPassword);
	toolRegistry.register(securityCreate);
	toolRegistry.register(securityUpdate);
	toolRegistry.register(securityDelete);
}

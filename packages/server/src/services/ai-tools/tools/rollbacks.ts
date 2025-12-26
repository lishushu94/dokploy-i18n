import { apiFindOneRollback } from "@dokploy/server/db/schema";
import { findRollbackById, removeRollbackById, rollback } from "@dokploy/server/services/rollbacks";
import { findMemberById } from "@dokploy/server/services/user";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

const CONFIRM_ROLLBACK = "CONFIRM_ROLLBACK" as const;
const CONFIRM_ROLLBACK_DELETE = "CONFIRM_ROLLBACK_DELETE" as const;

type RollbackSummary = {
	rollbackId: string;
	deploymentId: string;
	version: number | null;
	image: string | null;
	createdAt: string;
	applicationId: string | null;
	projectId: string | null;
};

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const toSummary = (
	r: Awaited<ReturnType<typeof findRollbackById>>,
): RollbackSummary => ({
	rollbackId: r.rollbackId,
	deploymentId: r.deploymentId,
	version: typeof r.version === "number" ? r.version : null,
	image: r.image ?? null,
	createdAt: r.createdAt,
	applicationId: r.deployment?.applicationId ?? null,
	projectId: r.deployment?.application?.environment?.project?.projectId ?? null,
});

const ensureRollbackAccess = (
	r: Awaited<ReturnType<typeof findRollbackById>>,
	ctx: ToolContext,
	data: RollbackSummary,
): ToolResult<RollbackSummary> | null => {
	const orgId = r.deployment?.application?.environment?.project?.organizationId;
	if (orgId !== ctx.organizationId) {
		return {
			success: false,
			message: "Rollback access denied",
			error: "UNAUTHORIZED",
			data,
		};
	}
	return null;
};

const rollbackGet: Tool<z.infer<typeof apiFindOneRollback>, RollbackSummary> = {
	name: "rollback_get",
	description: "Get a rollback by ID (summary only).",
	category: "deployment",
	parameters: apiFindOneRollback,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const r = await findRollbackById(params.rollbackId);
		const summary = toSummary(r);
		const denied = ensureRollbackAccess(r, ctx, summary);
		if (denied) return denied;
		return {
			success: true,
			message: "Rollback retrieved",
			data: summary,
		};
	},
};

const rollbackExecute: Tool<
	z.infer<typeof apiFindOneRollback> & { confirm: typeof CONFIRM_ROLLBACK },
	{ rolledBack: boolean }
> = {
	name: "rollback_execute",
	description: "Execute a rollback (requires approval + confirm).",
	category: "deployment",
	parameters: apiFindOneRollback.extend({
		confirm: z.literal(CONFIRM_ROLLBACK),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const r = await findRollbackById(params.rollbackId);
		const summary = toSummary(r);
		const denied = ensureRollbackAccess(r, ctx, summary);
		if (denied) {
			return {
				success: false,
				message: denied.message,
				error: denied.error,
				data: { rolledBack: false },
			};
		}
		const { confirm: _confirm, rollbackId } = params;
		await rollback(rollbackId);
		return {
			success: true,
			message: "Rollback executed",
			data: { rolledBack: true },
		};
	},
};

const rollbackDelete: Tool<
	z.infer<typeof apiFindOneRollback> & { confirm: typeof CONFIRM_ROLLBACK_DELETE },
	{ deleted: boolean; rollbackId: string }
> = {
	name: "rollback_delete",
	description: "Delete a rollback (requires approval + confirm).",
	category: "deployment",
	parameters: apiFindOneRollback.extend({
		confirm: z.literal(CONFIRM_ROLLBACK_DELETE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const r = await findRollbackById(params.rollbackId);
		const summary = toSummary(r);
		const denied = ensureRollbackAccess(r, ctx, summary);
		if (denied) {
			return {
				success: false,
				message: denied.message,
				error: denied.error,
				data: { deleted: false, rollbackId: params.rollbackId },
			};
		}
		const { confirm: _confirm, rollbackId } = params;
		await removeRollbackById(rollbackId);
		return {
			success: true,
			message: "Rollback deleted",
			data: { deleted: true, rollbackId },
		};
	},
};

export function registerRollbackTools() {
	toolRegistry.register(rollbackGet);
	toolRegistry.register(rollbackExecute);
	toolRegistry.register(rollbackDelete);
}

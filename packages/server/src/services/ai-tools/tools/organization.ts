import { db } from "@dokploy/server/db";
import { organization as organizationTable } from "@dokploy/server/db/schema";
import { findMemberById } from "@dokploy/server/services/user";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

type OrgAiPolicies = {
	bindMountAllowPrefixes?: string[];
};

type OrgMetadata = {
	aiPolicies?: OrgAiPolicies;
	[key: string]: unknown;
};

const parseMetadata = (metadata: string | null): OrgMetadata => {
	if (!metadata) return {};
	try {
		const parsed = JSON.parse(metadata) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed as OrgMetadata;
	} catch {
		return {};
	}
};

const normalizePrefixes = (prefixes: string[]): string[] => {
	const uniq = new Set<string>();
	for (const p of prefixes) {
		const v = String(p ?? "").trim();
		if (!v) continue;
		uniq.add(v);
	}
	return Array.from(uniq);
};

const getOrgBindMountAllowlist: Tool<{}, { prefixes: string[] }> = {
	name: "org_bind_mount_allowlist_get",
	description:
		"Get organization-level bind mount allowlist (host path prefixes) used by AI mount tools",
	category: "server",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const org = await db.query.organization.findFirst({
			where: eq(organizationTable.id, ctx.organizationId),
		});
		const meta = parseMetadata(org?.metadata ?? null);
		const prefixes = normalizePrefixes(
			meta.aiPolicies?.bindMountAllowPrefixes ?? [],
		);
		return {
			success: true,
			message: "Bind mount allowlist",
			data: { prefixes },
		};
	},
};

const updateOrgBindMountAllowlist: Tool<
	{
		setPrefixes?: string[];
		addPrefixes?: string[];
		removePrefixes?: string[];
		confirm: "CONFIRM_BIND_MOUNT_ALLOWLIST_UPDATE";
	},
	{ prefixes: string[] }
> = {
	name: "org_bind_mount_allowlist_update",
	description:
		"Update organization-level bind mount allowlist (host path prefixes). Requires approval and confirm token.",
	category: "server",
	parameters: z.object({
		setPrefixes: z.array(z.string()).optional(),
		addPrefixes: z.array(z.string()).optional(),
		removePrefixes: z.array(z.string()).optional(),
		confirm: z.literal("CONFIRM_BIND_MOUNT_ALLOWLIST_UPDATE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const member = await findMemberById(ctx.userId, ctx.organizationId);
		if (member.role !== "owner" && member.role !== "admin") {
			return {
				success: false,
				message:
					"Only organization owner/admin can update bind mount allowlist",
			};
		}

		const org = await db.query.organization.findFirst({
			where: eq(organizationTable.id, ctx.organizationId),
		});
		const meta = parseMetadata(org?.metadata ?? null);
		const current = normalizePrefixes(
			meta.aiPolicies?.bindMountAllowPrefixes ?? [],
		);

		let next = params.setPrefixes
			? normalizePrefixes(params.setPrefixes)
			: [...current];
		if (params.addPrefixes?.length) {
			next = normalizePrefixes([...next, ...params.addPrefixes]);
		}
		if (params.removePrefixes?.length) {
			const remove = new Set(normalizePrefixes(params.removePrefixes));
			next = next.filter((p) => !remove.has(p));
		}

		const nextMeta: OrgMetadata = {
			...meta,
			aiPolicies: {
				...(meta.aiPolicies ?? {}),
				bindMountAllowPrefixes: next,
			},
		};

		await db
			.update(organizationTable)
			.set({ metadata: JSON.stringify(nextMeta) })
			.where(eq(organizationTable.id, ctx.organizationId));

		return {
			success: true,
			message: "Bind mount allowlist updated",
			data: { prefixes: next },
		};
	},
};

export function registerOrganizationTools() {
	toolRegistry.register(getOrgBindMountAllowlist);
	toolRegistry.register(updateOrgBindMountAllowlist);
}

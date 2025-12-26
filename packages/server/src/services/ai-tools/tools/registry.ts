import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	apiCreateRegistry,
	apiFindOneRegistry,
	apiRemoveRegistry,
	apiTestRegistry,
	apiUpdateRegistry,
	registry as registryTable,
} from "@dokploy/server/db/schema";
import {
	createRegistry,
	findRegistryById,
	removeRegistry,
	updateRegistry,
} from "@dokploy/server/services/registry";
import { findServerById } from "@dokploy/server/services/server";
import { findMemberById } from "@dokploy/server/services/user";
import {
	execAsyncRemote,
	execFileAsync,
} from "@dokploy/server/utils/process/execAsync";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type RegistrySummary = {
	registryId: string;
	registryName: string;
	registryUrl: string;
	registryType: string;
	imagePrefix: string | null;
	username: string;
	createdAt: string;
	organizationId: string;
	passwordMasked: true;
	passwordPresent: boolean;
};

const CONFIRM_REGISTRY_CHANGE = "CONFIRM_REGISTRY_CHANGE" as const;
const CONFIRM_REGISTRY_REMOVE = "CONFIRM_REGISTRY_REMOVE" as const;
const CONFIRM_REGISTRY_TEST = "CONFIRM_REGISTRY_TEST" as const;

function shEscape(s: string | undefined): string {
	if (!s) return "''";
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function safeDockerLoginCommand(input: {
	registryUrl?: string;
	username?: string;
	password?: string;
}): string {
	const escapedRegistry = shEscape(input.registryUrl);
	const escapedUser = shEscape(input.username);
	const escapedPassword = shEscape(input.password);
	return `printf %s ${escapedPassword} | docker login ${escapedRegistry} -u ${escapedUser} --password-stdin`;
}

const toRegistrySummary = (r: {
	registryId: string;
	registryName: string;
	registryUrl: string;
	registryType: string;
	imagePrefix: string | null;
	username: string;
	createdAt: string;
	organizationId: string;
	password?: string | null;
}): RegistrySummary => ({
	registryId: r.registryId,
	registryName: r.registryName,
	registryUrl: r.registryUrl,
	registryType: r.registryType,
	imagePrefix: r.imagePrefix ?? null,
	username: r.username,
	createdAt: r.createdAt,
	organizationId: r.organizationId,
	passwordMasked: true,
	passwordPresent: Boolean(r.password),
});

const accessDenied = <T>(message: string, data: T): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const requireOrgOwner = async <T>(
	ctx: ToolContext,
	data: T,
): Promise<ToolResult<T> | null> => {
	const member = await findMemberById(ctx.userId, ctx.organizationId);
	if (member.role !== "owner") {
		return {
			success: false,
			message: "Only organization owner can manage registries",
			error: "UNAUTHORIZED",
			data,
		};
	}
	return null;
};

const ensureServerAccess = async (
	ctx: ToolContext,
	serverId: string,
): Promise<void> => {
	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.organizationId) {
		throw new Error("Server access denied");
	}
};

const registryList: Tool<Record<string, never>, RegistrySummary[]> = {
	name: "registry_list",
	description:
		"List registries for the current organization. Password is never returned.",
	category: "deployment",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		const rows = await db.query.registry.findMany({
			where: eq(registryTable.organizationId, ctx.organizationId),
			columns: {
				password: false,
			},
			orderBy: [desc(registryTable.createdAt)],
		});

		return {
			success: true,
			message: `Found ${rows.length} registries`,
			data: rows.map((r) =>
				toRegistrySummary({
					registryId: r.registryId,
					registryName: r.registryName,
					registryUrl: r.registryUrl,
					registryType: r.registryType,
					imagePrefix: r.imagePrefix ?? null,
					username: r.username,
					createdAt: r.createdAt,
					organizationId: r.organizationId,
					password: null,
				}),
			),
		};
	},
};

const registryGet: Tool<{ registryId: string }, RegistrySummary> = {
	name: "registry_get",
	description: "Get a registry by ID (owner-only). Password is never returned.",
	category: "deployment",
	parameters: apiFindOneRegistry,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, {
			registryId: params.registryId,
			registryName: "",
			registryUrl: "",
			registryType: "",
			imagePrefix: null,
			username: "",
			createdAt: "",
			organizationId: "",
			passwordMasked: true as const,
			passwordPresent: false,
		});
		if (denied) return denied;

		const r = await findRegistryById(params.registryId);
		if (r.organizationId !== ctx.organizationId) {
			return accessDenied("Registry access denied", {
				registryId: params.registryId,
				registryName: "",
				registryUrl: "",
				registryType: "",
				imagePrefix: null,
				username: "",
				createdAt: "",
				organizationId: "",
				passwordMasked: true as const,
				passwordPresent: false,
			});
		}

		return {
			success: true,
			message: "Registry retrieved",
			data: toRegistrySummary({
				registryId: r.registryId,
				registryName: r.registryName,
				registryUrl: r.registryUrl,
				registryType: r.registryType,
				imagePrefix: r.imagePrefix ?? null,
				username: r.username,
				createdAt: r.createdAt,
				organizationId: r.organizationId,
				password: null,
			}),
		};
	},
};

const registryCreate: Tool<
	z.infer<typeof apiCreateRegistry> & {
		confirm: typeof CONFIRM_REGISTRY_CHANGE;
	},
	RegistrySummary
> = {
	name: "registry_create",
	description:
		"Create a new registry for the current organization (owner-only). Requires approval + confirm.",
	category: "deployment",
	parameters: apiCreateRegistry.extend({
		confirm: z.literal(CONFIRM_REGISTRY_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(
			ctx,
			toRegistrySummary({
				registryId: "",
				registryName: params.registryName,
				registryUrl: params.registryUrl,
				registryType: params.registryType,
				imagePrefix: params.imagePrefix ?? null,
				username: params.username,
				createdAt: "",
				organizationId: ctx.organizationId,
				password: params.password,
			}),
		);
		if (denied) return denied;

		if (params.serverId && params.serverId !== "none") {
			await ensureServerAccess(ctx, params.serverId);
		}

		const { confirm: _confirm, ...input } = params;
		const created = await createRegistry(input, ctx.organizationId);
		return {
			success: true,
			message: "Registry created",
			data: toRegistrySummary({
				registryId: created.registryId,
				registryName: created.registryName,
				registryUrl: created.registryUrl,
				registryType: created.registryType,
				imagePrefix: created.imagePrefix ?? null,
				username: created.username,
				createdAt: created.createdAt,
				organizationId: created.organizationId,
				password: created.password,
			}),
		};
	},
};

const registryUpdate: Tool<
	z.infer<typeof apiUpdateRegistry> & {
		confirm: typeof CONFIRM_REGISTRY_CHANGE;
	},
	{ updated: boolean }
> = {
	name: "registry_update",
	description:
		"Update a registry for the current organization. Requires approval + confirm. Password is accepted but never returned.",
	category: "deployment",
	parameters: apiUpdateRegistry.extend({
		confirm: z.literal(CONFIRM_REGISTRY_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const current = await findRegistryById(params.registryId);
		if (current.organizationId !== ctx.organizationId) {
			return accessDenied("Registry access denied", { updated: false });
		}
		if (params.serverId && params.serverId !== "none") {
			await ensureServerAccess(ctx, params.serverId);
		}

		const { registryId, confirm: _confirm, ...rest } = params;
		await updateRegistry(registryId, rest);
		return {
			success: true,
			message: "Registry updated",
			data: { updated: true },
		};
	},
};

const registryRemove: Tool<
	z.infer<typeof apiRemoveRegistry> & {
		confirm: typeof CONFIRM_REGISTRY_REMOVE;
	},
	{ deleted: boolean; registryId: string }
> = {
	name: "registry_remove",
	description: "Remove a registry (owner-only). Requires approval + confirm.",
	category: "deployment",
	parameters: apiRemoveRegistry.extend({
		confirm: z.literal(CONFIRM_REGISTRY_REMOVE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, {
			deleted: false,
			registryId: params.registryId,
		});
		if (denied) return denied;

		const current = await findRegistryById(params.registryId);
		if (current.organizationId !== ctx.organizationId) {
			return accessDenied("Registry access denied", {
				deleted: false,
				registryId: params.registryId,
			});
		}

		await removeRegistry(params.registryId);
		return {
			success: true,
			message: "Registry removed",
			data: { deleted: true, registryId: params.registryId },
		};
	},
};

const registryTest: Tool<
	z.infer<typeof apiTestRegistry> & { confirm: typeof CONFIRM_REGISTRY_TEST },
	{ ok: boolean }
> = {
	name: "registry_test",
	description:
		"Test docker registry login (requires approval + confirm). Password is never returned.",
	category: "deployment",
	parameters: apiTestRegistry.extend({
		confirm: z.literal(CONFIRM_REGISTRY_TEST),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);

		if (IS_CLOUD && !params.serverId) {
			return {
				success: false,
				message: "Select a server to test the registry",
				error: "NOT_FOUND",
				data: { ok: false },
			};
		}

		if (params.serverId && params.serverId !== "none") {
			await ensureServerAccess(ctx, params.serverId);
			await execAsyncRemote(
				params.serverId,
				safeDockerLoginCommand({
					registryUrl: params.registryUrl,
					username: params.username,
					password: params.password,
				}),
			);
			return {
				success: true,
				message: "Registry login successful (remote)",
				data: { ok: true },
			};
		}

		await execFileAsync(
			"docker",
			[
				"login",
				params.registryUrl,
				"--username",
				params.username,
				"--password-stdin",
			],
			{ input: Buffer.from(params.password).toString() },
		);
		return {
			success: true,
			message: "Registry login successful",
			data: { ok: true },
		};
	},
};

export function registerRegistryTools() {
	toolRegistry.register(registryList);
	toolRegistry.register(registryGet);
	toolRegistry.register(registryCreate);
	toolRegistry.register(registryUpdate);
	toolRegistry.register(registryRemove);
	toolRegistry.register(registryTest);
}

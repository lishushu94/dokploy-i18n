import { db } from "@dokploy/server/db";
import {
	apiCreateSshKey,
	apiFindOneSshKey,
	apiGenerateSSHKey,
	apiRemoveSshKey,
	apiUpdateSshKey,
	sshKeys,
} from "@dokploy/server/db/schema";
import {
	createSshKey,
	findSSHKeyById,
	removeSSHKeyById,
	updateSSHKeyById,
} from "@dokploy/server/services/ssh-key";
import { findMemberById } from "@dokploy/server/services/user";
import { generateSSHKey } from "@dokploy/server/utils/filesystem/ssh";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type SshKeySummary = {
	sshKeyId: string;
	name: string;
	description: string | null;
	publicKey: string;
	createdAt: string;
	lastUsedAt: string | null;
	organizationId: string;
	privateKeyMasked: true;
	privateKeyPresent: boolean;
};

type GeneratedSshKey = {
	type: "rsa" | "ed25519";
	privateKey: string;
	publicKey: string;
};

const CONFIRM_SSH_KEY_CHANGE = "CONFIRM_SSH_KEY_CHANGE" as const;
const CONFIRM_SSH_KEY_REMOVE = "CONFIRM_SSH_KEY_REMOVE" as const;
const CONFIRM_SSH_KEY_GENERATE = "CONFIRM_SSH_KEY_GENERATE" as const;

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const accessDenied = <T>(message: string, data: T): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const toSummary = (k: {
	sshKeyId: string;
	name: string;
	description: string | null;
	publicKey: string;
	createdAt: string;
	lastUsedAt: string | null;
	organizationId: string;
	privateKey?: string | null;
}): SshKeySummary => ({
	sshKeyId: k.sshKeyId,
	name: k.name,
	description: k.description ?? null,
	publicKey: k.publicKey,
	createdAt: k.createdAt,
	lastUsedAt: k.lastUsedAt ?? null,
	organizationId: k.organizationId,
	privateKeyMasked: true,
	privateKeyPresent: Boolean(k.privateKey),
});

const sshKeyList: Tool<Record<string, never>, SshKeySummary[]> = {
	name: "server_ssh_key_list",
	description:
		"List SSH keys for the current organization. Private keys are never returned.",
	category: "server",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);

		const rows = await db.query.sshKeys.findMany({
			where: eq(sshKeys.organizationId, ctx.organizationId),
			orderBy: [desc(sshKeys.createdAt)],
		});

		return {
			success: true,
			message: `Found ${rows.length} SSH key(s)`,
			data: rows.map((k) =>
				toSummary({
					sshKeyId: k.sshKeyId,
					name: k.name,
					description: k.description ?? null,
					publicKey: k.publicKey,
					createdAt: k.createdAt,
					lastUsedAt: k.lastUsedAt ?? null,
					organizationId: k.organizationId,
					privateKey: k.privateKey,
				}),
			),
		};
	},
};

const sshKeyGet: Tool<z.infer<typeof apiFindOneSshKey>, SshKeySummary> = {
	name: "server_ssh_key_get",
	description:
		"Get an SSH key by ID for the current organization. Private key is never returned.",
	category: "server",
	parameters: apiFindOneSshKey,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const k = await findSSHKeyById(params.sshKeyId);
		if (k.organizationId !== ctx.organizationId) {
			return accessDenied("SSH key access denied", {
				sshKeyId: params.sshKeyId,
				name: "",
				description: null,
				publicKey: "",
				createdAt: "",
				lastUsedAt: null,
				organizationId: "",
				privateKeyMasked: true,
				privateKeyPresent: false,
			});
		}

		return {
			success: true,
			message: "SSH key retrieved",
			data: toSummary({
				sshKeyId: k.sshKeyId,
				name: k.name,
				description: k.description ?? null,
				publicKey: k.publicKey,
				createdAt: k.createdAt,
				lastUsedAt: k.lastUsedAt ?? null,
				organizationId: k.organizationId,
				privateKey: k.privateKey,
			}),
		};
	},
};

const sshKeyCreate: Tool<
	z.infer<typeof apiCreateSshKey> & { confirm: typeof CONFIRM_SSH_KEY_CHANGE },
	{ created: boolean }
> = {
	name: "server_ssh_key_create",
	description:
		"Create an SSH key for the current organization (requires approval + confirm). Private key is never returned.",
	category: "server",
	parameters: apiCreateSshKey.extend({
		confirm: z.literal(CONFIRM_SSH_KEY_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const { confirm: _confirm, organizationId: _org, ...input } = params;
		await createSshKey({
			...input,
			organizationId: ctx.organizationId,
		});

		return {
			success: true,
			message: "SSH key created",
			data: { created: true },
		};
	},
};

const sshKeyUpdate: Tool<
	z.infer<typeof apiUpdateSshKey> & { confirm: typeof CONFIRM_SSH_KEY_CHANGE },
	SshKeySummary
> = {
	name: "server_ssh_key_update",
	description: "Update SSH key name/description (requires approval + confirm).",
	category: "server",
	parameters: apiUpdateSshKey.extend({
		confirm: z.literal(CONFIRM_SSH_KEY_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const current = await findSSHKeyById(params.sshKeyId);
		if (current.organizationId !== ctx.organizationId) {
			return accessDenied("SSH key access denied", {
				sshKeyId: params.sshKeyId,
				name: "",
				description: null,
				publicKey: "",
				createdAt: "",
				lastUsedAt: null,
				organizationId: "",
				privateKeyMasked: true,
				privateKeyPresent: false,
			});
		}

		const { confirm: _confirm, ...payload } = params;
		const updated = await updateSSHKeyById(payload);
		if (!updated) {
			return {
				success: false,
				message: "SSH key update failed",
				error: "NOT_FOUND",
				data: {
					sshKeyId: params.sshKeyId,
					name: "",
					description: null,
					publicKey: "",
					createdAt: "",
					lastUsedAt: null,
					organizationId: "",
					privateKeyMasked: true,
					privateKeyPresent: false,
				},
			};
		}
		const u = updated;
		return {
			success: true,
			message: "SSH key updated",
			data: toSummary({
				sshKeyId: u.sshKeyId,
				name: u.name,
				description: u.description ?? null,
				publicKey: u.publicKey,
				createdAt: u.createdAt,
				lastUsedAt: u.lastUsedAt ?? null,
				organizationId: u.organizationId,
				privateKey: u.privateKey,
			}),
		};
	},
};

const sshKeyRemove: Tool<
	z.infer<typeof apiRemoveSshKey> & { confirm: typeof CONFIRM_SSH_KEY_REMOVE },
	{ removed: boolean; sshKeyId: string }
> = {
	name: "server_ssh_key_remove",
	description: "Remove an SSH key (requires approval + confirm).",
	category: "server",
	parameters: apiRemoveSshKey.extend({
		confirm: z.literal(CONFIRM_SSH_KEY_REMOVE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const current = await findSSHKeyById(params.sshKeyId);
		if (current.organizationId !== ctx.organizationId) {
			return accessDenied("SSH key access denied", {
				removed: false,
				sshKeyId: params.sshKeyId,
			});
		}

		await removeSSHKeyById(params.sshKeyId);
		return {
			success: true,
			message: "SSH key removed",
			data: { removed: true, sshKeyId: params.sshKeyId },
		};
	},
};

const sshKeyGenerate: Tool<
	z.infer<typeof apiGenerateSSHKey> & {
		confirm: typeof CONFIRM_SSH_KEY_GENERATE;
	},
	GeneratedSshKey
> = {
	name: "server_ssh_key_generate",
	description:
		"Generate a new SSH key pair (returns private key; requires approval + confirm).",
	category: "server",
	parameters: apiGenerateSSHKey.extend({
		confirm: z.literal(CONFIRM_SSH_KEY_GENERATE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const type = (params.type ?? "rsa") as "rsa" | "ed25519";
		const keys = await generateSSHKey(type);
		return {
			success: true,
			message:
				"SSH key generated. Save the private key securely now; it will not be shown again unless you explicitly store/reveal it.",
			data: {
				type,
				privateKey: keys.privateKey,
				publicKey: keys.publicKey,
			},
		};
	},
};

export function registerSshKeyTools() {
	toolRegistry.register(sshKeyList);
	toolRegistry.register(sshKeyGet);
	toolRegistry.register(sshKeyCreate);
	toolRegistry.register(sshKeyUpdate);
	toolRegistry.register(sshKeyRemove);
	toolRegistry.register(sshKeyGenerate);
}

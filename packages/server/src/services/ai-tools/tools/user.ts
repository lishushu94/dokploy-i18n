import {
	findNotificationById,
	findOrganizationById,
	getDokployUrl,
	getInvitationEmailContent,
	getUserByToken,
	IS_CLOUD,
	removeUserById,
	sendEmailNotification,
	updateUser,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	account,
	apiAssignPermissions,
	apiFindOneToken,
	apikey,
	apiUpdateUser,
	invitation,
	member,
} from "@dokploy/server/db/schema";
import {
	createApiKey as createApiKeyService,
	findMemberById,
} from "@dokploy/server/services/user";
import { TRPCError } from "@trpc/server";
import * as bcrypt from "bcrypt";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

const CONFIRM_USER_PROFILE_UPDATE = "CONFIRM_USER_PROFILE_UPDATE" as const;
const CONFIRM_USER_PERMISSION_CHANGE =
	"CONFIRM_USER_PERMISSION_CHANGE" as const;
const CONFIRM_USER_REMOVE = "CONFIRM_USER_REMOVE" as const;
const CONFIRM_USER_API_KEY_REVEAL = "CONFIRM_USER_API_KEY_REVEAL" as const;
const CONFIRM_USER_SEND_INVITATION = "CONFIRM_USER_SEND_INVITATION" as const;

const accessDenied = <T>(message: string, data: T): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const requireOrgOwner = async <T>(ctx: ToolContext, data: T) => {
	const m = await findMemberById(ctx.userId, ctx.organizationId);
	if (m.role !== "owner")
		return accessDenied("Only organization owner can manage users", data);
	return null;
};

const ensureSameOrgMember = async (ctx: ToolContext, targetUserId: string) => {
	const memberResult = await db.query.member.findFirst({
		where: and(
			eq(member.userId, targetUserId),
			eq(member.organizationId, ctx.organizationId),
		),
		with: {
			user: {
				columns: {
					id: true,
					email: true,
					name: true,
					image: true,
					emailVerified: true,
					twoFactorEnabled: true,
					createdAt: true,
					updatedAt: true,
				},
			},
		},
	});
	if (!memberResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "User not found in this organization",
		});
	}
	return memberResult;
};

const apiCreateApiKey = z.object({
	name: z.string().min(1),
	prefix: z.string().optional(),
	expiresIn: z.number().optional(),
	metadata: z.object({
		organizationId: z.string(),
	}),
	rateLimitEnabled: z.boolean().optional(),
	rateLimitTimeWindow: z.number().optional(),
	rateLimitMax: z.number().optional(),
	remaining: z.number().optional(),
	refillAmount: z.number().optional(),
	refillInterval: z.number().optional(),
});

const userList: Tool<Record<string, never>, unknown[]> = {
	name: "user_list",
	description: "List all organization members (owner-only).",
	category: "user",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, [] as unknown[]);
		if (denied) return denied;
		const members = await db.query.member.findMany({
			where: eq(member.organizationId, ctx.organizationId),
			with: {
				user: {
					columns: {
						id: true,
						email: true,
						name: true,
						image: true,
						emailVerified: true,
						twoFactorEnabled: true,
						createdAt: true,
						updatedAt: true,
					},
				},
			},
			orderBy: [asc(member.createdAt)],
		});
		return { success: true, message: "Members", data: members as unknown[] };
	},
};

const userGet: Tool<{ userId: string }, unknown> = {
	name: "user_get",
	description: "Get a user in current organization (self or owner).",
	category: "user",
	parameters: z.object({ userId: z.string().min(1) }),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const memberResult = await ensureSameOrgMember(ctx, params.userId);
		if (memberResult.userId !== ctx.userId) {
			const m = await findMemberById(ctx.userId, ctx.organizationId);
			if (m.role !== "owner") {
				return accessDenied("You are not authorized to access this user", null);
			}
		}
		return { success: true, message: "User", data: memberResult as unknown };
	},
};

const userGetSelf: Tool<Record<string, never>, unknown> = {
	name: "user_get_self",
	description:
		"Get current user profile within organization (includes apiKeys list).",
	category: "user",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		const memberResult = await db.query.member.findFirst({
			where: and(
				eq(member.userId, ctx.userId),
				eq(member.organizationId, ctx.organizationId),
			),
			with: {
				user: {
					columns: {
						id: true,
						email: true,
						name: true,
						image: true,
						emailVerified: true,
						twoFactorEnabled: true,
						createdAt: true,
						updatedAt: true,
					},
					with: {
						apiKeys: {
							columns: {
								id: true,
								name: true,
								start: true,
								prefix: true,
								userId: true,
								refillInterval: true,
								refillAmount: true,
								lastRefillAt: true,
								enabled: true,
								rateLimitEnabled: true,
								rateLimitTimeWindow: true,
								rateLimitMax: true,
								requestCount: true,
								remaining: true,
								lastRequest: true,
								expiresAt: true,
								createdAt: true,
								updatedAt: true,
								permissions: true,
								metadata: true,
							},
						},
					},
				},
			},
		});
		return { success: true, message: "Self", data: memberResult as unknown };
	},
};

const userUpdateSelf: Tool<
	z.infer<typeof apiUpdateUser> & {
		confirm: typeof CONFIRM_USER_PROFILE_UPDATE;
	},
	unknown
> = {
	name: "user_update_self",
	description:
		"Update your own user profile (and optionally change password). Requires approval + confirm.",
	category: "user",
	parameters: apiUpdateUser.extend({
		confirm: z.literal(CONFIRM_USER_PROFILE_UPDATE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const { confirm: _confirm, ...input } = params;

		if (input.password || input.currentPassword) {
			const currentAuth = await db.query.account.findFirst({
				where: eq(account.userId, ctx.userId),
			});
			const correctPassword = bcrypt.compareSync(
				input.currentPassword || "",
				currentAuth?.password || "",
			);
			if (!correctPassword) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Current password is incorrect",
				});
			}
			if (!input.password) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "New password is required",
				});
			}
			await db
				.update(account)
				.set({ password: bcrypt.hashSync(input.password, 10) })
				.where(eq(account.userId, ctx.userId));
		}

		const updated = await updateUser(ctx.userId, input);
		return {
			success: true,
			message: "User updated",
			data: {
				id: updated?.id,
				email: updated?.email,
				name: updated?.name,
				image: updated?.image,
				emailVerified: updated?.emailVerified,
				twoFactorEnabled: updated?.twoFactorEnabled,
				createdAt: updated?.createdAt,
				updatedAt: updated?.updatedAt,
			} as unknown,
		};
	},
};

const userGetUserByToken: Tool<z.infer<typeof apiFindOneToken>, unknown> = {
	name: "user_get_by_invitation_token",
	description: "Get invitation status by token (public).",
	category: "user",
	parameters: apiFindOneToken,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, _ctx) => {
		const res = await getUserByToken(params.token);
		return { success: true, message: "Invitation", data: res as unknown };
	},
};

const userAssignPermissions: Tool<
	z.infer<typeof apiAssignPermissions> & {
		confirm: typeof CONFIRM_USER_PERMISSION_CHANGE;
	},
	{ updated: boolean }
> = {
	name: "user_assign_permissions",
	description:
		"Assign member permissions for a user in current organization (owner-only). Requires approval + confirm.",
	category: "user",
	parameters: apiAssignPermissions.extend({
		confirm: z.literal(CONFIRM_USER_PERMISSION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { updated: false });
		if (denied) return denied;
		await ensureSameOrgMember(ctx, params.id);
		const { confirm: _confirm, id, ...rest } = params;
		await db
			.update(member)
			.set({ ...rest })
			.where(
				and(
					eq(member.userId, id),
					eq(member.organizationId, ctx.organizationId),
				),
			);
		return {
			success: true,
			message: "Permissions updated",
			data: { updated: true },
		};
	},
};

const userInvitationsList: Tool<Record<string, never>, unknown[]> = {
	name: "user_invitations_list",
	description: "List pending invitations for current email.",
	category: "user",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const currentMember = await findMemberById(ctx.userId, ctx.organizationId);
		const invitations = await db.query.invitation.findMany({
			where: and(
				eq(invitation.email, currentMember.user.email),
				gt(invitation.expiresAt, new Date()),
				eq(invitation.status, "pending"),
			),
			with: { organization: true },
		});
		return {
			success: true,
			message: "Invitations",
			data: invitations as unknown[],
		};
	},
};

const userSendInvitation: Tool<
	{
		invitationId: string;
		notificationId: string;
		confirm: typeof CONFIRM_USER_SEND_INVITATION;
	},
	{ inviteLink: string | null }
> = {
	name: "user_send_invitation",
	description:
		"Send an invitation email via an Email notification provider (owner-only, non-cloud). Requires approval + confirm.",
	category: "user",
	parameters: z.object({
		invitationId: z.string().min(1),
		notificationId: z.string().min(1),
		confirm: z.literal(CONFIRM_USER_SEND_INVITATION),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { inviteLink: null });
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: invitation emails disabled",
				data: { inviteLink: null },
			};
		}

		const notification = await findNotificationById(params.notificationId);
		const email = notification.email;
		if (!email) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Email notification not found",
			});
		}

		const currentInvitation = await db.query.invitation.findFirst({
			where: eq(invitation.id, params.invitationId),
		});
		const host =
			process.env.NODE_ENV === "development"
				? "http://localhost:3000"
				: await getDokployUrl();
		const inviteLink = `${host}/invitation?token=${params.invitationId}`;
		const org = await findOrganizationById(ctx.organizationId);

		const { subject, html } = getInvitationEmailContent({
			organizationName: org?.name || "organization",
			inviteLink,
		});
		await sendEmailNotification(
			{ ...email, toAddresses: [currentInvitation?.email || ""] },
			subject,
			html,
		);

		return { success: true, message: "Invitation sent", data: { inviteLink } };
	},
};

const userApiKeysListMasked: Tool<
	Record<string, never>,
	{ apiKeyIds: string[]; total: number }
> = {
	name: "user_api_keys_list_masked",
	description: "List your API keys (masked: no plaintext key).",
	category: "user",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		const keys = await db.query.apikey.findMany({
			where: eq(apikey.userId, ctx.userId),
		});
		return {
			success: true,
			message: "API keys",
			data: { apiKeyIds: keys.map((k) => k.id), total: keys.length },
		};
	},
};

const userApiKeyCreate: Tool<
	z.infer<typeof apiCreateApiKey> & {
		confirm: typeof CONFIRM_USER_API_KEY_REVEAL;
	},
	unknown
> = {
	name: "user_api_key_create",
	description:
		"Create an API key for yourself. Requires approval + confirm because plaintext key will be returned.",
	category: "user",
	parameters: apiCreateApiKey.extend({
		confirm: z.literal(CONFIRM_USER_API_KEY_REVEAL),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const apiKey = await createApiKeyService(ctx.userId, params);
		return {
			success: true,
			message: "API key created",
			data: apiKey as unknown,
		};
	},
};

const userApiKeyDelete: Tool<
	{ apiKeyId: string; confirm: typeof CONFIRM_USER_PERMISSION_CHANGE },
	boolean
> = {
	name: "user_api_key_delete",
	description: "Delete one of your API keys. Requires approval + confirm.",
	category: "user",
	parameters: z.object({
		apiKeyId: z.string().min(1),
		confirm: z.literal(CONFIRM_USER_PERMISSION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const apiKeyToDelete = await db.query.apikey.findFirst({
			where: eq(apikey.id, params.apiKeyId),
		});
		if (!apiKeyToDelete)
			throw new TRPCError({ code: "NOT_FOUND", message: "API key not found" });
		if (apiKeyToDelete.userId !== ctx.userId) {
			throw new TRPCError({ code: "UNAUTHORIZED", message: "Not allowed" });
		}
		await db.delete(apikey).where(eq(apikey.id, params.apiKeyId));
		return { success: true, message: "API key deleted", data: true };
	},
};

const userCheckUserOrganizations: Tool<{ userId: string }, number> = {
	name: "user_check_organizations",
	description: "Count how many organizations a user belongs to (owner-only).",
	category: "user",
	parameters: z.object({ userId: z.string().min(1) }),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, 0);
		if (denied) return denied;
		const organizations = await db.query.member.findMany({
			where: eq(member.userId, params.userId),
		});
		return {
			success: true,
			message: "Organization count",
			data: organizations.length,
		};
	},
};

const userRemoveUser: Tool<
	{ userId: string; confirm: typeof CONFIRM_USER_REMOVE },
	boolean
> = {
	name: "user_remove",
	description:
		"Remove a user account (non-cloud). Owner-only and requires approval + confirm.",
	category: "user",
	parameters: z.object({
		userId: z.string().min(1),
		confirm: z.literal(CONFIRM_USER_REMOVE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD)
			return {
				success: true,
				message: "Cloud: remove is disabled",
				data: true,
			};
		await ensureSameOrgMember(ctx, params.userId);
		await removeUserById(params.userId);
		return { success: true, message: "User removed", data: true };
	},
};

export function registerUserTools() {
	toolRegistry.register(userList);
	toolRegistry.register(userGet);
	toolRegistry.register(userGetSelf);
	toolRegistry.register(userUpdateSelf);
	toolRegistry.register(userGetUserByToken);
	toolRegistry.register(userAssignPermissions);
	toolRegistry.register(userInvitationsList);
	toolRegistry.register(userSendInvitation);
	toolRegistry.register(userApiKeysListMasked);
	toolRegistry.register(userApiKeyCreate);
	toolRegistry.register(userApiKeyDelete);
	toolRegistry.register(userCheckUserOrganizations);
	toolRegistry.register(userRemoveUser);
}

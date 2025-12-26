import { db } from "@dokploy/server/db";
import {
	apiCreateDiscord,
	apiCreateEmail,
	apiCreateGotify,
	apiCreateLark,
	apiCreateNtfy,
	apiCreateSlack,
	apiCreateTelegram,
	apiFindOneNotification,
	apiTestDiscordConnection,
	apiTestEmailConnection,
	apiTestGotifyConnection,
	apiTestLarkConnection,
	apiTestNtfyConnection,
	apiTestSlackConnection,
	apiTestTelegramConnection,
	apiUpdateDiscord,
	apiUpdateEmail,
	apiUpdateGotify,
	apiUpdateLark,
	apiUpdateNtfy,
	apiUpdateSlack,
	apiUpdateTelegram,
	notifications as notificationsTable,
} from "@dokploy/server/db/schema";
import {
	createDiscordNotification,
	createEmailNotification,
	createGotifyNotification,
	createLarkNotification,
	createNtfyNotification,
	createSlackNotification,
	createTelegramNotification,
	findNotificationById,
	removeNotificationById,
	updateDiscordNotification,
	updateEmailNotification,
	updateGotifyNotification,
	updateLarkNotification,
	updateNtfyNotification,
	updateSlackNotification,
	updateTelegramNotification,
} from "@dokploy/server/services/notification";
import { findMemberById } from "@dokploy/server/services/user";
import { getTestNotificationContent } from "@dokploy/server/utils/i18n/backend";
import {
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendNtfyNotification,
	sendSlackNotification,
	sendTelegramNotification,
} from "@dokploy/server/utils/notifications/utils";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type NotificationSummary = {
	notificationId: string;
	name: string;
	notificationType:
		| "slack"
		| "telegram"
		| "discord"
		| "email"
		| "gotify"
		| "ntfy"
		| "lark";
	appDeploy: boolean;
	appBuildError: boolean;
	databaseBackup: boolean;
	dokployRestart: boolean;
	dockerCleanup: boolean;
	serverThreshold: boolean;
	createdAt: string;
	connection:
		| {
				type: "slack";
				channel: string | null;
				webhookUrlPresent: boolean;
		  }
		| {
				type: "telegram";
				chatId: string;
				messageThreadId: string | null;
				botTokenPresent: boolean;
		  }
		| {
				type: "discord";
				decoration: boolean | null;
				webhookUrlPresent: boolean;
		  }
		| {
				type: "email";
				smtpServer: string;
				smtpPort: number;
				username: string;
				fromAddress: string;
				toAddressesCount: number;
				passwordPresent: boolean;
		  }
		| {
				type: "gotify";
				serverUrl: string;
				priority: number;
				decoration: boolean | null;
				appTokenPresent: boolean;
		  }
		| {
				type: "ntfy";
				serverUrl: string;
				topic: string;
				priority: number;
				accessTokenPresent: boolean;
		  }
		| {
				type: "lark";
				webhookUrlPresent: boolean;
		  };
};

type NotificationMasked = NotificationSummary;

type BoolResult = { ok: boolean };

type FullNotification = Awaited<ReturnType<typeof findNotificationById>>;

const CONFIRM_NOTIFICATION_CHANGE = "CONFIRM_NOTIFICATION_CHANGE" as const;
const CONFIRM_NOTIFICATION_TEST = "CONFIRM_NOTIFICATION_TEST" as const;
const CONFIRM_NOTIFICATION_REMOVE = "CONFIRM_NOTIFICATION_REMOVE" as const;

const requireOrgOwner = async <T>(
	ctx: ToolContext,
	data: T,
): Promise<ToolResult<T> | null> => {
	const member = await findMemberById(ctx.userId, ctx.organizationId);
	if (member.role !== "owner") {
		return {
			success: false,
			message: "Only organization owner can manage notifications",
			error: "UNAUTHORIZED",
			data,
		};
	}
	return null;
};

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const toNotificationSummary = (n: FullNotification): NotificationSummary => {
	const base: Omit<NotificationSummary, "connection"> = {
		notificationId: n.notificationId,
		name: n.name,
		notificationType:
			n.notificationType as NotificationSummary["notificationType"],
		appDeploy: n.appDeploy,
		appBuildError: n.appBuildError,
		databaseBackup: n.databaseBackup,
		dokployRestart: n.dokployRestart,
		dockerCleanup: n.dockerCleanup,
		serverThreshold: n.serverThreshold,
		createdAt: n.createdAt,
	};

	if (n.notificationType === "slack") {
		return {
			...base,
			connection: {
				type: "slack" as const,
				channel: n.slack?.channel ?? null,
				webhookUrlPresent: Boolean(n.slack?.webhookUrl),
			},
		};
	}

	if (n.notificationType === "telegram") {
		return {
			...base,
			connection: {
				type: "telegram" as const,
				chatId: n.telegram?.chatId ?? "",
				messageThreadId: n.telegram?.messageThreadId ?? null,
				botTokenPresent: Boolean(n.telegram?.botToken),
			},
		};
	}

	if (n.notificationType === "discord") {
		return {
			...base,
			connection: {
				type: "discord" as const,
				decoration: n.discord?.decoration ?? null,
				webhookUrlPresent: Boolean(n.discord?.webhookUrl),
			},
		};
	}

	if (n.notificationType === "email") {
		return {
			...base,
			connection: {
				type: "email" as const,
				smtpServer: n.email?.smtpServer ?? "",
				smtpPort: n.email?.smtpPort ?? 0,
				username: n.email?.username ?? "",
				fromAddress: n.email?.fromAddress ?? "",
				toAddressesCount: n.email?.toAddresses?.length ?? 0,
				passwordPresent: Boolean(n.email?.password),
			},
		};
	}

	if (n.notificationType === "gotify") {
		return {
			...base,
			connection: {
				type: "gotify" as const,
				serverUrl: n.gotify?.serverUrl ?? "",
				priority: n.gotify?.priority ?? 0,
				decoration: n.gotify?.decoration ?? null,
				appTokenPresent: Boolean(n.gotify?.appToken),
			},
		};
	}

	if (n.notificationType === "ntfy") {
		return {
			...base,
			connection: {
				type: "ntfy" as const,
				serverUrl: n.ntfy?.serverUrl ?? "",
				topic: n.ntfy?.topic ?? "",
				priority: n.ntfy?.priority ?? 0,
				accessTokenPresent: Boolean(n.ntfy?.accessToken),
			},
		};
	}

	return {
		...base,
		connection: {
			type: "lark" as const,
			webhookUrlPresent: Boolean(n.lark?.webhookUrl),
		},
	};
};

const notificationList: Tool<Record<string, never>, NotificationSummary[]> = {
	name: "notification_list",
	description:
		"List notifications for the current organization. Secrets (webhook URLs, tokens, passwords) are never returned.",
	category: "server",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, [] as NotificationSummary[]);
		if (denied) return denied;

		const rows = await db.query.notifications.findMany({
			with: {
				slack: true,
				telegram: true,
				discord: true,
				email: true,
				gotify: true,
				ntfy: true,
				lark: true,
			},
			where: eq(notificationsTable.organizationId, ctx.organizationId),
			orderBy: desc(notificationsTable.createdAt),
		});
		const data = rows.map((r) => toNotificationSummary(r as FullNotification));

		return {
			success: true,
			message: `Found ${data.length} notification(s)`,
			data,
		};
	},
};

const notificationGet: Tool<
	z.infer<typeof apiFindOneNotification>,
	NotificationMasked
> = {
	name: "notification_get",
	description:
		"Get a single notification by ID for the current organization. Secrets (webhook URLs, tokens, passwords) are never returned.",
	category: "server",
	parameters: apiFindOneNotification,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		try {
			const n = await findNotificationById(params.notificationId);
			if (n.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: {
						notificationId: params.notificationId,
						name: "",
						notificationType: "slack",
						appDeploy: false,
						appBuildError: false,
						databaseBackup: false,
						dokployRestart: false,
						dockerCleanup: false,
						serverThreshold: false,
						createdAt: "",
						connection: {
							type: "slack",
							channel: null,
							webhookUrlPresent: false,
						},
					},
				};
			}

			return {
				success: true,
				message: "Notification fetched",
				data: toNotificationSummary(n),
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to fetch notification",
				error: msg,
				data: {
					notificationId: params.notificationId,
					name: "",
					notificationType: "slack",
					appDeploy: false,
					appBuildError: false,
					databaseBackup: false,
					dokployRestart: false,
					dockerCleanup: false,
					serverThreshold: false,
					createdAt: "",
					connection: {
						type: "slack",
						channel: null,
						webhookUrlPresent: false,
					},
				},
			};
		}
	},
};

const notificationEmailProvidersList: Tool<
	Record<string, never>,
	NotificationSummary[]
> = {
	name: "notification_email_provider_list",
	description:
		"List email notification providers for the current organization (masked). Secrets (SMTP password) is never returned.",
	category: "server",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, [] as NotificationSummary[]);
		if (denied) return denied;

		const rows = await db.query.notifications.findMany({
			with: {
				slack: true,
				telegram: true,
				discord: true,
				email: true,
				gotify: true,
				ntfy: true,
				lark: true,
			},
			where: and(
				eq(notificationsTable.organizationId, ctx.organizationId),
				eq(notificationsTable.notificationType, "email"),
			),
			orderBy: desc(notificationsTable.createdAt),
		});

		const data = rows.map((r) => toNotificationSummary(r as FullNotification));

		return {
			success: true,
			message: `Found ${data.length} email provider(s)`,
			data,
		};
	},
};

const slackCreate: Tool<
	z.infer<typeof apiCreateSlack> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_slack_create",
	description:
		"Create a Slack notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Slack webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiCreateSlack.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			await createSlackNotification(input, ctx.organizationId);
			return {
				success: true,
				message: "Slack notification created",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create Slack notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const slackUpdate: Tool<
	z.infer<typeof apiUpdateSlack> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_slack_update",
	description:
		"Update a Slack notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Slack webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiUpdateSlack.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		try {
			const existing = await findNotificationById(params.notificationId);
			if (existing.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: { ok: false },
				};
			}
			const { confirm: _confirm, ...input } = params;
			await updateSlackNotification({
				...input,
				organizationId: ctx.organizationId,
			});
			return {
				success: true,
				message: "Slack notification updated",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to update Slack notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const slackTest: Tool<
	z.infer<typeof apiTestSlackConnection> & {
		confirm: typeof CONFIRM_NOTIFICATION_TEST;
	},
	BoolResult
> = {
	name: "notification_slack_test_connection",
	description:
		"Test Slack notification connection (sends a test message). Requires approval + confirm=CONFIRM_NOTIFICATION_TEST. Slack webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiTestSlackConnection.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_TEST),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			const { testMessage } = getTestNotificationContent();
			await sendSlackNotification(input, {
				channel: input.channel,
				text: testMessage,
			});
			return {
				success: true,
				message: "Slack test notification sent",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to send Slack test notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const telegramCreate: Tool<
	z.infer<typeof apiCreateTelegram> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_telegram_create",
	description:
		"Create a Telegram notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Telegram botToken is accepted but never returned.",
	category: "server",
	parameters: apiCreateTelegram.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			await createTelegramNotification(input, ctx.organizationId);
			return {
				success: true,
				message: "Telegram notification created",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create Telegram notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const telegramUpdate: Tool<
	z.infer<typeof apiUpdateTelegram> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_telegram_update",
	description:
		"Update a Telegram notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Telegram botToken is accepted but never returned.",
	category: "server",
	parameters: apiUpdateTelegram.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		try {
			const existing = await findNotificationById(params.notificationId);
			if (existing.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: { ok: false },
				};
			}
			const { confirm: _confirm, ...input } = params;
			await updateTelegramNotification({
				...input,
				organizationId: ctx.organizationId,
			});
			return {
				success: true,
				message: "Telegram notification updated",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to update Telegram notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const telegramTest: Tool<
	z.infer<typeof apiTestTelegramConnection> & {
		confirm: typeof CONFIRM_NOTIFICATION_TEST;
	},
	BoolResult
> = {
	name: "notification_telegram_test_connection",
	description:
		"Test Telegram notification connection (sends a test message). Requires approval + confirm=CONFIRM_NOTIFICATION_TEST. Telegram botToken is accepted but never returned.",
	category: "server",
	parameters: apiTestTelegramConnection.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_TEST),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			const { testMessage } = getTestNotificationContent();
			await sendTelegramNotification(input, testMessage);
			return {
				success: true,
				message: "Telegram test notification sent",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to send Telegram test notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const discordCreate: Tool<
	z.infer<typeof apiCreateDiscord> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_discord_create",
	description:
		"Create a Discord notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Discord webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiCreateDiscord.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			await createDiscordNotification(input, ctx.organizationId);
			return {
				success: true,
				message: "Discord notification created",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create Discord notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const discordUpdate: Tool<
	z.infer<typeof apiUpdateDiscord> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_discord_update",
	description:
		"Update a Discord notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Discord webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiUpdateDiscord.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		try {
			const existing = await findNotificationById(params.notificationId);
			if (existing.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: { ok: false },
				};
			}
			const { confirm: _confirm, ...input } = params;
			await updateDiscordNotification({
				...input,
				organizationId: ctx.organizationId,
			});
			return {
				success: true,
				message: "Discord notification updated",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to update Discord notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const discordTest: Tool<
	z.infer<typeof apiTestDiscordConnection> & {
		confirm: typeof CONFIRM_NOTIFICATION_TEST;
	},
	BoolResult
> = {
	name: "notification_discord_test_connection",
	description:
		"Test Discord notification connection (sends a test message). Requires approval + confirm=CONFIRM_NOTIFICATION_TEST. Discord webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiTestDiscordConnection.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_TEST),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			const decorate = (decoration: string, text: string) =>
				`${input.decoration ? decoration : ""} ${text}`.trim();
			const { discordTitle, testMessage } = getTestNotificationContent();
			await sendDiscordNotification(input, {
				title: decorate(">", discordTitle),
				description: decorate(">", testMessage),
				color: 0xf3f7f4,
			});
			return {
				success: true,
				message: "Discord test notification sent",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to send Discord test notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const emailCreate: Tool<
	z.infer<typeof apiCreateEmail> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_email_create",
	description:
		"Create an Email notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Email password is accepted but never returned.",
	category: "server",
	parameters: apiCreateEmail.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			await createEmailNotification(input, ctx.organizationId);
			return {
				success: true,
				message: "Email notification created",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create Email notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const emailUpdate: Tool<
	z.infer<typeof apiUpdateEmail> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_email_update",
	description:
		"Update an Email notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Email password is accepted but never returned.",
	category: "server",
	parameters: apiUpdateEmail.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		try {
			const existing = await findNotificationById(params.notificationId);
			if (existing.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: { ok: false },
				};
			}
			const { confirm: _confirm, ...input } = params;
			await updateEmailNotification({
				...input,
				organizationId: ctx.organizationId,
			});
			return {
				success: true,
				message: "Email notification updated",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to update Email notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const emailTest: Tool<
	z.infer<typeof apiTestEmailConnection> & {
		confirm: typeof CONFIRM_NOTIFICATION_TEST;
	},
	BoolResult
> = {
	name: "notification_email_test_connection",
	description:
		"Test Email notification connection (sends a test email). Requires approval + confirm=CONFIRM_NOTIFICATION_TEST. Email password is accepted but never returned.",
	category: "server",
	parameters: apiTestEmailConnection.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_TEST),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			const { emailSubject, emailHtml } = getTestNotificationContent();
			await sendEmailNotification(input, emailSubject, emailHtml);
			return {
				success: true,
				message: "Email test notification sent",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to send Email test notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const gotifyCreate: Tool<
	z.infer<typeof apiCreateGotify> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_gotify_create",
	description:
		"Create a Gotify notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Gotify appToken is accepted but never returned.",
	category: "server",
	parameters: apiCreateGotify.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			await createGotifyNotification(input, ctx.organizationId);
			return {
				success: true,
				message: "Gotify notification created",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create Gotify notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const gotifyUpdate: Tool<
	z.infer<typeof apiUpdateGotify> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_gotify_update",
	description:
		"Update a Gotify notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Gotify appToken is accepted but never returned.",
	category: "server",
	parameters: apiUpdateGotify.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		try {
			const existing = await findNotificationById(params.notificationId);
			if (existing.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: { ok: false },
				};
			}
			const { confirm: _confirm, ...input } = params;
			await updateGotifyNotification({
				...input,
				organizationId: ctx.organizationId,
			});
			return {
				success: true,
				message: "Gotify notification updated",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to update Gotify notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const gotifyTest: Tool<
	z.infer<typeof apiTestGotifyConnection> & {
		confirm: typeof CONFIRM_NOTIFICATION_TEST;
	},
	BoolResult
> = {
	name: "notification_gotify_test_connection",
	description:
		"Test Gotify notification connection (sends a test message). Requires approval + confirm=CONFIRM_NOTIFICATION_TEST. Gotify appToken is accepted but never returned.",
	category: "server",
	parameters: apiTestGotifyConnection.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_TEST),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			const { notificationTitle, testMessage } = getTestNotificationContent();
			await sendGotifyNotification(input, notificationTitle, testMessage);
			return {
				success: true,
				message: "Gotify test notification sent",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to send Gotify test notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const ntfyCreate: Tool<
	z.infer<typeof apiCreateNtfy> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_ntfy_create",
	description:
		"Create an Ntfy notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Ntfy accessToken is accepted but never returned.",
	category: "server",
	parameters: apiCreateNtfy.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			await createNtfyNotification(input, ctx.organizationId);
			return {
				success: true,
				message: "Ntfy notification created",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create Ntfy notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const ntfyUpdate: Tool<
	z.infer<typeof apiUpdateNtfy> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_ntfy_update",
	description:
		"Update an Ntfy notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Ntfy accessToken is accepted but never returned.",
	category: "server",
	parameters: apiUpdateNtfy.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		try {
			const existing = await findNotificationById(params.notificationId);
			if (existing.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: { ok: false },
				};
			}
			const { confirm: _confirm, ...input } = params;
			await updateNtfyNotification({
				...input,
				organizationId: ctx.organizationId,
			});
			return {
				success: true,
				message: "Ntfy notification updated",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to update Ntfy notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const ntfyTest: Tool<
	z.infer<typeof apiTestNtfyConnection> & {
		confirm: typeof CONFIRM_NOTIFICATION_TEST;
	},
	BoolResult
> = {
	name: "notification_ntfy_test_connection",
	description:
		"Test Ntfy notification connection (sends a test message). Requires approval + confirm=CONFIRM_NOTIFICATION_TEST. Ntfy accessToken is accepted but never returned.",
	category: "server",
	parameters: apiTestNtfyConnection.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_TEST),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			const { notificationTitle, ntfyActions, testMessage } =
				getTestNotificationContent();
			await sendNtfyNotification(
				input,
				notificationTitle,
				"",
				ntfyActions,
				testMessage,
			);
			return {
				success: true,
				message: "Ntfy test notification sent",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to send Ntfy test notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const larkCreate: Tool<
	z.infer<typeof apiCreateLark> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_lark_create",
	description:
		"Create a Lark notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Lark webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiCreateLark.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			await createLarkNotification(input, ctx.organizationId);
			return {
				success: true,
				message: "Lark notification created",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create Lark notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const larkUpdate: Tool<
	z.infer<typeof apiUpdateLark> & {
		confirm: typeof CONFIRM_NOTIFICATION_CHANGE;
	},
	BoolResult
> = {
	name: "notification_lark_update",
	description:
		"Update a Lark notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_CHANGE. Lark webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiUpdateLark.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		try {
			const existing = await findNotificationById(params.notificationId);
			if (existing.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: { ok: false },
				};
			}
			const { confirm: _confirm, ...input } = params;
			await updateLarkNotification({
				...input,
				organizationId: ctx.organizationId,
			});
			return {
				success: true,
				message: "Lark notification updated",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to update Lark notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const larkTest: Tool<
	z.infer<typeof apiTestLarkConnection> & {
		confirm: typeof CONFIRM_NOTIFICATION_TEST;
	},
	BoolResult
> = {
	name: "notification_lark_test_connection",
	description:
		"Test Lark notification connection (sends a test message). Requires approval + confirm=CONFIRM_NOTIFICATION_TEST. Lark webhookUrl is accepted but never returned.",
	category: "server",
	parameters: apiTestLarkConnection.extend({
		confirm: z.literal(CONFIRM_NOTIFICATION_TEST),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { ok: false });
		if (denied) return denied;

		const { confirm: _confirm, ...input } = params;
		try {
			const { larkText } = getTestNotificationContent();
			await sendLarkNotification(input, {
				msg_type: "text",
				content: { text: larkText },
			});
			return {
				success: true,
				message: "Lark test notification sent",
				data: { ok: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to send Lark test notification",
				error: msg,
				data: { ok: false },
			};
		}
	},
};

const notificationRemoveParams = apiFindOneNotification.extend({
	confirm: z.literal(CONFIRM_NOTIFICATION_REMOVE),
});

const notificationRemove: Tool<
	z.infer<typeof notificationRemoveParams>,
	{ removed: boolean }
> = {
	name: "notification_remove",
	description:
		"Remove a notification for the current organization. Requires approval + confirm=CONFIRM_NOTIFICATION_REMOVE.",
	category: "server",
	parameters: notificationRemoveParams,
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { removed: false });
		if (denied) return denied;

		try {
			const existing = await findNotificationById(params.notificationId);
			if (existing.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Notification access denied",
					error: "UNAUTHORIZED",
					data: { removed: false },
				};
			}
			await removeNotificationById(params.notificationId);
			return {
				success: true,
				message: "Notification removed",
				data: { removed: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to remove notification",
				error: msg,
				data: { removed: false },
			};
		}
	},
};

export function registerNotificationTools() {
	toolRegistry.register(notificationList);
	toolRegistry.register(notificationGet);
	toolRegistry.register(notificationEmailProvidersList);

	toolRegistry.register(slackCreate);
	toolRegistry.register(slackUpdate);
	toolRegistry.register(slackTest);

	toolRegistry.register(telegramCreate);
	toolRegistry.register(telegramUpdate);
	toolRegistry.register(telegramTest);

	toolRegistry.register(discordCreate);
	toolRegistry.register(discordUpdate);
	toolRegistry.register(discordTest);

	toolRegistry.register(emailCreate);
	toolRegistry.register(emailUpdate);
	toolRegistry.register(emailTest);

	toolRegistry.register(gotifyCreate);
	toolRegistry.register(gotifyUpdate);
	toolRegistry.register(gotifyTest);

	toolRegistry.register(ntfyCreate);
	toolRegistry.register(ntfyUpdate);
	toolRegistry.register(ntfyTest);

	toolRegistry.register(larkCreate);
	toolRegistry.register(larkUpdate);
	toolRegistry.register(larkTest);

	toolRegistry.register(notificationRemove);
}

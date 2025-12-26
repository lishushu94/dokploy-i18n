import {
	IS_CLOUD,
	removeScheduleJob,
	runCommand,
	scheduleJob,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { schedules } from "@dokploy/server/db/schema/schedule";
import { findApplicationById } from "@dokploy/server/services/application";
import { findComposeById } from "@dokploy/server/services/compose";
import {
	createSchedule,
	deleteSchedule,
	findScheduleById,
	updateSchedule,
} from "@dokploy/server/services/schedule";
import { findServerById } from "@dokploy/server/services/server";
import { findMemberById } from "@dokploy/server/services/user";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

const CONFIRM_SCHEDULE_CHANGE = "CONFIRM_SCHEDULE_CHANGE" as const;
const CONFIRM_SCHEDULE_DELETE = "CONFIRM_SCHEDULE_DELETE" as const;
const CONFIRM_SCHEDULE_RUN = "CONFIRM_SCHEDULE_RUN" as const;

type ScheduleSummary = {
	scheduleId: string;
	name: string;
	cronExpression: string;
	scheduleType: "application" | "compose" | "server" | "dokploy-server";
	enabled: boolean;
	command: string;
	script: string | null;
	serviceName: string | null;
	applicationId: string | null;
	composeId: string | null;
	serverId: string | null;
	userId: string | null;
	createdAt: string;
};

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const toSummary = (s: {
	scheduleId: string;
	name: string;
	cronExpression: string;
	scheduleType: "application" | "compose" | "server" | "dokploy-server";
	enabled: boolean;
	command: string;
	script?: string | null;
	serviceName?: string | null;
	applicationId?: string | null;
	composeId?: string | null;
	serverId?: string | null;
	userId?: string | null;
	createdAt: string;
}): ScheduleSummary => ({
	scheduleId: s.scheduleId,
	name: s.name,
	cronExpression: s.cronExpression,
	scheduleType: s.scheduleType,
	enabled: s.enabled,
	command: s.command,
	script: s.script ?? null,
	serviceName: s.serviceName ?? null,
	applicationId: s.applicationId ?? null,
	composeId: s.composeId ?? null,
	serverId: s.serverId ?? null,
	userId: s.userId ?? null,
	createdAt: s.createdAt,
});

const createCloudJob = async (input: {
	type: "schedule";
	cronSchedule: string;
	scheduleId: string;
}) => {
	const url = process.env.JOBS_URL;
	if (!url) throw new Error("JOBS_URL is not configured");
	const res = await fetch(`${url}/create-backup`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": process.env.API_KEY || "NO-DEFINED",
		},
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		throw new Error(`Failed to schedule cloud job (${res.status})`);
	}
};

const removeCloudJob = async (input: {
	type: "schedule";
	cronSchedule: string;
	scheduleId: string;
}) => {
	const url = process.env.JOBS_URL;
	if (!url) throw new Error("JOBS_URL is not configured");
	const res = await fetch(`${url}/remove-job`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": process.env.API_KEY || "NO-DEFINED",
		},
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		throw new Error(`Failed to remove cloud job (${res.status})`);
	}
};

const ensureScheduleAccess = async (
	schedule: Awaited<ReturnType<typeof findScheduleById>>,
	ctx: ToolContext,
): Promise<ToolResult<{ ok: boolean }> | null> => {
	if (schedule.scheduleType === "dokploy-server") {
		if (schedule.userId !== ctx.userId) {
			return {
				success: false,
				message: "Schedule access denied",
				error: "UNAUTHORIZED",
				data: { ok: false },
			};
		}
		return null;
	}

	if (schedule.applicationId) {
		const a = await findApplicationById(schedule.applicationId);
		if (a.environment.project.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Schedule access denied",
				error: "UNAUTHORIZED",
				data: { ok: false },
			};
		}
		return null;
	}

	if (schedule.composeId) {
		const c = await findComposeById(schedule.composeId);
		if (c.environment.project.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Schedule access denied",
				error: "UNAUTHORIZED",
				data: { ok: false },
			};
		}
		return null;
	}

	if (schedule.serverId) {
		const srv = await findServerById(schedule.serverId);
		if (srv.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Schedule access denied",
				error: "UNAUTHORIZED",
				data: { ok: false },
			};
		}
		return null;
	}

	return {
		success: false,
		message: "Schedule access denied",
		error: "UNAUTHORIZED",
		data: { ok: false },
	};
};

const scheduleList: Tool<
	{
		scheduleType: "application" | "compose" | "server" | "dokploy-server";
		id?: string;
	},
	ScheduleSummary[]
> = {
	name: "schedule_list",
	description:
		"List schedules for a target application/compose/server, or list personal dokploy-server schedules.",
	category: "server",
	parameters: z
		.object({
			scheduleType: z.enum([
				"application",
				"compose",
				"server",
				"dokploy-server",
			]),
			id: z
				.string()
				.optional()
				.describe(
					"applicationId/composeId/serverId, or userId for dokploy-server (defaults to current user)",
				),
		})
		.superRefine((v, ctx2) => {
			if (v.scheduleType !== "dokploy-server" && !v.id) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "id is required for this scheduleType",
				});
			}
		}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);

		if (params.scheduleType === "application") {
			const a = await findApplicationById(params.id as string);
			if (a.environment.project.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Application access denied",
					error: "UNAUTHORIZED",
					data: [],
				};
			}
			const rows = await db.query.schedules.findMany({
				where: eq(schedules.applicationId, params.id as string),
				orderBy: [desc(schedules.createdAt)],
			});
			return {
				success: true,
				message: `Found ${rows.length} schedule(s)`,
				data: rows.map((r) =>
					toSummary({
						scheduleId: r.scheduleId,
						name: r.name,
						cronExpression: r.cronExpression,
						scheduleType: r.scheduleType,
						enabled: r.enabled,
						command: r.command,
						script: r.script,
						serviceName: r.serviceName,
						applicationId: r.applicationId,
						composeId: r.composeId,
						serverId: r.serverId,
						userId: r.userId,
						createdAt: r.createdAt,
					}),
				),
			};
		}

		if (params.scheduleType === "compose") {
			const c = await findComposeById(params.id as string);
			if (c.environment.project.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Compose access denied",
					error: "UNAUTHORIZED",
					data: [],
				};
			}
			const rows = await db.query.schedules.findMany({
				where: eq(schedules.composeId, params.id as string),
				orderBy: [desc(schedules.createdAt)],
			});
			return {
				success: true,
				message: `Found ${rows.length} schedule(s)`,
				data: rows.map((r) =>
					toSummary({
						scheduleId: r.scheduleId,
						name: r.name,
						cronExpression: r.cronExpression,
						scheduleType: r.scheduleType,
						enabled: r.enabled,
						command: r.command,
						script: r.script,
						serviceName: r.serviceName,
						applicationId: r.applicationId,
						composeId: r.composeId,
						serverId: r.serverId,
						userId: r.userId,
						createdAt: r.createdAt,
					}),
				),
			};
		}

		if (params.scheduleType === "server") {
			const srv = await findServerById(params.id as string);
			if (srv.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Server access denied",
					error: "UNAUTHORIZED",
					data: [],
				};
			}
			const rows = await db.query.schedules.findMany({
				where: eq(schedules.serverId, params.id as string),
				orderBy: [desc(schedules.createdAt)],
			});
			return {
				success: true,
				message: `Found ${rows.length} schedule(s)`,
				data: rows.map((r) =>
					toSummary({
						scheduleId: r.scheduleId,
						name: r.name,
						cronExpression: r.cronExpression,
						scheduleType: r.scheduleType,
						enabled: r.enabled,
						command: r.command,
						script: r.script,
						serviceName: r.serviceName,
						applicationId: r.applicationId,
						composeId: r.composeId,
						serverId: r.serverId,
						userId: r.userId,
						createdAt: r.createdAt,
					}),
				),
			};
		}

		const userId = params.id ?? ctx.userId;
		if (userId !== ctx.userId) {
			return {
				success: false,
				message: "Schedule access denied",
				error: "UNAUTHORIZED",
				data: [],
			};
		}
		const rows = await db.query.schedules.findMany({
			where: eq(schedules.userId, userId),
			orderBy: [desc(schedules.createdAt)],
		});
		const filtered = rows.filter((r) => r.scheduleType === "dokploy-server");
		return {
			success: true,
			message: `Found ${filtered.length} schedule(s)`,
			data: filtered.map((r) =>
				toSummary({
					scheduleId: r.scheduleId,
					name: r.name,
					cronExpression: r.cronExpression,
					scheduleType: r.scheduleType,
					enabled: r.enabled,
					command: r.command,
					script: r.script,
					serviceName: r.serviceName,
					applicationId: r.applicationId,
					composeId: r.composeId,
					serverId: r.serverId,
					userId: r.userId,
					createdAt: r.createdAt,
				}),
			),
		};
	},
};

const scheduleGet: Tool<{ scheduleId: string }, ScheduleSummary> = {
	name: "schedule_get",
	description: "Get a schedule by ID",
	category: "server",
	parameters: z.object({ scheduleId: z.string().min(1) }),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const s = await findScheduleById(params.scheduleId);
		const denied = await ensureScheduleAccess(s, ctx);
		if (denied) {
			return {
				success: false,
				message: denied.message,
				error: denied.error,
				data: toSummary({
					scheduleId: params.scheduleId,
					name: "",
					cronExpression: "",
					scheduleType: "application",
					enabled: false,
					command: "",
					script: null,
					serviceName: null,
					applicationId: null,
					composeId: null,
					serverId: null,
					userId: null,
					createdAt: "",
				}),
			};
		}

		return {
			success: true,
			message: "Schedule retrieved",
			data: toSummary({
				scheduleId: s.scheduleId,
				name: s.name,
				cronExpression: s.cronExpression,
				scheduleType: s.scheduleType,
				enabled: s.enabled,
				command: s.command,
				script: s.script,
				serviceName: s.serviceName,
				applicationId: s.applicationId,
				composeId: s.composeId,
				serverId: s.serverId,
				userId: s.userId,
				createdAt: s.createdAt,
			}),
		};
	},
};

const scheduleCreate: Tool<
	{
		name: string;
		cronExpression: string;
		scheduleType: "application" | "compose" | "server" | "dokploy-server";
		command: string;
		script?: string | null;
		serviceName?: string | null;
		applicationId?: string | null;
		composeId?: string | null;
		serverId?: string | null;
		enabled?: boolean;
		shellType?: "bash" | "sh";
		confirm: typeof CONFIRM_SCHEDULE_CHANGE;
	},
	ScheduleSummary
> = {
	name: "schedule_create",
	description:
		"Create a schedule. High-risk tool: requires approval + confirm.",
	category: "server",
	parameters: z
		.object({
			name: z.string().min(1),
			cronExpression: z.string().min(1),
			scheduleType: z.enum([
				"application",
				"compose",
				"server",
				"dokploy-server",
			]),
			command: z.string().optional().default(""),
			script: z.string().nullable().optional(),
			serviceName: z.string().min(1).nullable().optional(),
			applicationId: z.string().min(1).nullable().optional(),
			composeId: z.string().min(1).nullable().optional(),
			serverId: z.string().min(1).nullable().optional(),
			enabled: z.boolean().optional().default(true),
			shellType: z.enum(["bash", "sh"]).optional().default("bash"),
			confirm: z.literal(CONFIRM_SCHEDULE_CHANGE),
		})
		.superRefine((v, ctx2) => {
			if (
				(v.scheduleType === "application" || v.scheduleType === "compose") &&
				v.command.trim().length === 0
			) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "command is required for application/compose schedules",
				});
			}
			if (v.scheduleType === "application" && !v.applicationId) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "applicationId is required for application schedules",
				});
			}
			if (v.scheduleType === "compose") {
				if (!v.composeId) {
					ctx2.addIssue({
						code: z.ZodIssueCode.custom,
						message: "composeId is required for compose schedules",
					});
				}
				if (!v.serviceName) {
					ctx2.addIssue({
						code: z.ZodIssueCode.custom,
						message: "serviceName is required for compose schedules",
					});
				}
			}
			if (v.scheduleType === "server" && !v.serverId) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "serverId is required for server schedules",
				});
			}
			if (
				(v.scheduleType === "server" || v.scheduleType === "dokploy-server") &&
				(!v.script || v.script.trim().length === 0)
			) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "script is required for server/dokploy-server schedules",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);

		if (params.scheduleType === "application") {
			const a = await findApplicationById(params.applicationId as string);
			if (a.environment.project.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Application access denied",
					error: "UNAUTHORIZED",
					data: toSummary({
						scheduleId: "",
						name: "",
						cronExpression: "",
						scheduleType: "application",
						enabled: false,
						command: "",
						script: null,
						serviceName: null,
						applicationId: null,
						composeId: null,
						serverId: null,
						userId: null,
						createdAt: "",
					}),
				};
			}
		}
		if (params.scheduleType === "compose") {
			const c = await findComposeById(params.composeId as string);
			if (c.environment.project.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Compose access denied",
					error: "UNAUTHORIZED",
					data: toSummary({
						scheduleId: "",
						name: "",
						cronExpression: "",
						scheduleType: "compose",
						enabled: false,
						command: "",
						script: null,
						serviceName: null,
						applicationId: null,
						composeId: null,
						serverId: null,
						userId: null,
						createdAt: "",
					}),
				};
			}
		}
		if (params.scheduleType === "server") {
			const srv = await findServerById(params.serverId as string);
			if (srv.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Server access denied",
					error: "UNAUTHORIZED",
					data: toSummary({
						scheduleId: "",
						name: "",
						cronExpression: "",
						scheduleType: "server",
						enabled: false,
						command: "",
						script: null,
						serviceName: null,
						applicationId: null,
						composeId: null,
						serverId: null,
						userId: null,
						createdAt: "",
					}),
				};
			}
		}

		const { confirm: _confirm, ...input } = params;
		const created = await createSchedule({
			name: input.name,
			cronExpression: input.cronExpression,
			scheduleType: input.scheduleType,
			command: input.command,
			script: input.script ?? null,
			serviceName:
				input.scheduleType === "compose" ? (input.serviceName ?? null) : null,
			applicationId:
				input.scheduleType === "application"
					? (input.applicationId ?? null)
					: null,
			composeId:
				input.scheduleType === "compose" ? (input.composeId ?? null) : null,
			serverId:
				input.scheduleType === "server" ? (input.serverId ?? null) : null,
			userId: input.scheduleType === "dokploy-server" ? ctx.userId : null,
			enabled: input.enabled ?? true,
			shellType: input.shellType ?? "bash",
		});

		if (!created) {
			return {
				success: false,
				message: "Failed to create schedule",
				error: "INTERNAL_SERVER_ERROR",
				data: toSummary({
					scheduleId: "",
					name: input.name,
					cronExpression: input.cronExpression,
					scheduleType: input.scheduleType,
					enabled: input.enabled ?? true,
					command: input.command,
					script: input.script ?? null,
					serviceName:
						input.scheduleType === "compose"
							? (input.serviceName ?? null)
							: null,
					applicationId:
						input.scheduleType === "application"
							? (input.applicationId ?? null)
							: null,
					composeId:
						input.scheduleType === "compose" ? (input.composeId ?? null) : null,
					serverId:
						input.scheduleType === "server" ? (input.serverId ?? null) : null,
					userId: input.scheduleType === "dokploy-server" ? ctx.userId : null,
					createdAt: "",
				}),
			};
		}

		if (created.enabled) {
			if (IS_CLOUD) {
				await createCloudJob({
					type: "schedule",
					cronSchedule: created.cronExpression,
					scheduleId: created.scheduleId,
				});
			} else {
				scheduleJob(created);
			}
		}

		return {
			success: true,
			message: "Schedule created",
			data: toSummary({
				scheduleId: created.scheduleId,
				name: created.name,
				cronExpression: created.cronExpression,
				scheduleType: created.scheduleType,
				enabled: created.enabled,
				command: created.command,
				script: created.script,
				serviceName: created.serviceName,
				applicationId: created.applicationId,
				composeId: created.composeId,
				serverId: created.serverId,
				userId: created.userId,
				createdAt: created.createdAt,
			}),
		};
	},
};

const scheduleUpdate: Tool<
	{
		scheduleId: string;
		name?: string;
		cronExpression?: string;
		enabled?: boolean;
		command?: string;
		script?: string | null;
		serviceName?: string | null;
		shellType?: "bash" | "sh";
		confirm: typeof CONFIRM_SCHEDULE_CHANGE;
	},
	ScheduleSummary
> = {
	name: "schedule_update",
	description: "Update a schedule (requires approval + confirm)",
	category: "server",
	parameters: z
		.object({
			scheduleId: z.string().min(1),
			name: z.string().min(1).optional(),
			cronExpression: z.string().min(1).optional(),
			enabled: z.boolean().optional(),
			command: z.string().min(1).optional(),
			script: z.string().nullable().optional(),
			serviceName: z.string().min(1).nullable().optional(),
			shellType: z.enum(["bash", "sh"]).optional(),
			confirm: z.literal(CONFIRM_SCHEDULE_CHANGE),
		})
		.superRefine((v, ctx2) => {
			const hasAny =
				v.name !== undefined ||
				v.cronExpression !== undefined ||
				v.enabled !== undefined ||
				v.command !== undefined ||
				v.script !== undefined ||
				v.serviceName !== undefined ||
				v.shellType !== undefined;
			if (!hasAny) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "At least one field must be provided to update",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const current = await findScheduleById(params.scheduleId);
		const denied = await ensureScheduleAccess(current, ctx);
		if (denied) {
			return {
				success: false,
				message: denied.message,
				error: denied.error,
				data: toSummary({
					scheduleId: params.scheduleId,
					name: "",
					cronExpression: "",
					scheduleType: "application",
					enabled: false,
					command: "",
					script: null,
					serviceName: null,
					applicationId: null,
					composeId: null,
					serverId: null,
					userId: null,
					createdAt: "",
				}),
			};
		}

		const { confirm: _confirm, ...input } = params;
		const next = await updateSchedule({
			scheduleId: input.scheduleId,
			name: input.name ?? current.name,
			cronExpression: input.cronExpression ?? current.cronExpression,
			appName: current.appName,
			command: input.command ?? current.command,
			script: input.script ?? current.script,
			serviceName:
				current.scheduleType === "compose"
					? (input.serviceName ?? current.serviceName)
					: current.serviceName,
			shellType: input.shellType ?? current.shellType,
			scheduleType: current.scheduleType,
			applicationId: current.applicationId,
			composeId: current.composeId,
			serverId: current.serverId,
			userId: current.userId,
			enabled: input.enabled ?? current.enabled,
			createdAt: current.createdAt,
		});

		if (IS_CLOUD) {
			if (next.enabled) {
				await createCloudJob({
					type: "schedule",
					cronSchedule: next.cronExpression,
					scheduleId: next.scheduleId,
				});
			} else {
				await removeCloudJob({
					type: "schedule",
					cronSchedule: next.cronExpression,
					scheduleId: current.scheduleId,
				});
			}
		} else {
			if (next.enabled) {
				removeScheduleJob(next.scheduleId);
				scheduleJob(next);
			} else {
				removeScheduleJob(next.scheduleId);
			}
		}

		return {
			success: true,
			message: "Schedule updated",
			data: toSummary({
				scheduleId: next.scheduleId,
				name: next.name,
				cronExpression: next.cronExpression,
				scheduleType: next.scheduleType,
				enabled: next.enabled,
				command: next.command,
				script: next.script,
				serviceName: next.serviceName,
				applicationId: next.applicationId,
				composeId: next.composeId,
				serverId: next.serverId,
				userId: next.userId,
				createdAt: next.createdAt,
			}),
		};
	},
};

const scheduleDelete: Tool<
	{ scheduleId: string; confirm: typeof CONFIRM_SCHEDULE_DELETE },
	{ deleted: boolean; scheduleId: string }
> = {
	name: "schedule_delete",
	description: "Delete a schedule (requires approval + confirm)",
	category: "server",
	parameters: z.object({
		scheduleId: z.string().min(1),
		confirm: z.literal(CONFIRM_SCHEDULE_DELETE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const s = await findScheduleById(params.scheduleId);
		const denied = await ensureScheduleAccess(s, ctx);
		if (denied) {
			return {
				success: false,
				message: denied.message,
				error: denied.error,
				data: { deleted: false, scheduleId: params.scheduleId },
			};
		}

		await deleteSchedule(params.scheduleId);

		if (IS_CLOUD) {
			await removeCloudJob({
				type: "schedule",
				cronSchedule: s.cronExpression,
				scheduleId: s.scheduleId,
			});
		} else {
			removeScheduleJob(s.scheduleId);
		}

		return {
			success: true,
			message: "Schedule deleted",
			data: { deleted: true, scheduleId: s.scheduleId },
		};
	},
};

const scheduleRunManually: Tool<
	{ scheduleId: string; confirm: typeof CONFIRM_SCHEDULE_RUN },
	{ started: boolean }
> = {
	name: "schedule_run_manually",
	description: "Run a schedule immediately (requires approval + confirm)",
	category: "server",
	parameters: z.object({
		scheduleId: z.string().min(1),
		confirm: z.literal(CONFIRM_SCHEDULE_RUN),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const s = await findScheduleById(params.scheduleId);
		const denied = await ensureScheduleAccess(s, ctx);
		if (denied) {
			return {
				success: false,
				message: denied.message,
				error: denied.error,
				data: { started: false },
			};
		}

		await runCommand(params.scheduleId);
		return {
			success: true,
			message: "Schedule started",
			data: { started: true },
		};
	},
};

export function registerScheduleTools() {
	toolRegistry.register(scheduleList);
	toolRegistry.register(scheduleGet);
	toolRegistry.register(scheduleCreate);
	toolRegistry.register(scheduleUpdate);
	toolRegistry.register(scheduleDelete);
	toolRegistry.register(scheduleRunManually);
}

import { IS_CLOUD, paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	apiAssignDomain,
	apiEnableDashboard,
	apiModifyTraefikConfig,
	apiReadStatsLogs,
	apiReadTraefikConfig,
	apiSaveSSHKey,
	apiServerSchema,
	apiTraefikConfig,
	apiUpdateDockerCleanup,
	projects,
	server as serverTable,
} from "@dokploy/server/db/schema";
import {
	findOrganizationById,
	findUserById,
} from "@dokploy/server/services/admin";
import {
	findServerById,
	updateServerById,
} from "@dokploy/server/services/server";
import {
	DEFAULT_UPDATE_DATA,
	getDokployImage,
	getDokployImageTag,
	getUpdateData,
	pullLatestRelease,
	readDirectory,
	readEnvironmentVariables,
	readPorts,
	reloadDockerResource,
	writeTraefikSetup,
} from "@dokploy/server/services/settings";
import {
	canAccessToTraefikFiles,
	findMemberById,
	updateUser,
} from "@dokploy/server/services/user";
import {
	getLogCleanupStatus,
	startLogCleanup,
	stopLogCleanup,
} from "@dokploy/server/utils/access-log/handler";
import {
	parseRawConfig,
	processLogs,
} from "@dokploy/server/utils/access-log/utils";
import {
	cleanStoppedContainers,
	cleanUpDockerBuilder,
	cleanUpSystemPrune,
	cleanUpUnusedImages,
	cleanUpUnusedVolumes,
	prepareEnvironmentVariables,
} from "@dokploy/server/utils/docker/utils";
import { recreateDirectory } from "@dokploy/server/utils/filesystem/directory";
import {
	checkGPUStatus,
	setupGPUSupport,
} from "@dokploy/server/utils/gpu-setup";
import { sendDockerCleanupNotifications } from "@dokploy/server/utils/notifications/docker-cleanup";
import { execAsync } from "@dokploy/server/utils/process/execAsync";
import { spawnAsync } from "@dokploy/server/utils/process/spawnAsync";
import {
	readConfig,
	readConfigInPath,
	readMonitoringConfig,
	writeConfig,
	writeTraefikConfigInPath,
} from "@dokploy/server/utils/traefik/application";
import {
	readMainConfig,
	updateLetsEncryptEmail,
	updateServerTraefik,
	writeMainConfig,
} from "@dokploy/server/utils/traefik/web-server";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { parse, stringify } from "yaml";
import { z } from "zod";
import packageInfo from "../../../../package.json";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

const CONFIRM_SETTINGS_CHANGE = "CONFIRM_SETTINGS_CHANGE" as const;
const CONFIRM_SETTINGS_MAINTENANCE = "CONFIRM_SETTINGS_MAINTENANCE" as const;
const CONFIRM_SETTINGS_UPDATE = "CONFIRM_SETTINGS_UPDATE" as const;

type UpdateData = {
	latestVersion: string | null;
	updateAvailable: boolean;
};

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
		return accessDenied("Only organization owner can manage settings", data);
	}
	return null;
};

const ensureServerAccess = async (ctx: ToolContext, serverId: string) => {
	const srv = await findServerById(serverId);
	if (srv.organizationId !== ctx.organizationId) {
		throw new Error("Server access denied");
	}
};

const cloudJobCreate = async (input: {
	cronSchedule: string;
	serverId: string;
	type: "server";
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
	if (!res.ok) throw new Error(`Failed to schedule cloud job (${res.status})`);
};

const cloudJobRemove = async (input: {
	cronSchedule: string;
	serverId: string;
	type: "server";
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
	if (!res.ok) throw new Error(`Failed to remove cloud job (${res.status})`);
};

const requireTraefikFilesAccess = async (ctx: ToolContext) => {
	const m = await findMemberById(ctx.userId, ctx.organizationId);
	if (m.role !== "member") return;
	const canAccess = await canAccessToTraefikFiles(
		ctx.userId,
		ctx.organizationId,
	);
	if (!canAccess) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

const listEnvKeysFromText = (envText: string | null): string[] => {
	const raw = envText ?? "";
	const keys = new Set<string>();
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		keys.add(line.slice(0, idx).trim());
	}
	return [...keys].sort();
};

const settingsIsCloud: Tool<Record<string, never>, boolean> = {
	name: "settings_is_cloud",
	description: "Check whether this Dokploy instance is running in cloud mode.",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		return { success: true, message: "Cloud status", data: IS_CLOUD };
	},
};

const settingsReloadServer: Tool<
	{ confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_reload_server",
	description:
		"Reload Dokploy server docker resource (dokploy). Not supported on Cloud.",
	category: "settings",
	parameters: z.object({
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: reload is handled by platform",
				data: true,
			};
		}
		await reloadDockerResource("dokploy");
		return { success: true, message: "Dokploy reloaded", data: true };
	},
};

const settingsUpdateTagsUrlGet: Tool<Record<string, never>, string | null> = {
	name: "settings_update_tags_url_get",
	description: "Get the current user's update tags URL (non-cloud only).",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		if (IS_CLOUD)
			return { success: true, message: "Cloud: not used", data: null };
		const user = await findUserById(ctx.userId);
		return {
			success: true,
			message: "Update tags URL retrieved",
			data: user.updateTagsUrl ?? null,
		};
	},
};

const settingsUpdateTagsUrlSet: Tool<{ tagsUrl: string | null }, boolean> = {
	name: "settings_update_tags_url_set",
	description: "Set the current user's update tags URL (non-cloud only).",
	category: "settings",
	parameters: z.object({
		tagsUrl: z.string().trim().url().nullable(),
	}),
	riskLevel: "medium",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (IS_CLOUD)
			return { success: true, message: "Cloud: not used", data: true };
		await updateUser(ctx.userId, { updateTagsUrl: params.tagsUrl });
		return { success: true, message: "Update tags URL updated", data: true };
	},
};

const settingsCleanRedis: Tool<
	{ confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_redis",
	description: "Flush all Redis keys for Dokploy (non-cloud only).",
	category: "settings",
	parameters: z.object({
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: Redis is managed by platform",
				data: true,
			};
		}

		const { stdout: containerId } = await execAsync(
			`docker ps --filter "name=dokploy-redis" --filter "status=running" -q | head -n 1`,
		);
		if (!containerId.trim()) {
			return {
				success: false,
				message: "Redis container not found",
				error: "NOT_FOUND",
				data: false,
			};
		}
		await execAsync(`docker exec -i ${containerId.trim()} redis-cli flushall`);
		return { success: true, message: "Redis cleaned", data: true };
	},
};

const settingsReloadRedis: Tool<
	{ confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_reload_redis",
	description: "Reload dokploy-redis docker resource (non-cloud only).",
	category: "settings",
	parameters: z.object({
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: Redis is managed by platform",
				data: true,
			};
		}
		await reloadDockerResource("dokploy-redis");
		return { success: true, message: "Redis reloaded", data: true };
	},
};

const settingsReloadTraefik: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_reload_traefik",
	description: "Reload dokploy-traefik docker resource.",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		try {
			await reloadDockerResource("dokploy-traefik", params.serverId);
			return { success: true, message: "Traefik reloaded", data: true };
		} catch (error) {
			return {
				success: false,
				message: "Failed to reload Traefik",
				error: error instanceof Error ? error.message : String(error),
				data: false,
			};
		}
	},
};

const settingsToggleTraefikDashboard: Tool<
	z.infer<typeof apiEnableDashboard> & {
		confirm: typeof CONFIRM_SETTINGS_CHANGE;
	},
	boolean
> = {
	name: "settings_toggle_traefik_dashboard",
	description: "Enable/disable Traefik dashboard port (8080).",
	category: "settings",
	parameters: apiEnableDashboard.extend({
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);

		const ports = await readPorts("dokploy-traefik", params.serverId);
		const env = await readEnvironmentVariables(
			"dokploy-traefik",
			params.serverId,
		);
		const preparedEnv = prepareEnvironmentVariables(env);

		let newPorts = ports;
		if (params.enableDashboard) {
			if (!newPorts.some((p) => p.targetPort === 8080)) {
				newPorts = [
					...newPorts,
					{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
				];
			}
		} else {
			newPorts = ports.filter((p) => p.targetPort !== 8080);
		}

		await writeTraefikSetup({
			env: preparedEnv,
			additionalPorts: newPorts,
			serverId: params.serverId,
		});
		return { success: true, message: "Traefik dashboard updated", data: true };
	},
};

const settingsGetDokployVersion: Tool<Record<string, never>, string> = {
	name: "settings_get_dokploy_version",
	description: "Get current Dokploy server version.",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		return {
			success: true,
			message: "Dokploy version",
			data: packageInfo.version,
		};
	},
};

const settingsGetReleaseTag: Tool<Record<string, never>, string> = {
	name: "settings_get_release_tag",
	description: "Get Dokploy docker release tag (RELEASE_TAG or latest).",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		return {
			success: true,
			message: "Release tag",
			data: getDokployImageTag(),
		};
	},
};

const settingsGetUpdateData: Tool<{ tagsUrl?: string | null }, UpdateData> = {
	name: "settings_get_update_data",
	description: "Check if a Dokploy update is available (non-cloud only).",
	category: "settings",
	parameters: z.object({
		tagsUrl: z.string().trim().url().nullable().optional(),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: updates managed by platform",
				data: DEFAULT_UPDATE_DATA,
			};
		}
		const user = await findUserById(ctx.userId);
		const data = await getUpdateData(params.tagsUrl ?? user.updateTagsUrl);
		return { success: true, message: "Update data", data };
	},
};

const settingsUpdateServer: Tool<
	{ confirm: typeof CONFIRM_SETTINGS_UPDATE },
	boolean
> = {
	name: "settings_update_server",
	description:
		"Pull latest Dokploy image and force update the dokploy service (non-cloud only).",
	category: "settings",
	parameters: z.object({
		confirm: z.literal(CONFIRM_SETTINGS_UPDATE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: updates managed by platform",
				data: true,
			};
		}
		await pullLatestRelease();
		void spawnAsync("docker", [
			"service",
			"update",
			"--force",
			"--image",
			getDokployImage(),
			"dokploy",
		]);
		return { success: true, message: "Update triggered", data: true };
	},
};

const settingsReadTraefikConfig: Tool<Record<string, never>, string | null> = {
	name: "settings_read_traefik_config",
	description: "Read main Traefik config (traefik.yml).",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, null);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: null,
			};
		}
		return {
			success: true,
			message: "Traefik config read",
			data: readMainConfig(),
		};
	},
};

const settingsUpdateTraefikConfig: Tool<
	z.infer<typeof apiTraefikConfig> & {
		confirm: typeof CONFIRM_SETTINGS_CHANGE;
	},
	boolean
> = {
	name: "settings_update_traefik_config",
	description:
		"Update main Traefik config (traefik.yml). Requires approval + confirm.",
	category: "settings",
	parameters: apiTraefikConfig.extend({
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		}
		const { confirm: _confirm, ...rest } = params;
		writeMainConfig(rest.traefikConfig);
		return { success: true, message: "Traefik config updated", data: true };
	},
};

const settingsReadWebServerTraefikConfig: Tool<
	Record<string, never>,
	string | null
> = {
	name: "settings_read_webserver_traefik_config",
	description: "Read Dokploy webserver Traefik config (dokploy.yml).",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, null);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: null,
			};
		}
		return {
			success: true,
			message: "Webserver Traefik config read",
			data: readConfig("dokploy"),
		};
	},
};

const settingsUpdateWebServerTraefikConfig: Tool<
	z.infer<typeof apiTraefikConfig> & {
		confirm: typeof CONFIRM_SETTINGS_CHANGE;
	},
	boolean
> = {
	name: "settings_update_webserver_traefik_config",
	description:
		"Update Dokploy webserver Traefik config. Requires approval + confirm.",
	category: "settings",
	parameters: apiTraefikConfig.extend({
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		}
		const { confirm: _confirm, ...rest } = params;
		writeConfig("dokploy", rest.traefikConfig);
		return {
			success: true,
			message: "Webserver Traefik config updated",
			data: true,
		};
	},
};

const settingsReadMiddlewareTraefikConfig: Tool<
	Record<string, never>,
	string | null
> = {
	name: "settings_read_middleware_traefik_config",
	description: "Read middleware Traefik config (middlewares.yml).",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, null);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: null,
			};
		}
		return {
			success: true,
			message: "Middleware Traefik config read",
			data: readConfig("middlewares"),
		};
	},
};

const settingsUpdateMiddlewareTraefikConfig: Tool<
	z.infer<typeof apiTraefikConfig> & {
		confirm: typeof CONFIRM_SETTINGS_CHANGE;
	},
	boolean
> = {
	name: "settings_update_middleware_traefik_config",
	description: "Update middleware Traefik config. Requires approval + confirm.",
	category: "settings",
	parameters: apiTraefikConfig.extend({
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		}
		const { confirm: _confirm, ...rest } = params;
		writeConfig("middlewares", rest.traefikConfig);
		return {
			success: true,
			message: "Middleware Traefik config updated",
			data: true,
		};
	},
};

const settingsReadDirectories: Tool<
	z.infer<typeof apiServerSchema>,
	unknown[]
> = {
	name: "settings_read_directories",
	description:
		"List Traefik directory tree (respects member Traefik permission).",
	category: "settings",
	parameters: apiServerSchema,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		await requireTraefikFilesAccess(ctx);
		const serverId = params?.serverId;
		if (serverId) await ensureServerAccess(ctx, serverId);
		const { MAIN_TRAEFIK_PATH } = paths(!!serverId);
		const result = await readDirectory(MAIN_TRAEFIK_PATH, serverId);
		return {
			success: true,
			message: "Directories read",
			data: (result || []) as unknown[],
		};
	},
};

const settingsReadTraefikFile: Tool<
	z.infer<typeof apiReadTraefikConfig>,
	string | null
> = {
	name: "settings_read_traefik_file",
	description: "Read a Traefik file (respects member Traefik permission).",
	category: "settings",
	parameters: apiReadTraefikConfig,
	riskLevel: "medium",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		await requireTraefikFilesAccess(ctx);
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		const content = await readConfigInPath(params.path, params.serverId);
		return {
			success: true,
			message: "Traefik file read",
			data: content,
		};
	},
};

const settingsUpdateTraefikFile: Tool<
	z.infer<typeof apiModifyTraefikConfig> & {
		confirm: typeof CONFIRM_SETTINGS_CHANGE;
	},
	boolean
> = {
	name: "settings_update_traefik_file",
	description:
		"Write a Traefik file (respects member Traefik permission). Requires approval + confirm.",
	category: "settings",
	parameters: apiModifyTraefikConfig.extend({
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		await requireTraefikFilesAccess(ctx);
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		const { confirm: _confirm, ...rest } = params;
		await writeTraefikConfigInPath(
			rest.path,
			rest.traefikConfig,
			rest.serverId,
		);
		return { success: true, message: "Traefik file updated", data: true };
	},
};

const settingsTraefikEnvKeys: Tool<
	z.infer<typeof apiServerSchema>,
	{ keys: string[]; total: number }
> = {
	name: "settings_read_traefik_env_keys",
	description: "List Traefik env variable keys only (values are not returned).",
	category: "settings",
	parameters: apiServerSchema,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { keys: [], total: 0 });
		if (denied) return denied;
		const serverId = params?.serverId;
		if (serverId) await ensureServerAccess(ctx, serverId);
		const envVars = await readEnvironmentVariables("dokploy-traefik", serverId);
		const keys = listEnvKeysFromText(envVars);
		return {
			success: true,
			message: `Found ${keys.length} key(s)`,
			data: { keys, total: keys.length },
		};
	},
};

const settingsReadTraefikEnv: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_CHANGE },
	string
> = {
	name: "settings_read_traefik_env",
	description: "Reveal Traefik env variables (requires approval + confirm).",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, "");
		if (denied) return denied;
		const serverId = params.serverId;
		if (serverId) await ensureServerAccess(ctx, serverId);
		const { confirm: _confirm } = params;
		const envVars = await readEnvironmentVariables("dokploy-traefik", serverId);
		return {
			success: true,
			message: "Traefik env",
			data: envVars,
		};
	},
};

const settingsWriteTraefikEnv: Tool<
	{ env: string; serverId?: string; confirm: typeof CONFIRM_SETTINGS_CHANGE },
	boolean
> = {
	name: "settings_write_traefik_env",
	description:
		"Write Traefik env variables (requires approval + confirm). Preserves existing ports.",
	category: "settings",
	parameters: z.object({
		env: z.string(),
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD && !params.serverId) {
			return {
				success: false,
				message: "Cloud requires serverId",
				error: "BAD_REQUEST",
				data: false,
			};
		}
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		const envs = prepareEnvironmentVariables(params.env);
		const ports = await readPorts("dokploy-traefik", params.serverId);
		await writeTraefikSetup({
			env: envs,
			additionalPorts: ports,
			serverId: params.serverId,
		});
		return { success: true, message: "Traefik env updated", data: true };
	},
};

const settingsGetIp: Tool<Record<string, never>, string | null> = {
	name: "settings_get_ip",
	description: "Get Dokploy server IP (non-cloud only).",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: server IP is not exposed",
				data: null,
			};
		}
		const org = await findOrganizationById(ctx.organizationId);
		const ownerId = org?.ownerId;
		if (!ownerId) {
			return {
				success: false,
				message: "Organization owner not found",
				error: "NOT_FOUND",
				data: null,
			};
		}
		const owner = await findUserById(ownerId);
		return {
			success: true,
			message: "Server IP",
			data: owner.serverIp ?? null,
		};
	},
};

const settingsIsUserSubscribed: Tool<Record<string, never>, boolean> = {
	name: "settings_is_user_subscribed",
	description:
		"Check whether the current organization has any servers or projects.",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		const haveServers = await db.query.server.findMany({
			where: eq(serverTable.organizationId, ctx.organizationId),
		});
		const haveProjects = await db.query.projects.findMany({
			where: eq(projects.organizationId, ctx.organizationId),
		});
		return {
			success: true,
			message: "Subscription status",
			data: haveServers.length > 0 || haveProjects.length > 0,
		};
	},
};

const settingsHealth: Tool<Record<string, never>, { status: string }> = {
	name: "settings_health",
	description: "Health check for Dokploy database connectivity.",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		if (IS_CLOUD) {
			await db.execute(sql`SELECT 1`);
			return { success: true, message: "Health ok", data: { status: "ok" } };
		}
		return {
			success: true,
			message: "Not cloud",
			data: { status: "not_cloud" },
		};
	},
};

const settingsGetDokployCloudIps: Tool<Record<string, never>, string[]> = {
	name: "settings_get_dokploy_cloud_ips",
	description: "Get Dokploy Cloud IP allowlist (cloud only).",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, []);
		if (denied) return denied;
		if (!IS_CLOUD) {
			return { success: true, message: "Not cloud", data: [] };
		}
		const ips = process.env.DOKPLOY_CLOUD_IPS?.split(",");
		return {
			success: true,
			message: "Cloud IPs",
			data: ips ?? [],
		};
	},
};

const settingsHaveTraefikDashboardPortEnabled: Tool<
	z.infer<typeof apiServerSchema>,
	boolean
> = {
	name: "settings_have_traefik_dashboard_port_enabled",
	description: "Check if Traefik dashboard port (8080) is enabled.",
	category: "settings",
	parameters: apiServerSchema,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		const serverId = params?.serverId;
		if (serverId) await ensureServerAccess(ctx, serverId);
		try {
			const ports = await readPorts("dokploy-traefik", serverId);
			return {
				success: true,
				message: "Traefik dashboard port status",
				data: ports.some((p) => p.targetPort === 8080),
			};
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "Resource type not found"
			) {
				return {
					success: true,
					message: "Traefik not found",
					data: false,
				};
			}
			throw error;
		}
	},
};

const settingsDockerCleanupUnusedImages: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_unused_images",
	description: "Remove unused Docker images.",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		await cleanUpUnusedImages(params.serverId);
		return { success: true, message: "Unused images cleaned", data: true };
	},
};

const settingsDockerCleanupUnusedVolumes: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_unused_volumes",
	description: "Remove unused Docker volumes.",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		await cleanUpUnusedVolumes(params.serverId);
		return { success: true, message: "Unused volumes cleaned", data: true };
	},
};

const settingsDockerCleanupStoppedContainers: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_stopped_containers",
	description: "Remove stopped Docker containers.",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		await cleanStoppedContainers(params.serverId);
		return { success: true, message: "Stopped containers cleaned", data: true };
	},
};

const settingsDockerCleanupBuilder: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_docker_builder",
	description: "Clean Docker builder cache.",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		await cleanUpDockerBuilder(params.serverId);
		return { success: true, message: "Docker builder cleaned", data: true };
	},
};

const settingsDockerCleanupPrune: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_docker_prune",
	description: "Run docker system prune and builder prune.",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		await cleanUpSystemPrune(params.serverId);
		await cleanUpDockerBuilder(params.serverId);
		return { success: true, message: "Docker pruned", data: true };
	},
};

const settingsDockerCleanupAll: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_all",
	description:
		"Run full Docker cleanup (images, stopped containers, builder, prune).",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		await cleanUpUnusedImages(params.serverId);
		await cleanStoppedContainers(params.serverId);
		await cleanUpDockerBuilder(params.serverId);
		await cleanUpSystemPrune(params.serverId);
		return { success: true, message: "Docker cleanup completed", data: true };
	},
};

const settingsCleanMonitoring: Tool<
	{ confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_monitoring",
	description: "Remove monitoring data directory (non-cloud only).",
	category: "settings",
	parameters: z.object({
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		}
		const { MONITORING_PATH } = paths();
		await recreateDirectory(MONITORING_PATH);
		return { success: true, message: "Monitoring cleaned", data: true };
	},
};

const settingsSaveSshPrivateKey: Tool<
	z.infer<typeof apiSaveSSHKey> & { confirm: typeof CONFIRM_SETTINGS_CHANGE },
	boolean
> = {
	name: "settings_save_ssh_private_key",
	description: "Save Dokploy SSH private key (non-cloud only).",
	category: "settings",
	parameters: apiSaveSSHKey.extend({
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		}
		const { confirm: _confirm, ...rest } = params;
		await updateUser(ctx.userId, { sshPrivateKey: rest.sshPrivateKey });
		return { success: true, message: "SSH private key saved", data: true };
	},
};

const settingsCleanSshPrivateKey: Tool<
	{ confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	boolean
> = {
	name: "settings_clean_ssh_private_key",
	description: "Remove Dokploy SSH private key (non-cloud only).",
	category: "settings",
	parameters: z.object({
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (_params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		}
		await updateUser(ctx.userId, { sshPrivateKey: null });
		return { success: true, message: "SSH private key removed", data: true };
	},
};

const settingsAssignDomainServer: Tool<
	z.infer<typeof apiAssignDomain> & { confirm: typeof CONFIRM_SETTINGS_CHANGE },
	unknown
> = {
	name: "settings_assign_domain_server",
	description:
		"Assign host / HTTPS / Let's Encrypt settings for Dokploy webserver (non-cloud only).",
	category: "settings",
	parameters: apiAssignDomain.extend({
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, null);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		}

		const { confirm: _confirm, ...input } = params;
		const user = await updateUser(ctx.userId, {
			host: input.host,
			...(input.letsEncryptEmail && {
				letsEncryptEmail: input.letsEncryptEmail,
			}),
			certificateType: input.certificateType,
			https: input.https,
		});
		if (!user) {
			return {
				success: false,
				message: "User not found",
				error: "NOT_FOUND",
				data: null,
			};
		}
		updateServerTraefik(user, input.host);
		if (input.letsEncryptEmail) {
			updateLetsEncryptEmail(input.letsEncryptEmail);
		}
		return { success: true, message: "Domain updated", data: user };
	},
};

const settingsUpdateDockerCleanup: Tool<
	z.infer<typeof apiUpdateDockerCleanup> & {
		confirm: typeof CONFIRM_SETTINGS_CHANGE;
	},
	boolean
> = {
	name: "settings_update_docker_cleanup",
	description:
		"Enable/disable Docker cleanup cron (server or local). Requires approval + confirm.",
	category: "settings",
	parameters: apiUpdateDockerCleanup.extend({
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		const { confirm: _confirm, ...input } = params;

		if (input.serverId) {
			await ensureServerAccess(ctx, input.serverId);
			await updateServerById(input.serverId, {
				enableDockerCleanup: input.enableDockerCleanup,
			});

			const server = await findServerById(input.serverId);
			if (server.serverStatus === "inactive" && input.enableDockerCleanup) {
				return {
					success: false,
					message: "Server is inactive",
					error: "NOT_FOUND",
					data: false,
				};
			}

			if (server.enableDockerCleanup) {
				if (IS_CLOUD) {
					await cloudJobCreate({
						cronSchedule: "0 0 * * *",
						serverId: input.serverId,
						type: "server",
					});
				} else {
					scheduleJob(server.serverId, "0 0 * * *", async () => {
						await cleanUpUnusedImages(server.serverId);
						await cleanUpDockerBuilder(server.serverId);
						await cleanUpSystemPrune(server.serverId);
						await sendDockerCleanupNotifications(server.organizationId);
					});
				}
			} else {
				if (IS_CLOUD) {
					await cloudJobRemove({
						cronSchedule: "0 0 * * *",
						serverId: input.serverId,
						type: "server",
					});
				} else {
					const currentJob = scheduledJobs[server.serverId];
					currentJob?.cancel();
				}
			}
			return {
				success: true,
				message: "Docker cleanup schedule updated",
				data: true,
			};
		}

		if (!IS_CLOUD) {
			const userUpdated = await updateUser(ctx.userId, {
				enableDockerCleanup: input.enableDockerCleanup,
			});
			if (userUpdated?.enableDockerCleanup) {
				scheduleJob("docker-cleanup", "0 0 * * *", async () => {
					await cleanUpUnusedImages();
					await cleanUpDockerBuilder();
					await cleanUpSystemPrune();
					await sendDockerCleanupNotifications(ctx.organizationId);
				});
			} else {
				const currentJob = scheduledJobs["docker-cleanup"];
				currentJob?.cancel();
			}
		}

		return {
			success: true,
			message: "Docker cleanup schedule updated",
			data: true,
		};
	},
};

const settingsReadStatsLogs: Tool<z.infer<typeof apiReadStatsLogs>, unknown> = {
	name: "settings_read_stats_logs",
	description: "Read access logs (paginated/filterable).",
	category: "settings",
	parameters: apiReadStatsLogs,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: stats are not available",
				data: { data: [], totalCount: 0 },
			};
		}
		const rawConfig = await readMonitoringConfig(
			!!params.dateRange?.start && !!params.dateRange?.end,
		);
		const parsedConfig = parseRawConfig(
			rawConfig as string,
			params.page,
			params.sort,
			params.search,
			params.status,
			params.dateRange,
		);
		return { success: true, message: "Stats logs", data: parsedConfig };
	},
};

const settingsReadStats: Tool<
	{ dateRange?: { start?: string; end?: string } },
	unknown[]
> = {
	name: "settings_read_stats",
	description: "Read aggregated access stats (owner-only).",
	category: "settings",
	parameters: z.object({
		dateRange: z
			.object({ start: z.string().optional(), end: z.string().optional() })
			.optional(),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, [] as unknown[]);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: stats are not available",
				data: [],
			};
		}
		const rawConfig = await readMonitoringConfig(
			!!params.dateRange?.start || !!params.dateRange?.end,
		);
		const processed = processLogs(rawConfig as string, params.dateRange);
		return {
			success: true,
			message: "Stats",
			data: (processed || []) as unknown[],
		};
	},
};

const settingsHaveActivateRequests: Tool<Record<string, never>, boolean> = {
	name: "settings_have_activate_requests",
	description: "Check if Traefik access log is enabled (non-cloud only).",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		if (IS_CLOUD)
			return { success: true, message: "Cloud: always true", data: true };
		const config = readMainConfig();
		if (!config) return { success: true, message: "No config", data: false };
		const parsed = parse(config) as { accessLog?: { filePath: string } };
		return {
			success: true,
			message: "Request logging status",
			data: Boolean(parsed?.accessLog?.filePath),
		};
	},
};

const settingsToggleRequests: Tool<
	{ enable: boolean; confirm: typeof CONFIRM_SETTINGS_CHANGE },
	boolean
> = {
	name: "settings_toggle_requests",
	description: "Enable/disable Traefik access logs (non-cloud only).",
	category: "settings",
	parameters: z.object({
		enable: z.boolean(),
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD)
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		const mainConfig = readMainConfig();
		if (!mainConfig) {
			return {
				success: false,
				message: "Main config not found",
				error: "NOT_FOUND",
				data: false,
			};
		}

		const currentConfig = parse(mainConfig) as {
			accessLog?: {
				filePath: string;
				format?: string;
				bufferingSize?: number;
				filters?: Record<string, unknown>;
			};
		};

		if (params.enable) {
			currentConfig.accessLog = {
				filePath: "/etc/dokploy/traefik/dynamic/access.log",
				format: "json",
				bufferingSize: 100,
				filters: {
					retryAttempts: true,
					minDuration: "10ms",
				},
			};
		} else {
			currentConfig.accessLog = undefined;
		}

		writeMainConfig(stringify(currentConfig));
		return { success: true, message: "Request logging updated", data: true };
	},
};

const settingsSetupGpu: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_SETTINGS_MAINTENANCE },
	{ success: boolean }
> = {
	name: "settings_setup_gpu",
	description: "Enable GPU support (requires approval + confirm).",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		confirm: z.literal(CONFIRM_SETTINGS_MAINTENANCE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, { success: false });
		if (denied) return denied;
		if (IS_CLOUD && !params.serverId) {
			return {
				success: false,
				message: "Select a server to enable the GPU Setup",
				error: "BAD_REQUEST",
				data: { success: false },
			};
		}
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		await setupGPUSupport(params.serverId);
		return {
			success: true,
			message: "GPU setup completed",
			data: { success: true },
		};
	},
};

const settingsCheckGpuStatus: Tool<{ serverId?: string }, unknown> = {
	name: "settings_check_gpu_status",
	description: "Check GPU status.",
	category: "settings",
	parameters: z.object({ serverId: z.string().optional() }),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, {});
		if (denied) return denied;
		if (IS_CLOUD && !params.serverId) {
			return {
				success: true,
				message: "Cloud: serverId required",
				data: {
					driverInstalled: false,
					driverVersion: undefined,
					gpuModel: undefined,
					runtimeInstalled: false,
					runtimeConfigured: false,
					cudaSupport: undefined,
					cudaVersion: undefined,
					memoryInfo: undefined,
					availableGPUs: 0,
					swarmEnabled: false,
					gpuResources: 0,
				},
			};
		}
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		const data = await checkGPUStatus(params.serverId || "");
		return { success: true, message: "GPU status", data };
	},
};

const settingsUpdateTraefikPorts: Tool<
	{
		serverId?: string;
		additionalPorts: {
			targetPort: number;
			publishedPort: number;
			protocol: "tcp" | "udp" | "sctp";
		}[];
		confirm: typeof CONFIRM_SETTINGS_CHANGE;
	},
	boolean
> = {
	name: "settings_update_traefik_ports",
	description: "Update Traefik published ports.",
	category: "settings",
	parameters: z.object({
		serverId: z.string().optional(),
		additionalPorts: z.array(
			z.object({
				targetPort: z.number(),
				publishedPort: z.number(),
				protocol: z.enum(["tcp", "udp", "sctp"]),
			}),
		),
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD && !params.serverId) {
			return {
				success: false,
				message: "Cloud requires serverId",
				error: "UNAUTHORIZED",
				data: false,
			};
		}
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);
		const env = await readEnvironmentVariables(
			"dokploy-traefik",
			params.serverId,
		);
		const preparedEnv = prepareEnvironmentVariables(env);
		await writeTraefikSetup({
			env: preparedEnv,
			additionalPorts: params.additionalPorts,
			serverId: params.serverId,
		});
		return { success: true, message: "Traefik ports updated", data: true };
	},
};

const settingsGetTraefikPorts: Tool<
	z.infer<typeof apiServerSchema>,
	unknown[]
> = {
	name: "settings_get_traefik_ports",
	description: "Get Traefik ports.",
	category: "settings",
	parameters: apiServerSchema,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, [] as unknown[]);
		if (denied) return denied;
		const serverId = params?.serverId;
		if (serverId) await ensureServerAccess(ctx, serverId);
		try {
			const ports = await readPorts("dokploy-traefik", serverId);
			return {
				success: true,
				message: "Traefik ports",
				data: ports as unknown[],
			};
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "Resource type not found"
			) {
				return { success: true, message: "Traefik not found", data: [] };
			}
			throw error;
		}
	},
};

const settingsUpdateLogCleanup: Tool<
	{ cronExpression: string | null; confirm: typeof CONFIRM_SETTINGS_CHANGE },
	boolean
> = {
	name: "settings_update_log_cleanup",
	description: "Update log cleanup schedule (non-cloud only).",
	category: "settings",
	parameters: z.object({
		cronExpression: z.string().nullable(),
		confirm: z.literal(CONFIRM_SETTINGS_CHANGE),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const denied = await requireOrgOwner(ctx, false);
		if (denied) return denied;
		if (IS_CLOUD) {
			return {
				success: true,
				message: "Cloud: managed by platform",
				data: true,
			};
		}
		if (params.cronExpression) {
			const ok = await startLogCleanup(params.cronExpression);
			return {
				success: true,
				message: "Log cleanup started",
				data: ok,
			};
		}
		const ok = await stopLogCleanup();
		return { success: true, message: "Log cleanup stopped", data: ok };
	},
};

const settingsGetLogCleanupStatus: Tool<Record<string, never>, unknown> = {
	name: "settings_get_log_cleanup_status",
	description: "Get current log cleanup status.",
	category: "settings",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await requireOrgMember(ctx);
		const status = await getLogCleanupStatus();
		return { success: true, message: "Log cleanup status", data: status };
	},
};

export function registerSettingsTools() {
	toolRegistry.register(settingsIsCloud);
	toolRegistry.register(settingsReloadServer);
	toolRegistry.register(settingsUpdateTagsUrlGet);
	toolRegistry.register(settingsUpdateTagsUrlSet);
	toolRegistry.register(settingsCleanRedis);
	toolRegistry.register(settingsReloadRedis);
	toolRegistry.register(settingsReloadTraefik);
	toolRegistry.register(settingsToggleTraefikDashboard);
	toolRegistry.register(settingsGetDokployVersion);
	toolRegistry.register(settingsGetReleaseTag);
	toolRegistry.register(settingsGetUpdateData);
	toolRegistry.register(settingsUpdateServer);
	toolRegistry.register(settingsReadTraefikConfig);
	toolRegistry.register(settingsUpdateTraefikConfig);
	toolRegistry.register(settingsReadWebServerTraefikConfig);
	toolRegistry.register(settingsUpdateWebServerTraefikConfig);
	toolRegistry.register(settingsReadMiddlewareTraefikConfig);
	toolRegistry.register(settingsUpdateMiddlewareTraefikConfig);
	toolRegistry.register(settingsReadDirectories);
	toolRegistry.register(settingsReadTraefikFile);
	toolRegistry.register(settingsUpdateTraefikFile);
	toolRegistry.register(settingsTraefikEnvKeys);
	toolRegistry.register(settingsReadTraefikEnv);
	toolRegistry.register(settingsWriteTraefikEnv);
	toolRegistry.register(settingsHaveTraefikDashboardPortEnabled);
	toolRegistry.register(settingsDockerCleanupUnusedImages);
	toolRegistry.register(settingsDockerCleanupUnusedVolumes);
	toolRegistry.register(settingsDockerCleanupStoppedContainers);
	toolRegistry.register(settingsDockerCleanupBuilder);
	toolRegistry.register(settingsDockerCleanupPrune);
	toolRegistry.register(settingsDockerCleanupAll);
	toolRegistry.register(settingsCleanMonitoring);
	toolRegistry.register(settingsSaveSshPrivateKey);
	toolRegistry.register(settingsCleanSshPrivateKey);
	toolRegistry.register(settingsAssignDomainServer);
	toolRegistry.register(settingsUpdateDockerCleanup);
	toolRegistry.register(settingsReadStatsLogs);
	toolRegistry.register(settingsReadStats);
	toolRegistry.register(settingsHaveActivateRequests);
	toolRegistry.register(settingsToggleRequests);
	toolRegistry.register(settingsSetupGpu);
	toolRegistry.register(settingsCheckGpuStatus);
	toolRegistry.register(settingsUpdateTraefikPorts);
	toolRegistry.register(settingsGetTraefikPorts);
	toolRegistry.register(settingsUpdateLogCleanup);
	toolRegistry.register(settingsGetLogCleanupStatus);
	toolRegistry.register(settingsGetIp);
	toolRegistry.register(settingsIsUserSubscribed);
	toolRegistry.register(settingsHealth);
	toolRegistry.register(settingsGetDokployCloudIps);
}

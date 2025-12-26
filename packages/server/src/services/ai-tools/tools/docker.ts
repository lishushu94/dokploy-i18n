import {
	getConfig,
	getContainers,
	getContainersByAppLabel,
	getContainersByAppNameMatch,
	getServiceContainersByAppName,
	getStackContainersByAppName,
} from "@dokploy/server/services/docker";
import { findServerById } from "@dokploy/server/services/server";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext } from "../types";

const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;

const resolveServerId = (
	paramsServerId: string | undefined,
	ctx: ToolContext,
) => paramsServerId ?? ctx.serverId;

const assertServerAccess = async (serverId: string, organizationId: string) => {
	const server = await findServerById(serverId);
	if (server.organizationId !== organizationId) {
		return {
			ok: false as const,
			error: "UNAUTHORIZED",
		};
	}
	return { ok: true as const };
};

const dockerContainerList: Tool<
	{ serverId?: string },
	Array<{
		containerId: string;
		name: string;
		image: string;
		ports: string;
		state: string;
		status: string;
		serverId?: string | null;
	}>
> = {
	name: "docker_container_list",
	description:
		"List Docker containers (docker ps -a). Optionally specify serverId to target a remote server.",
	category: "server",
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Target serverId (defaults to conversation serverId)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = resolveServerId(params.serverId, ctx);
		if (serverId) {
			const access = await assertServerAccess(serverId, ctx.organizationId);
			if (!access.ok) {
				return {
					success: false,
					message: "Server access denied",
					error: access.error,
					data: [],
				};
			}
		}

		try {
			const containers = await getContainers(serverId ?? null);
			return {
				success: true,
				message: `Found ${containers?.length ?? 0} container(s)`,
				data: containers ?? [],
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to list containers",
				error: msg,
				data: [],
			};
		}
	},
};

const dockerContainerConfigGet: Tool<
	{ containerId: string; serverId?: string },
	unknown
> = {
	name: "docker_container_config_get",
	description:
		"Get Docker container config (docker inspect). Optionally specify serverId to target a remote server.",
	category: "server",
	parameters: z.object({
		containerId: z
			.string()
			.min(1)
			.regex(containerIdRegex, "Invalid container id."),
		serverId: z
			.string()
			.optional()
			.describe("Target serverId (defaults to conversation serverId)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = resolveServerId(params.serverId, ctx);
		if (serverId) {
			const access = await assertServerAccess(serverId, ctx.organizationId);
			if (!access.ok) {
				return {
					success: false,
					message: "Server access denied",
					error: access.error,
					data: null,
				};
			}
		}

		try {
			const config = await getConfig(params.containerId, serverId ?? null);
			return {
				success: true,
				message: "Container config retrieved",
				data: config ?? null,
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to get container config",
				error: msg,
				data: null,
			};
		}
	},
};

const dockerContainerListByAppNameMatch: Tool<
	{
		appType?: "stack" | "docker-compose";
		appName: string;
		serverId?: string;
	},
	Array<{ containerId: string; name: string; state: string }>
> = {
	name: "docker_container_list_by_app_name_match",
	description:
		"Find containers by app name match (stack or docker-compose). Optionally specify serverId.",
	category: "server",
	parameters: z.object({
		appType: z
			.union([z.literal("stack"), z.literal("docker-compose")])
			.optional()
			.describe("Optional app type hint"),
		appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
		serverId: z
			.string()
			.optional()
			.describe("Target serverId (defaults to conversation serverId)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = resolveServerId(params.serverId, ctx);
		if (serverId) {
			const access = await assertServerAccess(serverId, ctx.organizationId);
			if (!access.ok) {
				return {
					success: false,
					message: "Server access denied",
					error: access.error,
					data: [],
				};
			}
		}

		try {
			const containers = await getContainersByAppNameMatch(
				params.appName,
				params.appType,
				serverId,
			);
			return {
				success: true,
				message: `Found ${containers?.length ?? 0} container(s)`,
				data: containers ?? [],
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to find containers",
				error: msg,
				data: [],
			};
		}
	},
};

const dockerContainerListByAppLabel: Tool<
	{ appName: string; serverId?: string; type: "standalone" | "swarm" },
	Array<{ containerId: string; name: string; state: string }>
> = {
	name: "docker_container_list_by_app_label",
	description:
		"List containers by app label (standalone or swarm). Optionally specify serverId.",
	category: "server",
	parameters: z.object({
		appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
		serverId: z
			.string()
			.optional()
			.describe("Target serverId (defaults to conversation serverId)"),
		type: z.enum(["standalone", "swarm"]),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = resolveServerId(params.serverId, ctx);
		if (serverId) {
			const access = await assertServerAccess(serverId, ctx.organizationId);
			if (!access.ok) {
				return {
					success: false,
					message: "Server access denied",
					error: access.error,
					data: [],
				};
			}
		}

		try {
			const containers = await getContainersByAppLabel(
				params.appName,
				params.type,
				serverId,
			);
			return {
				success: true,
				message: `Found ${containers?.length ?? 0} container(s)`,
				data: containers ?? [],
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to list containers",
				error: msg,
				data: [],
			};
		}
	},
};

const dockerStackContainersByAppName: Tool<
	{ appName: string; serverId?: string },
	Array<{ containerId: string; name: string; state: string; node: string }>
> = {
	name: "docker_stack_containers_by_app_name",
	description:
		"List Docker stack containers by app name. Optionally specify serverId.",
	category: "server",
	parameters: z.object({
		appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
		serverId: z
			.string()
			.optional()
			.describe("Target serverId (defaults to conversation serverId)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = resolveServerId(params.serverId, ctx);
		if (serverId) {
			const access = await assertServerAccess(serverId, ctx.organizationId);
			if (!access.ok) {
				return {
					success: false,
					message: "Server access denied",
					error: access.error,
					data: [],
				};
			}
		}

		try {
			const containers = await getStackContainersByAppName(
				params.appName,
				serverId,
			);
			return {
				success: true,
				message: `Found ${containers?.length ?? 0} container(s)`,
				data: containers ?? [],
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to list stack containers",
				error: msg,
				data: [],
			};
		}
	},
};

const dockerServiceContainersByAppName: Tool<
	{ appName: string; serverId?: string },
	Array<{ containerId: string; name: string; state: string; node: string }>
> = {
	name: "docker_service_containers_by_app_name",
	description:
		"List Docker service containers by service name. Optionally specify serverId.",
	category: "server",
	parameters: z.object({
		appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
		serverId: z
			.string()
			.optional()
			.describe("Target serverId (defaults to conversation serverId)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = resolveServerId(params.serverId, ctx);
		if (serverId) {
			const access = await assertServerAccess(serverId, ctx.organizationId);
			if (!access.ok) {
				return {
					success: false,
					message: "Server access denied",
					error: access.error,
					data: [],
				};
			}
		}

		try {
			const containers = await getServiceContainersByAppName(
				params.appName,
				serverId,
			);
			return {
				success: true,
				message: `Found ${containers?.length ?? 0} container(s)`,
				data: containers ?? [],
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to list service containers",
				error: msg,
				data: [],
			};
		}
	},
};

const dockerContainerRestart: Tool<
	{ containerId: string; serverId?: string; confirm: "RESTART_CONTAINER" },
	{ stdout: string; stderr: string }
> = {
	name: "docker_container_restart",
	description:
		"Restart a Docker container. Requires approval and confirm=RESTART_CONTAINER. Optionally specify serverId to target a remote server.",
	category: "server",
	parameters: z.object({
		containerId: z
			.string()
			.min(1)
			.regex(containerIdRegex, "Invalid container id."),
		serverId: z
			.string()
			.optional()
			.describe("Target serverId (defaults to conversation serverId)"),
		confirm: z.literal("RESTART_CONTAINER"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const serverId = resolveServerId(params.serverId, ctx);
		if (serverId) {
			const access = await assertServerAccess(serverId, ctx.organizationId);
			if (!access.ok) {
				return {
					success: false,
					message: "Server access denied",
					error: access.error,
					data: { stdout: "", stderr: "" },
				};
			}
		}

		const command = `docker container restart ${params.containerId}`;

		try {
			const result = serverId
				? await execAsyncRemote(serverId, command)
				: await execAsync(command);

			return {
				success: true,
				message: "Container restart triggered",
				data: {
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to restart container",
				error: msg,
				data: { stdout: "", stderr: "" },
			};
		}
	},
};

export function registerDockerTools() {
	toolRegistry.register(dockerContainerList);
	toolRegistry.register(dockerContainerConfigGet);
	toolRegistry.register(dockerContainerListByAppNameMatch);
	toolRegistry.register(dockerContainerListByAppLabel);
	toolRegistry.register(dockerStackContainersByAppName);
	toolRegistry.register(dockerServiceContainersByAppName);
	toolRegistry.register(dockerContainerRestart);
}

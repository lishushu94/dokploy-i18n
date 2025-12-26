import { IS_CLOUD } from "@dokploy/server/constants";
import { findServerById } from "@dokploy/server/services/server";
import { findMemberById } from "@dokploy/server/services/user";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type ClusterNodeSummary = {
	nodeId: string;
	hostname: string;
	role: "worker" | "manager";
	availability: "active" | "pause" | "drain";
	state: string;
	addr: string;
	leader: boolean;
	dockerEngineVersion: string;
};

type ClusterJoinCommand = {
	role: "worker" | "manager";
	serverId: string | null;
	ip: string;
	version: string;
	command: string;
};

const CONFIRM_CLUSTER_JOIN = "CONFIRM_CLUSTER_JOIN" as const;
const CONFIRM_CLUSTER_REMOVE_WORKER = "CONFIRM_CLUSTER_REMOVE_WORKER" as const;

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const accessDenied = <T>(message: string, data: T): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const ensureServerAccess = async (
	ctx: ToolContext,
	serverId: string,
): Promise<void> => {
	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.organizationId) {
		throw new Error("Server access denied");
	}
};

const getLocalServerIp = async (): Promise<string> => {
	if (process.env.NODE_ENV === "development") return "127.0.0.1";
	try {
		const command =
			"ip addr show | grep -E \"inet (192\\.168\\.|10\\.|172\\.1[6-9]\\.|172\\.2[0-9]\\.|172\\.3[0-1]\\.)\" | head -n1 | awk '{print $2}' | cut -d/ -f1";
		const { stdout } = await execAsync(command);
		const ip = stdout.trim();
		return (
			ip ||
			"We were unable to obtain the local server IP, please use your private IP address"
		);
	} catch {
		return "We were unable to obtain the local server IP, please use your private IP address";
	}
};

const serverListClusterNodes: Tool<
	{ serverId?: string },
	ClusterNodeSummary[]
> = {
	name: "server_list_cluster_nodes",
	description:
		"List Docker Swarm nodes (managers/workers). If serverId is provided, it lists nodes from that server.",
	category: "server",
	parameters: z.object({
		serverId: z.string().optional().describe("Target serverId (optional)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (params.serverId) {
			await ensureServerAccess(ctx, params.serverId);
		}

		const docker = await getRemoteDocker(params.serverId);
		const nodes = await docker.listNodes();
		const version = await docker.version();
		const engineVersion = version?.Version || "";

		return {
			success: true,
			message: `Found ${nodes.length} node(s)`,
			data: nodes.map((n) => ({
				nodeId: n.ID,
				hostname: n.Description?.Hostname || n.Spec?.Name || "",
				role: n.Spec?.Role || "worker",
				availability: n.Spec?.Availability || "active",
				state: n.Status?.State || "unknown",
				addr: n.Status?.Addr || "",
				leader: Boolean(n.ManagerStatus?.Leader),
				dockerEngineVersion:
					n.Description?.Engine?.EngineVersion || engineVersion,
			})),
		};
	},
};

const serverGetClusterJoinWorker: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_CLUSTER_JOIN },
	ClusterJoinCommand
> = {
	name: "server_get_cluster_join_worker",
	description:
		"Get the Docker Swarm join command for a worker node (requires approval + confirm).",
	category: "server",
	parameters: z.object({
		serverId: z.string().optional().describe("Target serverId (optional)"),
		confirm: z.literal(CONFIRM_CLUSTER_JOIN),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (params.serverId) {
			await ensureServerAccess(ctx, params.serverId);
		}

		if (IS_CLOUD && !params.serverId) {
			return {
				success: false,
				message: "Select a server to generate join command on cloud",
				error: "NOT_FOUND",
				data: {
					role: "worker",
					serverId: null,
					ip: "",
					version: "",
					command: "",
				},
			};
		}

		const docker = await getRemoteDocker(params.serverId);
		const result = await docker.swarmInspect();
		const dockerVersion = await docker.version();

		let ip = await getLocalServerIp();
		if (params.serverId) {
			const server = await findServerById(params.serverId);
			ip = server.ipAddress;
		}

		return {
			success: true,
			message: "Worker join command generated",
			data: {
				role: "worker",
				serverId: params.serverId ?? null,
				ip,
				version: dockerVersion?.Version || "",
				command: `docker swarm join --token ${result.JoinTokens.Worker} ${ip}:2377`,
			},
		};
	},
};

const serverGetClusterJoinManager: Tool<
	{ serverId?: string; confirm: typeof CONFIRM_CLUSTER_JOIN },
	ClusterJoinCommand
> = {
	name: "server_get_cluster_join_manager",
	description:
		"Get the Docker Swarm join command for a manager node (requires approval + confirm).",
	category: "server",
	parameters: z.object({
		serverId: z.string().optional().describe("Target serverId (optional)"),
		confirm: z.literal(CONFIRM_CLUSTER_JOIN),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (params.serverId) {
			await ensureServerAccess(ctx, params.serverId);
		}

		if (IS_CLOUD && !params.serverId) {
			return {
				success: false,
				message: "Select a server to generate join command on cloud",
				error: "NOT_FOUND",
				data: {
					role: "manager",
					serverId: null,
					ip: "",
					version: "",
					command: "",
				},
			};
		}

		const docker = await getRemoteDocker(params.serverId);
		const result = await docker.swarmInspect();
		const dockerVersion = await docker.version();

		let ip = await getLocalServerIp();
		if (params.serverId) {
			const server = await findServerById(params.serverId);
			ip = server.ipAddress;
		}

		return {
			success: true,
			message: "Manager join command generated",
			data: {
				role: "manager",
				serverId: params.serverId ?? null,
				ip,
				version: dockerVersion?.Version || "",
				command: `docker swarm join --token ${result.JoinTokens.Manager} ${ip}:2377`,
			},
		};
	},
};

const serverRemoveClusterWorker: Tool<
	{
		nodeId: string;
		serverId?: string;
		confirm: typeof CONFIRM_CLUSTER_REMOVE_WORKER;
	},
	{ removed: boolean; nodeId: string }
> = {
	name: "server_remove_cluster_worker",
	description:
		"Drain and remove a Docker Swarm worker node (requires approval + confirm).",
	category: "server",
	parameters: z.object({
		nodeId: z.string().min(1).describe("Docker node ID"),
		serverId: z.string().optional().describe("Target serverId (optional)"),
		confirm: z.literal(CONFIRM_CLUSTER_REMOVE_WORKER),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (params.serverId) {
			await ensureServerAccess(ctx, params.serverId);
		}

		const drainCommand = `docker node update --availability drain ${params.nodeId}`;
		const removeCommand = `docker node rm ${params.nodeId} --force`;

		try {
			if (params.serverId) {
				await execAsyncRemote(params.serverId, drainCommand);
				await execAsyncRemote(params.serverId, removeCommand);
			} else {
				await execAsync(drainCommand);
				await execAsync(removeCommand);
			}
		} catch (error) {
			return {
				success: false,
				message: "Failed to remove node",
				error: error instanceof Error ? error.message : String(error),
				data: { removed: false, nodeId: params.nodeId },
			};
		}

		return {
			success: true,
			message: "Node removed",
			data: { removed: true, nodeId: params.nodeId },
		};
	},
};

export function registerClusterTools() {
	toolRegistry.register(serverListClusterNodes);
	toolRegistry.register(serverGetClusterJoinWorker);
	toolRegistry.register(serverGetClusterJoinManager);
	toolRegistry.register(serverRemoveClusterWorker);
}

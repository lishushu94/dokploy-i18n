import {
	getApplicationInfo,
	getNodeApplications,
	getNodeInfo,
	getSwarmNodes,
} from "@dokploy/server/services/docker";
import { findServerById } from "@dokploy/server/services/server";
import { findMemberById } from "@dokploy/server/services/user";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type SwarmNodeRow = {
	ID: string;
	Hostname?: string;
	Status?: string;
	Availability?: string;
	ManagerStatus?: string;
	EngineVersion?: string;
};

type SwarmServiceRow = {
	ID: string;
	Name?: string;
	Mode?: string;
	Replicas?: string;
	Image?: string;
	Ports?: string;
};

type SwarmTaskRow = {
	ID: string;
	Name?: string;
	Image?: string;
	Node?: string;
	DesiredState?: string;
	CurrentState?: string;
	Error?: string;
	Ports?: string;
};

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const ensureServerAccess = async (ctx: ToolContext, serverId: string) => {
	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.organizationId) {
		throw new Error("Server access denied");
	}
};

const errorResult = <T>(
	message: string,
	data: T,
	error?: unknown,
): ToolResult<T> => ({
	success: false,
	message,
	error:
		error instanceof Error ? error.message : error ? String(error) : undefined,
	data,
});

const serverSwarmNodesList: Tool<{ serverId?: string }, SwarmNodeRow[]> = {
	name: "server_swarm_nodes_list",
	description:
		"List Docker Swarm nodes (docker node ls). If serverId is provided, query that server.",
	category: "server",
	parameters: z.object({
		serverId: z.string().optional().describe("Server ID (optional)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);

		const rows = await getSwarmNodes(params.serverId);
		if (!rows || !Array.isArray(rows)) {
			return errorResult("Failed to list swarm nodes", [], "No data returned");
		}

		return {
			success: true,
			message: `Found ${rows.length} node(s)`,
			data: rows as SwarmNodeRow[],
		};
	},
};

const serverSwarmNodeInfoGet: Tool<
	{ nodeId: string; serverId?: string },
	Record<string, unknown>
> = {
	name: "server_swarm_node_info_get",
	description:
		"Get Docker Swarm node details (docker node inspect). Optionally query a remote server.",
	category: "server",
	parameters: z.object({
		nodeId: z.string().min(1).describe("Docker node ID"),
		serverId: z.string().optional().describe("Server ID (optional)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);

		const info = await getNodeInfo(params.nodeId, params.serverId);
		if (!info || typeof info !== "object") {
			return errorResult("Failed to get node info", {}, "No data returned");
		}
		return {
			success: true,
			message: "Node info retrieved",
			data: info as Record<string, unknown>,
		};
	},
};

const serverSwarmServicesList: Tool<{ serverId?: string }, SwarmServiceRow[]> =
	{
		name: "server_swarm_services_list",
		description:
			"List Docker Swarm services (docker service ls). Optionally query a remote server.",
		category: "server",
		parameters: z.object({
			serverId: z.string().optional().describe("Server ID (optional)"),
		}),
		riskLevel: "low",
		requiresApproval: false,
		execute: async (params, ctx) => {
			await requireOrgMember(ctx);
			if (params.serverId) await ensureServerAccess(ctx, params.serverId);

			const rows = await getNodeApplications(params.serverId);
			if (!rows || !Array.isArray(rows)) {
				return errorResult(
					"Failed to list swarm services",
					[],
					"No data returned",
				);
			}

			return {
				success: true,
				message: `Found ${rows.length} service(s)`,
				data: rows as SwarmServiceRow[],
			};
		},
	};

const serverSwarmAppTasksGet: Tool<
	{ appName: string[]; serverId?: string },
	SwarmTaskRow[]
> = {
	name: "server_swarm_app_tasks_get",
	description:
		"Get swarm task/replica status for specific service(s) (docker service ps).",
	category: "server",
	parameters: z.object({
		appName: z
			.array(z.string().min(1))
			.min(1)
			.describe("Swarm service name(s)"),
		serverId: z.string().optional().describe("Server ID (optional)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		if (params.serverId) await ensureServerAccess(ctx, params.serverId);

		const rows = await getApplicationInfo(params.appName, params.serverId);
		if (!rows || !Array.isArray(rows)) {
			return errorResult("Failed to get service tasks", [], "No data returned");
		}

		return {
			success: true,
			message: `Found ${rows.length} task row(s)`,
			data: rows as SwarmTaskRow[],
		};
	},
};

export function registerSwarmTools() {
	toolRegistry.register(serverSwarmNodesList);
	toolRegistry.register(serverSwarmNodeInfoGet);
	toolRegistry.register(serverSwarmServicesList);
	toolRegistry.register(serverSwarmAppTasksGet);
}

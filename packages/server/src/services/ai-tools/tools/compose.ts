import { db } from "@dokploy/server/db";
import { compose as composeTable } from "@dokploy/server/db/schema";
import {
	createCompose,
	deployCompose,
	findComposeById,
	removeCompose,
	startCompose,
	stopCompose,
	updateCompose,
} from "@dokploy/server/services/compose";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const listComposeServices: Tool<
	{ projectId?: string; environmentId?: string },
	Array<{
		composeId: string;
		name: string;
		appName: string;
		status: string;
		composeType: string;
	}>
> = {
	name: "compose_list",
	description:
		"List all Compose services. Optionally filter by project or environment.",
	category: "compose",
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
		environmentId: z.string().optional().describe("Filter by environment ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const conditions = [];
		if (params.environmentId) {
			conditions.push(eq(composeTable.environmentId, params.environmentId));
		}

		const services = await db.query.compose.findMany({
			where: conditions.length > 0 ? and(...conditions) : undefined,
			with: {
				environment: {
					with: { project: true },
				},
			},
		});

		const filteredServices = params.projectId
			? services.filter(
					(s) => s.environment.project.projectId === params.projectId,
				)
			: services;

		return {
			success: true,
			message: `Found ${filteredServices.length} Compose service(s)`,
			data: filteredServices.map((s) => ({
				composeId: s.composeId,
				name: s.name,
				appName: s.appName,
				status: s.composeStatus || "idle",
				composeType: s.composeType,
			})),
		};
	},
};

const updateComposeGithubSource: Tool<
	{
		composeId: string;
		githubId: string;
		owner: string;
		repository: string;
		branch: string;
		composePath?: string;
		enableSubmodules?: boolean;
	},
	{
		composeId: string;
		sourceType: string;
		githubId: string;
		owner: string;
		repository: string;
		branch: string;
		composePath: string;
		enableSubmodules: boolean;
	}
> = {
	name: "compose_update_github_source",
	description:
		"Configure a Compose service to deploy from a GitHub repository (owner/repo/branch).",
	category: "compose",
	parameters: z.object({
		composeId: z.string().min(1).describe("Compose service ID"),
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repository: z.string().min(1).describe("Repository name"),
		branch: z.string().min(1).describe("Branch name"),
		composePath: z
			.string()
			.optional()
			.default("./docker-compose.yml")
			.describe("Path to compose file inside repo"),
		enableSubmodules: z
			.boolean()
			.optional()
			.default(false)
			.describe("Whether to clone submodules"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const service = await findComposeById(params.composeId);
		if (service.environment?.project?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Compose service access denied",
				data: {
					composeId: params.composeId,
					sourceType: "",
					githubId: "",
					owner: "",
					repository: "",
					branch: "",
					composePath: "",
					enableSubmodules: false,
				},
			};
		}

		const next = await updateCompose(params.composeId, {
			sourceType: "github",
			githubId: params.githubId,
			owner: params.owner,
			repository: params.repository,
			branch: params.branch,
			composePath: params.composePath ?? "./docker-compose.yml",
			enableSubmodules: params.enableSubmodules ?? false,
		});
		if (!next) {
			return {
				success: false,
				message: "Compose update failed",
				error: "Update did not return a record",
			};
		}

		return {
			success: true,
			message: "Compose GitHub source updated",
			data: {
				composeId: next.composeId,
				sourceType: next.sourceType,
				githubId: next.githubId ?? "",
				owner: next.owner ?? "",
				repository: next.repository ?? "",
				branch: next.branch ?? "",
				composePath: next.composePath ?? "./docker-compose.yml",
				enableSubmodules: Boolean(next.enableSubmodules),
			},
		};
	},
};

const getComposeDetails: Tool<
	{ composeId: string },
	{
		composeId: string;
		name: string;
		appName: string;
		status: string;
		composeType: string;
		sourceType: string;
		repository?: string;
		composePath: string;
	}
> = {
	name: "compose_get",
	description: "Get details of a specific Compose service by ID",
	category: "compose",
	parameters: z.object({
		composeId: z.string().describe("The Compose service ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const s = await findComposeById(params.composeId);
		return {
			success: true,
			message: `Compose service "${s.name}" details retrieved`,
			data: {
				composeId: s.composeId,
				name: s.name,
				appName: s.appName,
				status: s.composeStatus || "idle",
				composeType: s.composeType,
				sourceType: s.sourceType,
				repository: s.repository || undefined,
				composePath: s.composePath,
			},
		};
	},
};

const createComposeService: Tool<
	{
		name: string;
		appName: string;
		environmentId: string;
		composeType: "docker-compose" | "stack";
		description?: string;
		composeFile?: string;
		serverId?: string;
	},
	{ composeId: string; name: string; appName: string }
> = {
	name: "compose_create",
	description: "Create a new Compose service (Docker Compose or Swarm Stack)",
	category: "compose",
	parameters: z.object({
		name: z.string().describe("Service name"),
		appName: z.string().describe("App name (unique identifier)"),
		environmentId: z.string().describe("Environment ID"),
		composeType: z
			.enum(["docker-compose", "stack"])
			.describe("Type of deployment"),
		description: z.string().optional(),
		composeFile: z.string().optional().describe("Raw compose file content"),
		serverId: z.string().optional().describe("Server ID for remote deployment"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params) => {
		const newService = await createCompose({
			name: params.name,
			environmentId: params.environmentId,
			composeType: params.composeType,
			description: params.description,
			composeFile: params.composeFile,
			serverId: params.serverId,
			appName: params.appName,
		});

		return {
			success: true,
			message: `Compose service "${newService.name}" created`,
			data: {
				composeId: newService.composeId,
				name: newService.name,
				appName: newService.appName,
			},
		};
	},
};

const deployComposeService: Tool<
	{ composeId: string },
	{ composeId: string; status: string }
> = {
	name: "compose_deploy",
	description: "Deploy/Redeploy a Compose service",
	category: "compose",
	parameters: z.object({
		composeId: z.string().describe("The Compose service ID"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params) => {
		await deployCompose({
			composeId: params.composeId,
			titleLog: "Manual Deployment via AI",
			descriptionLog: "Triggered by AI Assistant",
		});
		return {
			success: true,
			message: "Deployment started successfully",
			data: {
				composeId: params.composeId,
				status: "deploying",
			},
		};
	},
};

const startComposeService: Tool<
	{ composeId: string },
	{ composeId: string; status: string }
> = {
	name: "compose_start",
	description: "Start a stopped Compose service",
	category: "compose",
	parameters: z.object({
		composeId: z.string().describe("The Compose service ID"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params) => {
		await startCompose(params.composeId);
		return {
			success: true,
			message: "Service started successfully",
			data: {
				composeId: params.composeId,
				status: "done",
			},
		};
	},
};

const stopComposeService: Tool<
	{ composeId: string },
	{ composeId: string; status: string }
> = {
	name: "compose_stop",
	description: "Stop a running Compose service",
	category: "compose",
	parameters: z.object({
		composeId: z.string().describe("The Compose service ID"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params) => {
		await stopCompose(params.composeId);
		return {
			success: true,
			message: "Service stopped successfully",
			data: {
				composeId: params.composeId,
				status: "stopped",
			},
		};
	},
};

const deleteComposeService: Tool<
	{ composeId: string; deleteVolumes?: boolean },
	{ deleted: boolean }
> = {
	name: "compose_delete",
	description: "Delete a Compose service permanently",
	category: "compose",
	parameters: z.object({
		composeId: z.string().describe("The Compose service ID"),
		deleteVolumes: z
			.boolean()
			.default(false)
			.describe("Whether to delete associated volumes"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params) => {
		const service = await findComposeById(params.composeId);
		await removeCompose(service, params.deleteVolumes ?? false);
		return {
			success: true,
			message: "Compose service deleted successfully",
			data: { deleted: true },
		};
	},
};

export function registerComposeTools() {
	toolRegistry.register(listComposeServices);
	toolRegistry.register(getComposeDetails);
	toolRegistry.register(createComposeService);
	toolRegistry.register(updateComposeGithubSource);
	toolRegistry.register(deployComposeService);
	toolRegistry.register(startComposeService);
	toolRegistry.register(stopComposeService);
	toolRegistry.register(deleteComposeService);
}

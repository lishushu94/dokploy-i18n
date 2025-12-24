import { db } from "@dokploy/server/db";
import {
	createEnvironment,
	deleteEnvironment,
	findEnvironmentById,
	findEnvironmentsByProjectId,
} from "@dokploy/server/services/environment";
import { findProjectById } from "@dokploy/server/services/project";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const listEnvironments: Tool<
	{ projectId?: string },
	Array<{
		environmentId: string;
		name: string;
		projectId: string;
		projectName: string;
		serviceCount: number;
	}>
> = {
	name: "environment_list",
	description: "List all environments. Optionally filter by project.",
	category: "environment",
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		if (params.projectId) {
			const envs = await findEnvironmentsByProjectId(params.projectId);
			const filtered = ctx?.organizationId
				? envs.filter((e) => e.project?.organizationId === ctx.organizationId)
				: envs;
			return {
				success: true,
				message: `Found ${filtered.length} environment(s) in project`,
				data: filtered.map((env) => ({
					environmentId: env.environmentId,
					name: env.name,
					projectId: env.projectId,
					projectName: env.project?.name || "",
					serviceCount:
						(env.applications?.length || 0) +
						(env.postgres?.length || 0) +
						(env.mysql?.length || 0) +
						(env.mariadb?.length || 0) +
						(env.mongo?.length || 0) +
						(env.redis?.length || 0) +
						(env.compose?.length || 0),
				})),
			};
		}

		const allEnvs = await db.query.environments.findMany({
			with: {
				project: true,
				applications: true,
				postgres: true,
				mysql: true,
				mariadb: true,
				mongo: true,
				redis: true,
				compose: true,
			},
		});

		const filtered = ctx?.organizationId
			? allEnvs.filter((e) => e.project?.organizationId === ctx.organizationId)
			: allEnvs;

		return {
			success: true,
			message: `Found ${filtered.length} environment(s)`,
			data: filtered.map((env) => ({
				environmentId: env.environmentId,
				name: env.name,
				projectId: env.projectId,
				projectName: env.project?.name || "",
				serviceCount:
					(env.applications?.length || 0) +
					(env.postgres?.length || 0) +
					(env.mysql?.length || 0) +
					(env.mariadb?.length || 0) +
					(env.mongo?.length || 0) +
					(env.redis?.length || 0) +
					(env.compose?.length || 0),
			})),
		};
	},
};

const findEnvironments: Tool<
	{ query: string; projectId?: string; limit?: number },
	Array<{
		environmentId: string;
		name: string;
		projectId: string;
		projectName: string;
	}>
> = {
	name: "environment_find",
	description:
		"Find environments by keyword in name. Optionally restrict search to a project.",
	category: "environment",
	parameters: z.object({
		query: z.string().min(1).describe("Search keyword"),
		projectId: z
			.string()
			.optional()
			.describe("Restrict search to a project ID"),
		limit: z
			.number()
			.optional()
			.describe("Maximum number of results to return (default 20)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const q = params.query.trim().toLowerCase();
		const limit = params.limit ?? 20;

		const envs = await db.query.environments.findMany({
			with: { project: true },
		});

		const filtered = envs
			.filter((e) => {
				if (params.projectId && e.projectId !== params.projectId) return false;
				if (
					ctx?.organizationId &&
					e.project?.organizationId !== ctx.organizationId
				)
					return false;
				const name = (e.name ?? "").toLowerCase();
				return name.includes(q);
			})
			.slice(0, limit);

		return {
			success: true,
			message: `Found ${filtered.length} matching environment(s)`,
			data: filtered.map((e) => ({
				environmentId: e.environmentId,
				name: e.name,
				projectId: e.projectId,
				projectName: e.project?.name || "",
			})),
		};
	},
};

const getEnvironmentDetails: Tool<
	{ environmentId: string },
	{
		environmentId: string;
		name: string;
		description: string | null;
		projectId: string;
		projectName: string;
		services: {
			applications: number;
			postgres: number;
			mysql: number;
			mariadb: number;
			mongo: number;
			redis: number;
			compose: number;
		};
	}
> = {
	name: "environment_get",
	description: "Get details of a specific environment including service counts",
	category: "environment",
	parameters: z.object({
		environmentId: z.string().describe("The environment ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const env = await findEnvironmentById(params.environmentId);
		if (
			ctx?.organizationId &&
			env.project?.organizationId !== ctx.organizationId
		) {
			return {
				success: false,
				message: "Environment access denied",
				data: {
					environmentId: "",
					name: "",
					description: null,
					projectId: "",
					projectName: "",
					services: {
						applications: 0,
						postgres: 0,
						mysql: 0,
						mariadb: 0,
						mongo: 0,
						redis: 0,
						compose: 0,
					},
				},
			};
		}
		return {
			success: true,
			message: `Environment "${env.name}" details retrieved`,
			data: {
				environmentId: env.environmentId,
				name: env.name,
				description: env.description,
				projectId: env.projectId,
				projectName: env.project?.name || "",
				services: {
					applications: env.applications?.length || 0,
					postgres: env.postgres?.length || 0,
					mysql: env.mysql?.length || 0,
					mariadb: env.mariadb?.length || 0,
					mongo: env.mongo?.length || 0,
					redis: env.redis?.length || 0,
					compose: env.compose?.length || 0,
				},
			},
		};
	},
};

const createNewEnvironment: Tool<
	{ projectId: string; name: string; description?: string },
	{ environmentId: string; name: string; projectId: string }
> = {
	name: "environment_create",
	description: "Create a new environment within a project",
	category: "environment",
	parameters: z.object({
		projectId: z
			.string()
			.describe("The project ID to create the environment in"),
		name: z
			.string()
			.describe("Name of the environment (e.g., staging, development)"),
		description: z
			.string()
			.optional()
			.describe("Description of the environment"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const project = await findProjectById(params.projectId);
		if (ctx?.organizationId && project.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Project access denied",
				data: { environmentId: "", name: "", projectId: "" },
			};
		}

		const env = await createEnvironment({
			projectId: params.projectId,
			name: params.name,
			description: params.description || null,
		});

		return {
			success: true,
			message: `Environment "${env.name}" created successfully`,
			data: {
				environmentId: env.environmentId,
				name: env.name,
				projectId: env.projectId,
			},
		};
	},
};

const deleteEnvironmentTool: Tool<
	{ environmentId: string },
	{ environmentId: string; deleted: boolean }
> = {
	name: "environment_delete",
	description:
		"Delete an environment and all its services. Cannot delete the production environment.",
	category: "environment",
	parameters: z.object({
		environmentId: z.string().describe("The environment ID to delete"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const env = await findEnvironmentById(params.environmentId);
		if (
			ctx?.organizationId &&
			env.project?.organizationId !== ctx.organizationId
		) {
			return {
				success: false,
				message: "Environment access denied",
				data: { environmentId: "", deleted: false },
			};
		}
		await deleteEnvironment(params.environmentId);

		return {
			success: true,
			message: `Environment "${env.name}" has been deleted`,
			data: {
				environmentId: params.environmentId,
				deleted: true,
			},
		};
	},
};

export function registerEnvironmentTools() {
	toolRegistry.register(listEnvironments);
	toolRegistry.register(getEnvironmentDetails);
	toolRegistry.register(findEnvironments);
	toolRegistry.register(createNewEnvironment);
	toolRegistry.register(deleteEnvironmentTool);
}

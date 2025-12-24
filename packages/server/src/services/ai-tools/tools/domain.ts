import { db } from "@dokploy/server/db";
import { domains as domainsTable } from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import {
	findComposeById,
	rebuildCompose,
} from "@dokploy/server/services/compose";
import {
	createDomain,
	findDomainById,
	removeDomainById,
	validateDomain,
} from "@dokploy/server/services/domain";
import { findPreviewDeploymentById } from "@dokploy/server/services/preview-deployment";
import { removeDomain as removeTraefikDomain } from "@dokploy/server/utils/traefik/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const listDomains: Tool<
	{ applicationId?: string; composeId?: string },
	Array<{
		domainId: string;
		host: string;
		path: string;
		port: number | null;
		https: boolean;
	}>
> = {
	name: "domain_list",
	description: "List domains. Filter by Application or Compose service.",
	category: "domain",
	parameters: z.object({
		applicationId: z.string().optional().describe("Filter by Application ID"),
		composeId: z.string().optional().describe("Filter by Compose ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const conditions = [];
		if (params.applicationId) {
			conditions.push(eq(domainsTable.applicationId, params.applicationId));
		}
		if (params.composeId) {
			conditions.push(eq(domainsTable.composeId, params.composeId));
		}

		const results = await db.query.domains.findMany({
			where: conditions.length > 0 ? and(...conditions) : undefined,
		});

		return {
			success: true,
			message: `Found ${results.length} domain(s)`,
			data: results.map((d) => ({
				domainId: d.domainId,
				host: d.host,
				path: d.path || "/",
				port: d.port,
				https: d.https,
			})),
		};
	},
};

const createDomainTool: Tool<
	{
		host: string;
		path?: string;
		port?: number;
		https?: boolean;
		applicationId?: string;
		composeId?: string;
		serviceName?: string;
		certificateType?: "none" | "letsencrypt";
	},
	{ domainId: string; host: string }
> = {
	name: "domain_create",
	description: "Create/Attach a domain to an Application or Compose service",
	category: "domain",
	parameters: z.object({
		host: z.string().describe("Domain name (e.g. app.example.com)"),
		path: z.string().optional().default("/").describe("URL path"),
		port: z.number().optional().default(3000).describe("Internal port"),
		https: z.boolean().optional().default(true).describe("Enable HTTPS"),
		applicationId: z.string().optional().describe("Attach to Application ID"),
		composeId: z.string().optional().describe("Attach to Compose ID"),
		serviceName: z.string().optional().describe("Service name (for Compose)"),
		certificateType: z
			.enum(["none", "letsencrypt"])
			.optional()
			.default("letsencrypt"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params) => {
		if (!params.applicationId && !params.composeId) {
			throw new Error("Must provide either applicationId or composeId");
		}

		const domain = await createDomain({
			host: params.host,
			path: params.path,
			port: params.port,
			https: params.https,
			applicationId: params.applicationId,
			composeId: params.composeId,
			serviceName: params.serviceName,
			certificateType: params.certificateType || "letsencrypt",
			domainType: params.composeId ? "compose" : "application",
		});

		return {
			success: true,
			message: `Domain ${domain.host} created successfully`,
			data: {
				domainId: domain.domainId,
				host: domain.host,
			},
		};
	},
};

const deleteDomain: Tool<{ domainId: string }, { deleted: boolean }> = {
	name: "domain_delete",
	description: "Remove a domain",
	category: "domain",
	parameters: z.object({
		domainId: z.string().describe("The Domain ID to remove"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const domain = await findDomainById(params.domainId);

		if (domain.applicationId) {
			const application = await findApplicationById(domain.applicationId);
			if (
				application.environment?.project?.organizationId !== ctx.organizationId
			) {
				return {
					success: false,
					message: "Application access denied",
					data: { deleted: false },
				};
			}
		} else if (domain.composeId) {
			const compose = await findComposeById(domain.composeId);
			if (compose.environment?.project?.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Compose access denied",
					data: { deleted: false },
				};
			}
		} else if (domain.previewDeploymentId) {
			const previewDeployment = await findPreviewDeploymentById(
				domain.previewDeploymentId,
			);
			if (
				previewDeployment.application.environment.project.organizationId !==
				ctx.organizationId
			) {
				return {
					success: false,
					message: "Preview deployment access denied",
					data: { deleted: false },
				};
			}
		}

		await removeDomainById(params.domainId);

		if (domain.applicationId) {
			const application = await findApplicationById(domain.applicationId);
			await removeTraefikDomain(application, domain.uniqueConfigKey);
		} else if (domain.previewDeploymentId) {
			const previewDeployment = await findPreviewDeploymentById(
				domain.previewDeploymentId,
			);
			const application = await findApplicationById(
				previewDeployment.applicationId,
			);
			application.appName = previewDeployment.appName;
			await removeTraefikDomain(application, domain.uniqueConfigKey);
		} else if (domain.composeId) {
			await rebuildCompose({
				composeId: domain.composeId,
				titleLog: "Reload after domain delete (AI)",
				descriptionLog: "Triggered by AI Assistant",
			});
		}

		return {
			success: true,
			message: "Domain removed successfully",
			data: { deleted: true },
		};
	},
};

const checkDomain: Tool<
	{ domain: string },
	{ isValid: boolean; resolvedIp?: string; error?: string }
> = {
	name: "domain_check",
	description: "Check if a domain resolves correctly",
	category: "domain",
	parameters: z.object({
		domain: z.string().describe("Domain to check"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const result = await validateDomain(params.domain);
		return {
			success: true,
			message: result.isValid
				? "Domain resolves correctly"
				: "Domain validation failed",
			data: {
				isValid: result.isValid,
				resolvedIp: result.resolvedIp,
				error: result.error,
			},
		};
	},
};

export function registerDomainTools() {
	toolRegistry.register(listDomains);
	toolRegistry.register(createDomainTool);
	toolRegistry.register(deleteDomain);
	toolRegistry.register(checkDomain);
}

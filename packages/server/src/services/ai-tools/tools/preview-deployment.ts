import {
	findApplicationById,
	findPreviewDeploymentById,
	findPreviewDeploymentsByApplicationId,
	removePreviewDeployment,
} from "@dokploy/server";
import { findMemberById } from "@dokploy/server/services/user";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type PreviewDeploymentSummary = {
	previewDeploymentId: string;
	applicationId: string;
	branch: string;
	pullRequestNumber: string;
	pullRequestTitle: string;
	pullRequestURL: string;
	previewStatus: string;
	appName: string;
	domainHost: string | null;
	createdAt: string;
	expiresAt: string | null;
};

type PreviewDeploymentDetails = PreviewDeploymentSummary & {
	pullRequestId: string;
	pullRequestCommentId: string;
	domainPath: string | null;
	domainHttps: boolean | null;
	applicationName: string;
	projectId: string;
	organizationId: string;
};

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const accessDenied = <T>(message: string, data: T): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const toSummary = (p: {
	previewDeploymentId: string;
	applicationId: string;
	branch: string;
	pullRequestNumber: string;
	pullRequestTitle: string;
	pullRequestURL: string;
	previewStatus: string;
	appName: string;
	createdAt: string;
	expiresAt: string | null;
	domain?: { host: string; path: string | null; https: boolean } | null;
}): PreviewDeploymentSummary => ({
	previewDeploymentId: p.previewDeploymentId,
	applicationId: p.applicationId,
	branch: p.branch,
	pullRequestNumber: p.pullRequestNumber,
	pullRequestTitle: p.pullRequestTitle,
	pullRequestURL: p.pullRequestURL,
	previewStatus: p.previewStatus,
	appName: p.appName,
	domainHost: p.domain?.host ?? null,
	createdAt: p.createdAt,
	expiresAt: p.expiresAt ?? null,
});

const deploymentListPreviews: Tool<
	{ applicationId: string },
	PreviewDeploymentSummary[]
> = {
	name: "deployment_list_previews",
	description: "List preview deployments for an application.",
	category: "deployment",
	parameters: z.object({
		applicationId: z.string().min(1).describe("Application ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const application = await findApplicationById(params.applicationId);
		if (application.environment.project.organizationId !== ctx.organizationId) {
			return accessDenied("Application access denied", []);
		}

		const rows = await findPreviewDeploymentsByApplicationId(
			params.applicationId,
		);
		return {
			success: true,
			message: `Found ${rows.length} preview deployment(s)`,
			data: rows.map((r) =>
				toSummary({
					previewDeploymentId: r.previewDeploymentId,
					applicationId: r.applicationId,
					branch: r.branch,
					pullRequestNumber: r.pullRequestNumber,
					pullRequestTitle: r.pullRequestTitle,
					pullRequestURL: r.pullRequestURL,
					previewStatus: r.previewStatus,
					appName: r.appName,
					createdAt: r.createdAt,
					expiresAt: r.expiresAt ?? null,
					domain: r.domain
						? {
								host: r.domain.host,
								path: r.domain.path,
								https: r.domain.https,
							}
						: null,
				}),
			),
		};
	},
};

const deploymentGetPreview: Tool<
	{ previewDeploymentId: string },
	PreviewDeploymentDetails
> = {
	name: "deployment_get_preview",
	description: "Get a preview deployment by ID.",
	category: "deployment",
	parameters: z.object({
		previewDeploymentId: z.string().min(1).describe("Preview deployment ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const pd = await findPreviewDeploymentById(params.previewDeploymentId);
		const orgId = pd.application.environment.project.organizationId;
		if (orgId !== ctx.organizationId) {
			return accessDenied("Preview deployment access denied", {
				previewDeploymentId: params.previewDeploymentId,
				applicationId: "",
				branch: "",
				pullRequestNumber: "",
				pullRequestTitle: "",
				pullRequestURL: "",
				previewStatus: "",
				appName: "",
				domainHost: null,
				createdAt: "",
				expiresAt: null,
				pullRequestId: "",
				pullRequestCommentId: "",
				domainPath: null,
				domainHttps: null,
				applicationName: "",
				projectId: "",
				organizationId: "",
			});
		}

		return {
			success: true,
			message: "Preview deployment retrieved",
			data: {
				...toSummary({
					previewDeploymentId: pd.previewDeploymentId,
					applicationId: pd.applicationId,
					branch: pd.branch,
					pullRequestNumber: pd.pullRequestNumber,
					pullRequestTitle: pd.pullRequestTitle,
					pullRequestURL: pd.pullRequestURL,
					previewStatus: pd.previewStatus,
					appName: pd.appName,
					createdAt: pd.createdAt,
					expiresAt: pd.expiresAt ?? null,
					domain: pd.domain
						? {
								host: pd.domain.host,
								path: pd.domain.path,
								https: pd.domain.https,
							}
						: null,
				}),
				pullRequestId: pd.pullRequestId,
				pullRequestCommentId: pd.pullRequestCommentId,
				domainPath: pd.domain?.path ?? null,
				domainHttps: pd.domain?.https ?? null,
				applicationName: pd.application.name,
				projectId: pd.application.environment.projectId,
				organizationId: orgId,
			},
		};
	},
};

const deploymentDeletePreview: Tool<
	{ previewDeploymentId: string; confirm: "CONFIRM_PREVIEW_DEPLOYMENT_DELETE" },
	{ deleted: boolean; previewDeploymentId: string }
> = {
	name: "deployment_delete_preview",
	description:
		"Delete a preview deployment and its related resources (requires approval + confirm).",
	category: "deployment",
	parameters: z.object({
		previewDeploymentId: z.string().min(1).describe("Preview deployment ID"),
		confirm: z.literal("CONFIRM_PREVIEW_DEPLOYMENT_DELETE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const pd = await findPreviewDeploymentById(params.previewDeploymentId);
		if (
			pd.application.environment.project.organizationId !== ctx.organizationId
		) {
			return accessDenied("Preview deployment access denied", {
				deleted: false,
				previewDeploymentId: params.previewDeploymentId,
			});
		}

		await removePreviewDeployment(params.previewDeploymentId);
		return {
			success: true,
			message: "Preview deployment deleted",
			data: { deleted: true, previewDeploymentId: params.previewDeploymentId },
		};
	},
};

export function registerPreviewDeploymentTools() {
	toolRegistry.register(deploymentListPreviews);
	toolRegistry.register(deploymentGetPreview);
	toolRegistry.register(deploymentDeletePreview);
}

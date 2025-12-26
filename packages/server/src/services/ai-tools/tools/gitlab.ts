import { db } from "@dokploy/server/db";
import {
	apiCreateGitlab,
	apiFindOneGitlab,
	apiUpdateGitlab,
	gitlab as gitlabTable,
} from "@dokploy/server/db/schema";
import { updateGitProvider } from "@dokploy/server/services/git-provider";
import {
	createGitlab,
	findGitlabById,
	updateGitlab,
} from "@dokploy/server/services/gitlab";
import { findMemberById } from "@dokploy/server/services/user";
import {
	getGitlabBranches,
	getGitlabRepositories,
	haveGitlabRequirements,
	testGitlabConnection,
} from "@dokploy/server/utils/providers/gitlab";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

type GitlabProviderSummary = {
	gitlabId: string;
	gitProviderId: string;
	name: string;
	gitlabUrl: string;
	applicationId: string | null;
	redirectUri: string | null;
	groupName: string | null;
	expiresAt: number | null;
	secretPresent: boolean;
	accessTokenPresent: boolean;
	refreshTokenPresent: boolean;
	ready: boolean;
};

const toSummary = (p: {
	gitlabId: string;
	gitlabUrl: string;
	applicationId: string | null;
	redirectUri: string | null;
	secret: string | null;
	accessToken: string | null;
	refreshToken: string | null;
	groupName: string | null;
	expiresAt: number | null;
	gitProvider: { gitProviderId: string; name: string };
}): GitlabProviderSummary => {
	const ready = Boolean(p.accessToken && p.refreshToken);
	return {
		gitlabId: p.gitlabId,
		gitProviderId: p.gitProvider.gitProviderId,
		name: p.gitProvider.name,
		gitlabUrl: p.gitlabUrl,
		applicationId: p.applicationId,
		redirectUri: p.redirectUri,
		groupName: p.groupName,
		expiresAt: p.expiresAt,
		secretPresent: Boolean(p.secret),
		accessTokenPresent: Boolean(p.accessToken),
		refreshTokenPresent: Boolean(p.refreshToken),
		ready,
	};
};

const requireGitlabAccess = async (
	gitlabId: string,
	ctx: { userId: string; organizationId: string },
) => {
	try {
		const provider = await findGitlabById(gitlabId);
		if (
			provider.gitProvider.organizationId !== ctx.organizationId &&
			provider.gitProvider.userId !== ctx.userId
		) {
			return null;
		}
		return provider;
	} catch {
		return null;
	}
};

const gitlabProviderList: Tool<
	{ includeIncomplete?: boolean },
	GitlabProviderSummary[]
> = {
	name: "gitlab_provider_list",
	description:
		"List GitLab providers for the current user and organization. Secrets/tokens are never returned.",
	category: "github",
	parameters: z.object({
		includeIncomplete: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include providers missing OAuth requirements"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		let rows = await db.query.gitlab.findMany({
			with: {
				gitProvider: true,
			},
			orderBy: [desc(gitlabTable.gitlabId)],
		});

		rows = rows.filter(
			(p) =>
				p.gitProvider.organizationId === ctx.organizationId &&
				p.gitProvider.userId === ctx.userId,
		);

		if (!params.includeIncomplete) {
			rows = rows.filter((p) => haveGitlabRequirements(p));
		}

		return {
			success: true,
			message: `Found ${rows.length} GitLab provider(s)`,
			data: rows.map((p) =>
				toSummary({
					gitlabId: p.gitlabId,
					gitlabUrl: p.gitlabUrl,
					applicationId: p.applicationId,
					redirectUri: p.redirectUri,
					secret: p.secret,
					accessToken: p.accessToken,
					refreshToken: p.refreshToken,
					groupName: p.groupName,
					expiresAt: p.expiresAt,
					gitProvider: {
						gitProviderId: p.gitProvider.gitProviderId,
						name: p.gitProvider.name,
					},
				}),
			),
		};
	},
};

const gitlabProviderGet: Tool<{ gitlabId: string }, GitlabProviderSummary> = {
	name: "gitlab_provider_get",
	description:
		"Get a single GitLab provider by ID (masked). Secrets/tokens are never returned.",
	category: "github",
	parameters: apiFindOneGitlab,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		const provider = await requireGitlabAccess(params.gitlabId, ctx);
		if (!provider) {
			return {
				success: false,
				message: "GitLab provider access denied",
				error: "UNAUTHORIZED",
				data: {
					gitlabId: params.gitlabId,
					gitProviderId: "",
					name: "",
					gitlabUrl: "",
					applicationId: null,
					redirectUri: null,
					groupName: null,
					expiresAt: null,
					secretPresent: false,
					accessTokenPresent: false,
					refreshTokenPresent: false,
					ready: false,
				},
			};
		}

		return {
			success: true,
			message: "GitLab provider fetched",
			data: toSummary({
				gitlabId: provider.gitlabId,
				gitlabUrl: provider.gitlabUrl,
				applicationId: provider.applicationId,
				redirectUri: provider.redirectUri,
				secret: provider.secret,
				accessToken: provider.accessToken,
				refreshToken: provider.refreshToken,
				groupName: provider.groupName,
				expiresAt: provider.expiresAt,
				gitProvider: {
					gitProviderId: provider.gitProvider.gitProviderId,
					name: provider.gitProvider.name,
				},
			}),
		};
	},
};

const gitlabRepositoryList: Tool<
	{ gitlabId: string; limit?: number },
	Array<{ id: number; name: string; url: string; owner: { username: string } }>
> = {
	name: "gitlab_repository_list",
	description: "List repositories accessible to a given GitLab provider",
	category: "github",
	parameters: z.object({
		gitlabId: z.string().min(1).describe("GitLab provider ID"),
		limit: z
			.number()
			.min(1)
			.max(200)
			.optional()
			.default(50)
			.describe("Maximum number of repositories to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		if (!(await requireGitlabAccess(params.gitlabId, ctx))) {
			return {
				success: false,
				message: "GitLab provider access denied",
				data: [],
			};
		}

		const repos = await getGitlabRepositories(params.gitlabId);
		const limit = params.limit ?? 50;
		return {
			success: true,
			message: `Found ${Math.min(repos.length, limit)} repositor${repos.length === 1 ? "y" : "ies"}`,
			data: repos.slice(0, limit),
		};
	},
};

const gitlabBranchListParams = z.object({
	gitlabId: z.string().min(1).describe("GitLab provider ID"),
	id: z.number().min(1).describe("GitLab project ID"),
	owner: z.string().min(1).describe("Project owner/group"),
	repo: z.string().min(1).describe("Project name"),
	limit: z
		.number()
		.min(1)
		.max(200)
		.optional()
		.default(60)
		.describe("Maximum number of branches to return"),
});

const gitlabBranchList: Tool<
	z.infer<typeof gitlabBranchListParams>,
	Array<{ name: string; commitId: string }>
> = {
	name: "gitlab_branch_list",
	description: "List branches for a GitLab project",
	category: "github",
	parameters: gitlabBranchListParams,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		if (!(await requireGitlabAccess(params.gitlabId, ctx))) {
			return {
				success: false,
				message: "GitLab provider access denied",
				data: [],
			};
		}

		const branches = await getGitlabBranches({
			gitlabId: params.gitlabId,
			id: params.id,
			owner: params.owner,
			repo: params.repo,
		});
		const limit = params.limit ?? 60;
		const picked = branches.slice(0, limit);
		return {
			success: true,
			message: `Found ${picked.length} branch(es)`,
			data: picked.map((b) => ({ name: b.name, commitId: b.commit.id })),
		};
	},
};

const gitlabTestConnectionParams = z.object({
	gitlabId: z.string().min(1).describe("GitLab provider ID"),
	groupName: z
		.string()
		.optional()
		.describe("Comma-separated group filter used during validation"),
});

const gitlabTestConnectionTool: Tool<
	z.infer<typeof gitlabTestConnectionParams>,
	{ repositories: number }
> = {
	name: "gitlab_test_connection",
	description: "Test GitLab provider connection and return repository count",
	category: "github",
	parameters: gitlabTestConnectionParams,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		if (!(await requireGitlabAccess(params.gitlabId, ctx))) {
			return {
				success: false,
				message: "GitLab provider access denied",
				error: "UNAUTHORIZED",
				data: { repositories: 0 },
			};
		}

		try {
			const repositories = await testGitlabConnection({
				gitlabId: params.gitlabId,
				groupName: params.groupName,
			});
			return {
				success: true,
				message: `Found ${repositories} repositories`,
				data: { repositories },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "GitLab connection test failed",
				error: msg,
				data: { repositories: 0 },
			};
		}
	},
};

const gitlabProviderCreate: Tool<
	z.infer<typeof apiCreateGitlab> & {
		confirm: "CONFIRM_GITLAB_PROVIDER_CHANGE";
	},
	{ created: boolean }
> = {
	name: "gitlab_provider_create",
	description:
		"Create a new GitLab provider connection. Requires approval + confirm. Secrets/tokens are accepted but never returned.",
	category: "github",
	parameters: apiCreateGitlab.extend({
		confirm: z.literal("CONFIRM_GITLAB_PROVIDER_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const { confirm: _confirm, ...input } = params;

		const createInput: typeof apiCreateGitlab._type = {
			name: input.name,
			authId: input.authId,
			gitlabUrl: input.gitlabUrl,
			applicationId: input.applicationId,
			redirectUri: input.redirectUri,
			secret: input.secret,
			accessToken: input.accessToken,
			refreshToken: input.refreshToken,
			groupName: input.groupName,
			expiresAt: input.expiresAt,
			gitProviderId: input.gitProviderId,
		};

		try {
			await createGitlab(createInput, ctx.organizationId, ctx.userId);
			return {
				success: true,
				message: "GitLab provider created",
				data: { created: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Error creating this GitLab provider",
				error: msg,
				data: { created: false },
			};
		}
	},
};

const gitlabProviderUpdate: Tool<
	z.infer<typeof apiUpdateGitlab> & {
		confirm: "CONFIRM_GITLAB_PROVIDER_CHANGE";
	},
	{ updated: boolean }
> = {
	name: "gitlab_provider_update",
	description:
		"Update an existing GitLab provider connection. Requires approval + confirm. Secrets/tokens are accepted but never returned.",
	category: "github",
	parameters: apiUpdateGitlab.extend({
		confirm: z.literal("CONFIRM_GITLAB_PROVIDER_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const existing = await requireGitlabAccess(params.gitlabId, ctx);
		if (!existing) {
			return {
				success: false,
				message: "GitLab provider access denied",
				error: "UNAUTHORIZED",
				data: { updated: false },
			};
		}

		const { confirm: _confirm, ...input } = params;

		try {
			if (input.name) {
				await updateGitProvider(
					(input as { gitProviderId: string }).gitProviderId,
					{
						name: input.name,
						organizationId: ctx.organizationId,
					},
				);
			}

			await updateGitlab(input.gitlabId, {
				gitlabUrl: input.gitlabUrl,
				applicationId: input.applicationId,
				redirectUri: input.redirectUri,
				secret: input.secret,
				accessToken: input.accessToken,
				refreshToken: input.refreshToken,
				groupName: input.groupName,
				expiresAt: input.expiresAt,
			});

			return {
				success: true,
				message: "GitLab provider updated",
				data: { updated: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Error updating this GitLab provider",
				error: msg,
				data: { updated: false },
			};
		}
	},
};

export function registerGitlabTools() {
	toolRegistry.register(gitlabProviderList);
	toolRegistry.register(gitlabProviderGet);
	toolRegistry.register(gitlabRepositoryList);
	toolRegistry.register(gitlabBranchList);
	toolRegistry.register(gitlabTestConnectionTool);
	toolRegistry.register(gitlabProviderCreate);
	toolRegistry.register(gitlabProviderUpdate);
}

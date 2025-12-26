import { db } from "@dokploy/server/db";
import {
	apiBitbucketTestConnection,
	apiCreateBitbucket,
	apiFindOneBitbucket,
	apiUpdateBitbucket,
	bitbucket as bitbucketTable,
} from "@dokploy/server/db/schema";
import {
	createBitbucket,
	findBitbucketById,
	updateBitbucket,
} from "@dokploy/server/services/bitbucket";
import { findMemberById } from "@dokploy/server/services/user";
import {
	getBitbucketBranches,
	getBitbucketRepositories,
	testBitbucketConnection,
} from "@dokploy/server/utils/providers/bitbucket";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

type BitbucketProviderSummary = {
	bitbucketId: string;
	gitProviderId: string;
	name: string;
	bitbucketUsername: string | null;
	bitbucketEmail: string | null;
	bitbucketWorkspaceName: string | null;
	appPasswordPresent: boolean;
	apiTokenPresent: boolean;
};

const toSummary = (p: {
	bitbucketId: string;
	bitbucketUsername: string | null;
	bitbucketEmail: string | null;
	appPassword: string | null;
	apiToken: string | null;
	bitbucketWorkspaceName: string | null;
	gitProvider: { gitProviderId: string; name: string };
}): BitbucketProviderSummary => {
	return {
		bitbucketId: p.bitbucketId,
		gitProviderId: p.gitProvider.gitProviderId,
		name: p.gitProvider.name,
		bitbucketUsername: p.bitbucketUsername,
		bitbucketEmail: p.bitbucketEmail,
		bitbucketWorkspaceName: p.bitbucketWorkspaceName,
		appPasswordPresent: Boolean(p.appPassword),
		apiTokenPresent: Boolean(p.apiToken),
	};
};

const requireBitbucketAccess = async (
	bitbucketId: string,
	ctx: { userId: string; organizationId: string },
) => {
	try {
		const provider = await findBitbucketById(bitbucketId);
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

const bitbucketProviderList: Tool<
	Record<string, never>,
	BitbucketProviderSummary[]
> = {
	name: "bitbucket_provider_list",
	description:
		"List Bitbucket providers for the current user and organization. Secrets/tokens are never returned.",
	category: "github",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		let rows = await db.query.bitbucket.findMany({
			with: {
				gitProvider: true,
			},
			orderBy: [desc(bitbucketTable.bitbucketId)],
		});

		rows = rows.filter(
			(p) =>
				p.gitProvider.organizationId === ctx.organizationId &&
				p.gitProvider.userId === ctx.userId,
		);

		return {
			success: true,
			message: `Found ${rows.length} Bitbucket provider(s)`,
			data: rows.map((p) =>
				toSummary({
					bitbucketId: p.bitbucketId,
					bitbucketUsername: p.bitbucketUsername,
					bitbucketEmail: p.bitbucketEmail,
					appPassword: p.appPassword,
					apiToken: p.apiToken,
					bitbucketWorkspaceName: p.bitbucketWorkspaceName,
					gitProvider: {
						gitProviderId: p.gitProvider.gitProviderId,
						name: p.gitProvider.name,
					},
				}),
			),
		};
	},
};

const bitbucketProviderGet: Tool<
	{ bitbucketId: string },
	BitbucketProviderSummary
> = {
	name: "bitbucket_provider_get",
	description:
		"Get a single Bitbucket provider by ID (masked). Secrets/tokens are never returned.",
	category: "github",
	parameters: apiFindOneBitbucket,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		const provider = await requireBitbucketAccess(params.bitbucketId, ctx);
		if (!provider) {
			return {
				success: false,
				message: "Bitbucket provider access denied",
				error: "UNAUTHORIZED",
				data: {
					bitbucketId: params.bitbucketId,
					gitProviderId: "",
					name: "",
					bitbucketUsername: null,
					bitbucketEmail: null,
					bitbucketWorkspaceName: null,
					appPasswordPresent: false,
					apiTokenPresent: false,
				},
			};
		}

		return {
			success: true,
			message: "Bitbucket provider fetched",
			data: toSummary({
				bitbucketId: provider.bitbucketId,
				bitbucketUsername: provider.bitbucketUsername,
				bitbucketEmail: provider.bitbucketEmail,
				appPassword: provider.appPassword,
				apiToken: provider.apiToken,
				bitbucketWorkspaceName: provider.bitbucketWorkspaceName,
				gitProvider: {
					gitProviderId: provider.gitProvider.gitProviderId,
					name: provider.gitProvider.name,
				},
			}),
		};
	},
};

const bitbucketRepositoryList: Tool<
	{ bitbucketId: string; limit?: number },
	Array<{ name: string; url: string; owner: { username: string } }>
> = {
	name: "bitbucket_repository_list",
	description: "List repositories accessible to a given Bitbucket provider",
	category: "github",
	parameters: z.object({
		bitbucketId: z.string().min(1).describe("Bitbucket provider ID"),
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
		if (!(await requireBitbucketAccess(params.bitbucketId, ctx))) {
			return {
				success: false,
				message: "Bitbucket provider access denied",
				data: [],
			};
		}

		const repos = await getBitbucketRepositories(params.bitbucketId);
		const limit = params.limit ?? 50;
		return {
			success: true,
			message: `Found ${Math.min(repos.length, limit)} repositor${repos.length === 1 ? "y" : "ies"}`,
			data: repos.slice(0, limit),
		};
	},
};

const bitbucketBranchListParams = z.object({
	bitbucketId: z.string().min(1).describe("Bitbucket provider ID"),
	owner: z.string().min(1).describe("Repository owner/workspace"),
	repo: z.string().min(1).describe("Repository name"),
	limit: z
		.number()
		.min(1)
		.max(200)
		.optional()
		.default(60)
		.describe("Maximum number of branches to return"),
});

const bitbucketBranchList: Tool<
	z.infer<typeof bitbucketBranchListParams>,
	Array<{ name: string; commitSha: string }>
> = {
	name: "bitbucket_branch_list",
	description: "List branches for a Bitbucket repository",
	category: "github",
	parameters: bitbucketBranchListParams,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		if (!(await requireBitbucketAccess(params.bitbucketId, ctx))) {
			return {
				success: false,
				message: "Bitbucket provider access denied",
				data: [],
			};
		}

		const branches = await getBitbucketBranches({
			bitbucketId: params.bitbucketId,
			owner: params.owner,
			repo: params.repo,
		});
		const limit = params.limit ?? 60;
		const picked = branches.slice(0, limit);
		return {
			success: true,
			message: `Found ${picked.length} branch(es)`,
			data: picked.map((b) => ({
				name: b.name,
				commitSha: b.commit.sha,
			})),
		};
	},
};

const bitbucketTestConnectionTool: Tool<
	z.infer<typeof apiBitbucketTestConnection>,
	{ repositories: number }
> = {
	name: "bitbucket_test_connection",
	description: "Test Bitbucket provider connection and return repository count",
	category: "github",
	parameters: apiBitbucketTestConnection,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		if (!(await requireBitbucketAccess(params.bitbucketId, ctx))) {
			return {
				success: false,
				message: "Bitbucket provider access denied",
				error: "UNAUTHORIZED",
				data: { repositories: 0 },
			};
		}

		try {
			const repositories = await testBitbucketConnection(params);
			return {
				success: true,
				message: `Found ${repositories} repositories`,
				data: { repositories },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Bitbucket connection test failed",
				error: msg,
				data: { repositories: 0 },
			};
		}
	},
};

const bitbucketProviderCreate: Tool<
	z.infer<typeof apiCreateBitbucket> & {
		confirm: "CONFIRM_BITBUCKET_PROVIDER_CHANGE";
	},
	{ created: boolean }
> = {
	name: "bitbucket_provider_create",
	description:
		"Create a new Bitbucket provider connection. Requires approval + confirm. Secrets/tokens are accepted but never returned.",
	category: "github",
	parameters: apiCreateBitbucket.extend({
		confirm: z.literal("CONFIRM_BITBUCKET_PROVIDER_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const { confirm: _confirm, ...input } = params;

		try {
			await createBitbucket(input, ctx.organizationId, ctx.userId);
			return {
				success: true,
				message: "Bitbucket provider created",
				data: { created: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Error creating this Bitbucket provider",
				error: msg,
				data: { created: false },
			};
		}
	},
};

const bitbucketProviderUpdate: Tool<
	z.infer<typeof apiUpdateBitbucket> & {
		confirm: "CONFIRM_BITBUCKET_PROVIDER_CHANGE";
	},
	{ updated: boolean }
> = {
	name: "bitbucket_provider_update",
	description:
		"Update an existing Bitbucket provider connection. Requires approval + confirm. Secrets/tokens are accepted but never returned.",
	category: "github",
	parameters: apiUpdateBitbucket.extend({
		confirm: z.literal("CONFIRM_BITBUCKET_PROVIDER_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const existing = await requireBitbucketAccess(params.bitbucketId, ctx);
		if (!existing) {
			return {
				success: false,
				message: "Bitbucket provider access denied",
				error: "UNAUTHORIZED",
				data: { updated: false },
			};
		}

		const { confirm: _confirm, ...input } = params;

		try {
			await updateBitbucket(params.bitbucketId, {
				...input,
				organizationId: ctx.organizationId,
			});
			return {
				success: true,
				message: "Bitbucket provider updated",
				data: { updated: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Error updating this Bitbucket provider",
				error: msg,
				data: { updated: false },
			};
		}
	},
};

export function registerBitbucketTools() {
	toolRegistry.register(bitbucketProviderList);
	toolRegistry.register(bitbucketProviderGet);
	toolRegistry.register(bitbucketRepositoryList);
	toolRegistry.register(bitbucketBranchList);
	toolRegistry.register(bitbucketTestConnectionTool);
	toolRegistry.register(bitbucketProviderCreate);
	toolRegistry.register(bitbucketProviderUpdate);
}

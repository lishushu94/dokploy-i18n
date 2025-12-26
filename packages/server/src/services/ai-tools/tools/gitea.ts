import { db } from "@dokploy/server/db";
import {
	apiCreateGitea,
	apiFindOneGitea,
	apiUpdateGitea,
	gitea as giteaTable,
} from "@dokploy/server/db/schema";
import { updateGitProvider } from "@dokploy/server/services/git-provider";
import {
	createGitea,
	findGiteaById,
	type Gitea,
	updateGitea,
} from "@dokploy/server/services/gitea";
import { findMemberById } from "@dokploy/server/services/user";
import {
	getGiteaBranches,
	getGiteaRepositories,
	haveGiteaRequirements,
	testGiteaConnection,
} from "@dokploy/server/utils/providers/gitea";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

type GiteaProviderSummary = {
	giteaId: string;
	gitProviderId: string;
	name: string;
	giteaUrl: string;
	redirectUri: string | null;
	clientIdPresent: boolean;
	clientSecretPresent: boolean;
	accessTokenPresent: boolean;
	refreshTokenPresent: boolean;
	expiresAt: number | null;
	scopes: string | null;
	lastAuthenticatedAt: number | null;
	ready: boolean;
};

const toSummary = (p: {
	giteaId: string;
	giteaUrl: string;
	redirectUri: string | null;
	clientId: string | null;
	clientSecret: string | null;
	accessToken: string | null;
	refreshToken: string | null;
	expiresAt: number | null;
	scopes: string | null;
	lastAuthenticatedAt: number | null;
	gitProvider: { gitProviderId: string; name: string };
}): GiteaProviderSummary => {
	const ready = Boolean(p.clientId && p.clientSecret);
	return {
		giteaId: p.giteaId,
		gitProviderId: p.gitProvider.gitProviderId,
		name: p.gitProvider.name,
		giteaUrl: p.giteaUrl,
		redirectUri: p.redirectUri,
		clientIdPresent: Boolean(p.clientId),
		clientSecretPresent: Boolean(p.clientSecret),
		accessTokenPresent: Boolean(p.accessToken),
		refreshTokenPresent: Boolean(p.refreshToken),
		expiresAt: p.expiresAt,
		scopes: p.scopes,
		lastAuthenticatedAt: p.lastAuthenticatedAt,
		ready,
	};
};

const requireGiteaAccess = async (
	giteaId: string,
	ctx: { userId: string; organizationId: string },
) => {
	const provider = await findGiteaById(giteaId);
	if (
		provider.gitProvider.organizationId !== ctx.organizationId &&
		provider.gitProvider.userId !== ctx.userId
	) {
		return null;
	}
	return provider;
};

const giteaBranchListParams = z.object({
	giteaId: z.string().min(1).describe("Gitea provider ID"),
	owner: z.string().min(1).describe("Repository owner"),
	repositoryName: z.string().min(1).describe("Repository name"),
	limit: z
		.number()
		.min(1)
		.max(200)
		.optional()
		.default(60)
		.describe("Maximum number of branches to return"),
});

const giteaProviderList: Tool<
	{ includeIncomplete?: boolean },
	GiteaProviderSummary[]
> = {
	name: "gitea_provider_list",
	description:
		"List Gitea providers for the current user and organization. Secrets/tokens are never returned.",
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

		let rows = await db.query.gitea.findMany({
			with: {
				gitProvider: true,
			},
			orderBy: [desc(giteaTable.giteaId)],
		});

		rows = rows.filter(
			(p) =>
				p.gitProvider.organizationId === ctx.organizationId &&
				p.gitProvider.userId === ctx.userId,
		);

		if (!params.includeIncomplete) {
			rows = rows.filter((p) => haveGiteaRequirements(p));
		}

		return {
			success: true,
			message: `Found ${rows.length} Gitea provider(s)`,
			data: rows.map((p) =>
				toSummary({
					giteaId: p.giteaId,
					giteaUrl: p.giteaUrl,
					redirectUri: p.redirectUri,
					clientId: p.clientId,
					clientSecret: p.clientSecret,
					accessToken: p.accessToken,
					refreshToken: p.refreshToken,
					expiresAt: p.expiresAt,
					scopes: p.scopes,
					lastAuthenticatedAt: p.lastAuthenticatedAt,
					gitProvider: {
						gitProviderId: p.gitProvider.gitProviderId,
						name: p.gitProvider.name,
					},
				}),
			),
		};
	},
};

const giteaProviderGet: Tool<{ giteaId: string }, GiteaProviderSummary> = {
	name: "gitea_provider_get",
	description:
		"Get a single Gitea provider by ID (masked). Secrets/tokens are never returned.",
	category: "github",
	parameters: apiFindOneGitea,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		const provider = await requireGiteaAccess(params.giteaId, ctx);
		if (!provider) {
			return {
				success: false,
				message: "Gitea provider access denied",
				error: "UNAUTHORIZED",
				data: {
					giteaId: params.giteaId,
					gitProviderId: "",
					name: "",
					giteaUrl: "",
					redirectUri: null,
					clientIdPresent: false,
					clientSecretPresent: false,
					accessTokenPresent: false,
					refreshTokenPresent: false,
					expiresAt: null,
					scopes: null,
					lastAuthenticatedAt: null,
					ready: false,
				},
			};
		}

		return {
			success: true,
			message: "Gitea provider fetched",
			data: toSummary({
				giteaId: provider.giteaId,
				giteaUrl: provider.giteaUrl,
				redirectUri: provider.redirectUri,
				clientId: provider.clientId,
				clientSecret: provider.clientSecret,
				accessToken: provider.accessToken,
				refreshToken: provider.refreshToken,
				expiresAt: provider.expiresAt,
				scopes: provider.scopes,
				lastAuthenticatedAt: provider.lastAuthenticatedAt,
				gitProvider: {
					gitProviderId: provider.gitProvider.gitProviderId,
					name: provider.gitProvider.name,
				},
			}),
		};
	},
};

const giteaUrlGet: Tool<{ giteaId: string }, { giteaUrl: string }> = {
	name: "gitea_url_get",
	description: "Get the base URL of a Gitea provider",
	category: "github",
	parameters: apiFindOneGitea,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const provider = await requireGiteaAccess(params.giteaId, ctx);
		if (!provider) {
			return {
				success: false,
				message: "Gitea provider access denied",
				error: "UNAUTHORIZED",
				data: { giteaUrl: "" },
			};
		}
		return {
			success: true,
			message: "Gitea URL fetched",
			data: { giteaUrl: provider.giteaUrl },
		};
	},
};

const giteaRepositoryList: Tool<
	{ giteaId: string; limit?: number },
	Array<{ id: number; name: string; url: string; owner: { username: string } }>
> = {
	name: "gitea_repository_list",
	description: "List repositories accessible to a given Gitea provider",
	category: "github",
	parameters: z.object({
		giteaId: z.string().min(1).describe("Gitea provider ID"),
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
		if (!(await requireGiteaAccess(params.giteaId, ctx))) {
			return {
				success: false,
				message: "Gitea provider access denied",
				data: [],
			};
		}

		const repos = await getGiteaRepositories(params.giteaId);
		const limit = params.limit ?? 50;
		return {
			success: true,
			message: `Found ${Math.min(repos.length, limit)} repositor${repos.length === 1 ? "y" : "ies"}`,
			data: repos.slice(0, limit),
		};
	},
};

const giteaBranchList: Tool<
	z.infer<typeof giteaBranchListParams>,
	Array<{ name: string; commitId: string }>
> = {
	name: "gitea_branch_list",
	description: "List branches for a Gitea repository",
	category: "github",
	parameters: giteaBranchListParams,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const provider = await requireGiteaAccess(params.giteaId, ctx);
		if (!provider) {
			return {
				success: false,
				message: "Gitea provider access denied",
				data: [],
			};
		}

		const branches = await getGiteaBranches({
			giteaId: params.giteaId,
			owner: params.owner,
			repo: params.repositoryName,
		});
		const limit = params.limit ?? 60;
		const picked = branches.slice(0, limit);
		return {
			success: true,
			message: `Found ${picked.length} branch(es)`,
			data: picked.map((b) => ({
				name: b.name,
				commitId: b.commit.id,
			})),
		};
	},
};

const giteaTestConnectionTool: Tool<
	{ giteaId: string },
	{ repositories: number }
> = {
	name: "gitea_test_connection",
	description: "Test Gitea provider connection and return repository count",
	category: "github",
	parameters: z.object({
		giteaId: z.string().min(1).describe("Gitea provider ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		if (!(await requireGiteaAccess(params.giteaId, ctx))) {
			return {
				success: false,
				message: "Gitea provider access denied",
				error: "UNAUTHORIZED",
				data: { repositories: 0 },
			};
		}

		try {
			const repositories = await testGiteaConnection({
				giteaId: params.giteaId,
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
				message: "Gitea connection test failed",
				error: msg,
				data: { repositories: 0 },
			};
		}
	},
};

const giteaProviderCreate: Tool<
	z.infer<typeof apiCreateGitea> & { confirm: "CONFIRM_GITEA_PROVIDER_CHANGE" },
	{ giteaId: string; clientId: string | null; giteaUrl: string }
> = {
	name: "gitea_provider_create",
	description:
		"Create a new Gitea provider connection. Requires approval + confirm. Secrets/tokens are accepted but never returned.",
	category: "github",
	parameters: apiCreateGitea.extend({
		confirm: z.literal("CONFIRM_GITEA_PROVIDER_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const { confirm: _confirm, ...input } = params;
		const createInput: typeof apiCreateGitea._type = {
			name: input.name,
			giteaUrl: input.giteaUrl,
			redirectUri: input.redirectUri,
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			accessToken: input.accessToken,
			refreshToken: input.refreshToken,
			expiresAt: input.expiresAt,
			scopes: input.scopes,
			lastAuthenticatedAt: input.lastAuthenticatedAt,
		};

		try {
			const created = await createGitea(
				createInput,
				ctx.organizationId,
				ctx.userId,
			);
			return {
				success: true,
				message: "Gitea provider created",
				data: created,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Error creating this Gitea provider",
				error: msg,
				data: { giteaId: "", clientId: null, giteaUrl: "" },
			};
		}
	},
};

const giteaProviderUpdate: Tool<
	z.infer<typeof apiUpdateGitea> & { confirm: "CONFIRM_GITEA_PROVIDER_CHANGE" },
	{ updated: boolean }
> = {
	name: "gitea_provider_update",
	description:
		"Update an existing Gitea provider connection. Requires approval + confirm. Secrets/tokens are accepted but never returned.",
	category: "github",
	parameters: apiUpdateGitea.extend({
		confirm: z.literal("CONFIRM_GITEA_PROVIDER_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const { confirm: _confirm, ...input } = params;

		const existing = await requireGiteaAccess(params.giteaId, ctx);
		if (!existing) {
			return {
				success: false,
				message: "Gitea provider access denied",
				error: "UNAUTHORIZED",
				data: { updated: false },
			};
		}

		if (existing.gitProvider.gitProviderId !== params.gitProviderId) {
			return {
				success: false,
				message: "gitProviderId mismatch for this gitea provider",
				error: "BAD_REQUEST",
				data: { updated: false },
			};
		}

		try {
			if (params.name) {
				await updateGitProvider(params.gitProviderId, {
					name: params.name,
					organizationId: ctx.organizationId,
				});
			}

			const updateInput: Partial<Gitea> = {
				giteaUrl: input.giteaUrl,
				redirectUri: input.redirectUri,
				clientId: input.clientId,
				clientSecret: input.clientSecret,
				accessToken: input.accessToken,
				refreshToken: input.refreshToken,
				expiresAt: input.expiresAt,
				scopes: input.scopes,
				lastAuthenticatedAt: input.lastAuthenticatedAt,
			};

			await updateGitea(params.giteaId, updateInput);

			return {
				success: true,
				message: "Gitea provider updated",
				data: { updated: true },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Error updating this Gitea provider",
				error: msg,
				data: { updated: false },
			};
		}
	},
};

export function registerGiteaTools() {
	toolRegistry.register(giteaProviderList);
	toolRegistry.register(giteaProviderGet);
	toolRegistry.register(giteaUrlGet);
	toolRegistry.register(giteaRepositoryList);
	toolRegistry.register(giteaBranchList);
	toolRegistry.register(giteaTestConnectionTool);
	toolRegistry.register(giteaProviderCreate);
	toolRegistry.register(giteaProviderUpdate);
}

import { db } from "@dokploy/server/db";
import { findGithubById } from "@dokploy/server/services/github";
import {
	authGithub,
	getGithubBranches,
	getGithubRepositories,
} from "@dokploy/server/utils/providers/github";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const listGithubProviders: Tool<
	Record<string, never>,
	Array<{ githubId: string; name: string; gitProviderId: string }>
> = {
	name: "github_provider_list",
	description:
		"List GitHub providers (connected GitHub accounts) available in the organization.",
	category: "github",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const providers = await db.query.github.findMany({
			with: {
				gitProvider: true,
			},
		});

		const filtered = providers.filter((p) => {
			return p.gitProvider?.organizationId === ctx.organizationId;
		});

		return {
			success: true,
			message: `Found ${filtered.length} GitHub provider(s)`,
			data: filtered.map((p) => ({
				githubId: p.githubId,
				name: p.gitProvider?.name ?? "GitHub",
				gitProviderId: p.gitProviderId,
			})),
		};
	},
};

const listGithubRepositories: Tool<
	{ githubId: string; limit?: number },
	Array<{
		owner: string;
		repository: string;
		fullName: string;
		private: boolean;
		defaultBranch: string;
	}>
> = {
	name: "github_repository_list",
	description:
		"List repositories accessible to a given GitHub provider connection (GitHub App installation).",
	category: "github",
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
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
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: [],
			};
		}

		const repos = await getGithubRepositories(params.githubId);
		const limit = params.limit ?? 50;
		const picked = repos.slice(0, limit);

		return {
			success: true,
			message: `Found ${picked.length} repositor${picked.length === 1 ? "y" : "ies"}`,
			data: picked
				.map((r) => ({
					owner: r.owner?.login ?? "",
					repository: r.name ?? "",
					fullName: r.full_name ?? "",
					private: Boolean(r.private),
					defaultBranch: r.default_branch ?? "main",
				}))
				.filter((x) => x.owner && x.repository),
		};
	},
};

const listGithubBranches: Tool<
	{ githubId: string; owner: string; repo: string; limit?: number },
	Array<{ name: string; protected: boolean }>
> = {
	name: "github_branch_list",
	description: "List branches for a GitHub repository",
	category: "github",
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		limit: z
			.number()
			.min(1)
			.max(200)
			.optional()
			.default(60)
			.describe("Maximum number of branches to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: [],
			};
		}

		const branches = await getGithubBranches({
			githubId: params.githubId,
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
				protected: Boolean(b.protected),
			})),
		};
	},
};

const createRepoBranch: Tool<
	{
		githubId: string;
		owner: string;
		repo: string;
		branch: string;
		fromBranch: string;
	},
	{ branch: string }
> = {
	name: "github_branch_create",
	description: "Create a new branch in a GitHub repository",
	category: "github",
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		branch: z.string().min(1).describe("New branch name"),
		fromBranch: z
			.string()
			.min(1)
			.default("main")
			.describe("Base branch to create from"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: { branch: "" },
			};
		}

		const octokit = authGithub(provider);
		const baseRef = await octokit.rest.git.getRef({
			owner: params.owner,
			repo: params.repo,
			ref: `heads/${params.fromBranch}`,
		});
		const sha = baseRef.data.object.sha;

		try {
			await octokit.rest.git.createRef({
				owner: params.owner,
				repo: params.repo,
				ref: `refs/heads/${params.branch}`,
				sha,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create branch",
				error: msg,
				data: { branch: "" },
			};
		}

		return {
			success: true,
			message: `Branch "${params.branch}" created from "${params.fromBranch}"`,
			data: { branch: params.branch },
		};
	},
};

const getRepoFile: Tool<
	{ githubId: string; owner: string; repo: string; path: string; ref?: string },
	{ path: string; content: string; sha: string }
> = {
	name: "github_file_get",
	description: "Get a file's content from a GitHub repository at a given ref",
	category: "github",
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		path: z.string().min(1).describe("File path in repository"),
		ref: z.string().optional().describe("Branch name or commit SHA"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: { path: "", content: "", sha: "" },
			};
		}

		const octokit = authGithub(provider);
		const res = await octokit.rest.repos.getContent({
			owner: params.owner,
			repo: params.repo,
			path: params.path,
			ref: params.ref,
		});

		if (Array.isArray(res.data) || res.data.type !== "file") {
			return {
				success: false,
				message: "Path is not a file",
				data: { path: params.path, content: "", sha: "" },
			};
		}

		const encoded = res.data.content ?? "";
		const content = Buffer.from(encoded, "base64").toString("utf8");
		return {
			success: true,
			message: `File "${params.path}" fetched`,
			data: {
				path: params.path,
				content,
				sha: res.data.sha,
			},
		};
	},
};

const upsertRepoFile: Tool<
	{
		githubId: string;
		owner: string;
		repo: string;
		branch: string;
		path: string;
		content: string;
		message: string;
		sha?: string;
	},
	{ path: string; commitSha: string }
> = {
	name: "github_file_upsert",
	description:
		"Create or update a file in a GitHub repository branch (createOrUpdateFileContents)",
	category: "github",
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		branch: z.string().min(1).describe("Branch to commit to"),
		path: z.string().min(1).describe("File path in repository"),
		content: z.string().describe("New file content (raw string, not base64)"),
		message: z.string().min(1).describe("Commit message"),
		sha: z
			.string()
			.optional()
			.describe("Existing file SHA. If omitted, tool will try to detect it."),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: { path: "", commitSha: "" },
			};
		}

		const octokit = authGithub(provider);

		let sha = params.sha;
		if (!sha) {
			try {
				const current = await octokit.rest.repos.getContent({
					owner: params.owner,
					repo: params.repo,
					path: params.path,
					ref: params.branch,
				});
				if (!Array.isArray(current.data) && current.data.type === "file") {
					sha = current.data.sha;
				}
			} catch {}
		}

		const res = await octokit.rest.repos.createOrUpdateFileContents({
			owner: params.owner,
			repo: params.repo,
			path: params.path,
			branch: params.branch,
			message: params.message,
			content: Buffer.from(params.content, "utf8").toString("base64"),
			...(sha ? { sha } : {}),
		});

		const commitSha = res.data.commit?.sha;
		if (!commitSha) {
			return {
				success: false,
				message: "File commit succeeded but commit SHA was missing in response",
				error: "Missing commit SHA",
				data: { path: params.path, commitSha: "" },
			};
		}

		return {
			success: true,
			message: `File "${params.path}" committed to "${params.branch}"`,
			data: {
				path: params.path,
				commitSha,
			},
		};
	},
};

const createPullRequest: Tool<
	{
		githubId: string;
		owner: string;
		repo: string;
		head: string;
		base: string;
		title: string;
		body?: string;
	},
	{ url: string; number: number }
> = {
	name: "github_pull_request_create",
	description: "Create a GitHub pull request",
	category: "github",
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		head: z.string().min(1).describe("Head branch (e.g. fix-branch)"),
		base: z.string().min(1).describe("Base branch (e.g. main)"),
		title: z.string().min(1).describe("Pull request title"),
		body: z.string().optional().describe("Pull request description"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: { url: "", number: 0 },
			};
		}

		const octokit = authGithub(provider);
		const pr = await octokit.rest.pulls.create({
			owner: params.owner,
			repo: params.repo,
			head: params.head,
			base: params.base,
			title: params.title,
			body: params.body ?? "",
			maintainer_can_modify: true,
		});

		return {
			success: true,
			message: `Pull request #${pr.data.number} created`,
			data: {
				url: pr.data.html_url,
				number: pr.data.number,
			},
		};
	},
};

export function registerGithubTools() {
	toolRegistry.register(listGithubProviders);
	toolRegistry.register(listGithubRepositories);
	toolRegistry.register(listGithubBranches);
	toolRegistry.register(createRepoBranch);
	toolRegistry.register(getRepoFile);
	toolRegistry.register(upsertRepoFile);
	toolRegistry.register(createPullRequest);
}

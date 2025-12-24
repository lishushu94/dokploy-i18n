import {
	deployApplication,
	findApplicationById,
	updateApplication,
} from "@dokploy/server/services/application";
import {
	deployCompose,
	findComposeById,
	updateCompose,
} from "@dokploy/server/services/compose";
import { findMemberById } from "@dokploy/server/services/user";
import { getEnviromentVariablesObject } from "@dokploy/server/utils/docker/utils";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolResult } from "../types";

type EnvUpdateSummary = {
	updatedKeys: string[];
	addedKeys: string[];
	applied: boolean;
};

type EnvMaskedSummary = {
	keys: string[];
	total: number;
};

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const listEnvKeysFromText = (envText: string | null): string[] => {
	const raw = envText ?? "";
	const keys = new Set<string>();
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		if (ENV_KEY_REGEX.test(key)) keys.add(key);
	}
	return [...keys].sort();
};

const validateEnvUpdates = (updates: Record<string, string>) => {
	for (const [key, value] of Object.entries(updates)) {
		if (!ENV_KEY_REGEX.test(key)) {
			throw new Error(`Invalid env var key: ${key}`);
		}
		if (value.includes("\n") || value.includes("\r")) {
			throw new Error(`Env var value for ${key} must not contain newlines`);
		}
	}
};

const getLineEnding = (raw: string) => (raw.includes("\r\n") ? "\r\n" : "\n");

const applyEnvUpdatesToText = (
	envText: string | null,
	updates: Record<string, string>,
): { nextEnvText: string; updatedKeys: string[]; addedKeys: string[] } => {
	validateEnvUpdates(updates);

	const raw = envText ?? "";
	const eol = getLineEnding(raw);
	const endedWithEol = raw.endsWith("\n") || raw.endsWith("\r\n");

	const originalLines = raw.split(/\r?\n/);
	const lines =
		originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
			? originalLines.slice(0, -1)
			: originalLines;

	const remaining = new Map(Object.entries(updates));
	const updatedKeys = new Set<string>();

	const nextLines = lines.map((line) => {
		const trimmedStart = line.trimStart();
		if (trimmedStart.startsWith("#") || !line.includes("=")) return line;

		const idx = line.indexOf("=");
		const key = line.slice(0, idx).trim();
		if (!remaining.has(key)) return line;

		updatedKeys.add(key);
		const v = remaining.get(key) ?? "";
		remaining.delete(key);
		return `${key}=${v}`;
	});

	const addedKeys: string[] = [];
	for (const [key, value] of remaining.entries()) {
		addedKeys.push(key);
		nextLines.push(`${key}=${value}`);
	}

	const nextEnvText = nextLines.join(eol) + (endedWithEol ? eol : "");
	return {
		nextEnvText,
		updatedKeys: [...updatedKeys],
		addedKeys,
	};
};

const applicationAccessDeniedMasked = (
	_applicationId: string,
): ToolResult<EnvMaskedSummary> => ({
	success: false,
	message: "Application access denied",
	error: "UNAUTHORIZED",
	data: { keys: [], total: 0 },
});

const applicationAccessDeniedReveal = (
	_applicationId: string,
): ToolResult<Record<string, string>> => ({
	success: false,
	message: "Application access denied",
	error: "UNAUTHORIZED",
	data: {},
});

const applicationAccessDeniedSet = (
	_applicationId: string,
): ToolResult<EnvUpdateSummary> => ({
	success: false,
	message: "Application access denied",
	error: "UNAUTHORIZED",
	data: { updatedKeys: [], addedKeys: [], applied: false },
});

const composeAccessDeniedMasked = (
	_composeId: string,
): ToolResult<EnvMaskedSummary> => ({
	success: false,
	message: "Compose access denied",
	error: "UNAUTHORIZED",
	data: { keys: [], total: 0 },
});

const composeAccessDeniedReveal = (
	_composeId: string,
): ToolResult<Record<string, string>> => ({
	success: false,
	message: "Compose access denied",
	error: "UNAUTHORIZED",
	data: {},
});

const composeAccessDeniedSet = (
	_composeId: string,
): ToolResult<EnvUpdateSummary> => ({
	success: false,
	message: "Compose access denied",
	error: "UNAUTHORIZED",
	data: { updatedKeys: [], addedKeys: [], applied: false },
});

const envApplicationGetMasked: Tool<
	{ applicationId: string },
	EnvMaskedSummary
> = {
	name: "env_application_get_masked",
	description:
		"Get application environment variables (masked): returns keys and counts only (no values).",
	category: "application",
	parameters: z.object({
		applicationId: z.string().min(1),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const app = await findApplicationById(params.applicationId);
		if (app.environment?.project?.organizationId !== ctx.organizationId) {
			return applicationAccessDeniedMasked(params.applicationId);
		}

		const keys = listEnvKeysFromText(app.env);
		return {
			success: true,
			message: `Found ${keys.length} env key(s)`,
			data: {
				keys,
				total: keys.length,
			},
		};
	},
};

const envApplicationReveal: Tool<
	{ applicationId: string; revealKeys: string[] },
	Record<string, string>
> = {
	name: "env_application_reveal",
	description:
		"Reveal specific application environment variable values (requires approval).",
	category: "application",
	parameters: z.object({
		applicationId: z.string().min(1),
		revealKeys: z.array(z.string().min(1)).min(1),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const app = await findApplicationById(params.applicationId);
		if (app.environment?.project?.organizationId !== ctx.organizationId) {
			return applicationAccessDeniedReveal(params.applicationId);
		}

		let resolved: Record<string, string>;
		try {
			resolved = getEnviromentVariablesObject(
				app.env,
				app.environment?.project?.env,
				app.environment?.env,
			);
		} catch (error) {
			return {
				success: false,
				message: "Failed to resolve environment variables",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const out: Record<string, string> = {};
		for (const key of params.revealKeys) {
			if (resolved[key] !== undefined) out[key] = resolved[key];
		}

		return {
			success: true,
			message: `Revealed ${Object.keys(out).length} env key(s)`,
			data: out,
		};
	},
};

const envApplicationSet: Tool<
	{
		applicationId: string;
		updates: Record<string, string>;
		apply?: boolean;
		confirm: "CONFIRM_ENV_UPDATE";
	},
	EnvUpdateSummary
> = {
	name: "env_application_set",
	description:
		"Set application environment variables (requires approval + confirm). Optionally trigger deploy.",
	category: "application",
	parameters: z.object({
		applicationId: z.string().min(1),
		updates: z.record(z.string()),
		apply: z.boolean().optional().default(false),
		confirm: z.literal("CONFIRM_ENV_UPDATE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const app = await findApplicationById(params.applicationId);
		if (app.environment?.project?.organizationId !== ctx.organizationId) {
			return applicationAccessDeniedSet(params.applicationId);
		}

		const { nextEnvText, updatedKeys, addedKeys } = applyEnvUpdatesToText(
			app.env,
			params.updates,
		);

		await updateApplication(params.applicationId, {
			env: nextEnvText,
		});

		if (params.apply) {
			await deployApplication({
				applicationId: params.applicationId,
				titleLog: "AI-triggered deploy after env update",
				descriptionLog: "Environment variables updated by AI tool",
			});
		}

		return {
			success: true,
			message: params.apply
				? "Environment variables updated and deploy triggered"
				: "Environment variables updated",
			data: {
				updatedKeys,
				addedKeys,
				applied: Boolean(params.apply),
			},
		};
	},
};

const envComposeGetMasked: Tool<{ composeId: string }, EnvMaskedSummary> = {
	name: "env_compose_get_masked",
	description:
		"Get compose environment variables (masked): returns keys and counts only (no values).",
	category: "compose",
	parameters: z.object({
		composeId: z.string().min(1),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const c = await findComposeById(params.composeId);
		if (c.environment?.project?.organizationId !== ctx.organizationId) {
			return composeAccessDeniedMasked(params.composeId);
		}

		const keys = listEnvKeysFromText(c.env);
		return {
			success: true,
			message: `Found ${keys.length} env key(s)`,
			data: {
				keys,
				total: keys.length,
			},
		};
	},
};

const envComposeReveal: Tool<
	{ composeId: string; revealKeys: string[] },
	Record<string, string>
> = {
	name: "env_compose_reveal",
	description:
		"Reveal specific compose environment variable values (requires approval).",
	category: "compose",
	parameters: z.object({
		composeId: z.string().min(1),
		revealKeys: z.array(z.string().min(1)).min(1),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const c = await findComposeById(params.composeId);
		if (c.environment?.project?.organizationId !== ctx.organizationId) {
			return composeAccessDeniedReveal(params.composeId);
		}

		let resolved: Record<string, string>;
		try {
			resolved = getEnviromentVariablesObject(
				c.env,
				c.environment?.project?.env,
				c.environment?.env,
			);
		} catch (error) {
			return {
				success: false,
				message: "Failed to resolve environment variables",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const out: Record<string, string> = {};
		for (const key of params.revealKeys) {
			if (resolved[key] !== undefined) out[key] = resolved[key];
		}

		return {
			success: true,
			message: `Revealed ${Object.keys(out).length} env key(s)`,
			data: out,
		};
	},
};

const envComposeSet: Tool<
	{
		composeId: string;
		updates: Record<string, string>;
		apply?: boolean;
		confirm: "CONFIRM_ENV_UPDATE";
	},
	EnvUpdateSummary
> = {
	name: "env_compose_set",
	description:
		"Set compose environment variables (requires approval + confirm). Optionally trigger deploy.",
	category: "compose",
	parameters: z.object({
		composeId: z.string().min(1),
		updates: z.record(z.string()),
		apply: z.boolean().optional().default(false),
		confirm: z.literal("CONFIRM_ENV_UPDATE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const c = await findComposeById(params.composeId);
		if (c.environment?.project?.organizationId !== ctx.organizationId) {
			return composeAccessDeniedSet(params.composeId);
		}

		const { nextEnvText, updatedKeys, addedKeys } = applyEnvUpdatesToText(
			c.env,
			params.updates,
		);

		await updateCompose(params.composeId, {
			env: nextEnvText,
		});

		if (params.apply) {
			await deployCompose({
				composeId: params.composeId,
				titleLog: "AI-triggered deploy after env update",
				descriptionLog: "Environment variables updated by AI tool",
			});
		}

		return {
			success: true,
			message: params.apply
				? "Environment variables updated and deploy triggered"
				: "Environment variables updated",
			data: {
				updatedKeys,
				addedKeys,
				applied: Boolean(params.apply),
			},
		};
	},
};

export function registerEnvVarTools() {
	toolRegistry.register(envApplicationGetMasked);
	toolRegistry.register(envApplicationReveal);
	toolRegistry.register(envApplicationSet);
	toolRegistry.register(envComposeGetMasked);
	toolRegistry.register(envComposeReveal);
	toolRegistry.register(envComposeSet);
}

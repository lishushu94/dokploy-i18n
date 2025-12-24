import path from "node:path";
import { db } from "@dokploy/server/db";
import {
	mounts as mountsTable,
	organization as organizationTable,
} from "@dokploy/server/db/schema";
import {
	deployApplication,
	findApplicationById,
} from "@dokploy/server/services/application";
import {
	deployCompose,
	findComposeById,
} from "@dokploy/server/services/compose";
import {
	deployMariadb,
	findMariadbById,
} from "@dokploy/server/services/mariadb";
import { deployMongo, findMongoById } from "@dokploy/server/services/mongo";
import {
	createMount,
	deleteMount,
	findMountById,
	findMountOrganizationId,
	updateMount,
} from "@dokploy/server/services/mount";
import { deployMySql, findMySqlById } from "@dokploy/server/services/mysql";
import {
	deployPostgres,
	findPostgresById,
} from "@dokploy/server/services/postgres";
import { deployRedis, findRedisById } from "@dokploy/server/services/redis";
import { findMemberById } from "@dokploy/server/services/user";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

type OrgAiPolicies = {
	bindMountAllowPrefixes?: string[];
};

type OrgMetadata = {
	aiPolicies?: OrgAiPolicies;
	[key: string]: unknown;
};

const parseMetadata = (metadata: string | null): OrgMetadata => {
	if (!metadata) return {};
	try {
		const parsed = JSON.parse(metadata) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed as OrgMetadata;
	} catch {
		return {};
	}
};

const getMountServiceRef = (mount: {
	serviceType: string;
	applicationId: string | null;
	composeId: string | null;
	postgresId: string | null;
	mysqlId: string | null;
	mariadbId: string | null;
	mongoId: string | null;
	redisId: string | null;
}): {
	serviceType:
		| "application"
		| "compose"
		| "postgres"
		| "mysql"
		| "mariadb"
		| "mongo"
		| "redis";
	serviceId: string;
} | null => {
	switch (mount.serviceType) {
		case "application":
			return mount.applicationId
				? { serviceType: "application", serviceId: mount.applicationId }
				: null;
		case "compose":
			return mount.composeId
				? { serviceType: "compose", serviceId: mount.composeId }
				: null;
		case "postgres":
			return mount.postgresId
				? { serviceType: "postgres", serviceId: mount.postgresId }
				: null;
		case "mysql":
			return mount.mysqlId
				? { serviceType: "mysql", serviceId: mount.mysqlId }
				: null;
		case "mariadb":
			return mount.mariadbId
				? { serviceType: "mariadb", serviceId: mount.mariadbId }
				: null;
		case "mongo":
			return mount.mongoId
				? { serviceType: "mongo", serviceId: mount.mongoId }
				: null;
		case "redis":
			return mount.redisId
				? { serviceType: "redis", serviceId: mount.redisId }
				: null;
		default:
			return null;
	}
};

const normalizePosixPath = (p: string) => {
	const replaced = String(p ?? "")
		.trim()
		.replace(/\\/g, "/");
	return path.posix.normalize(replaced);
};

const isUnderPrefix = (hostPath: string, prefix: string) => {
	const hp = normalizePosixPath(hostPath);
	let pre = normalizePosixPath(prefix);
	if (pre !== "/") pre = pre.replace(/\/+$/, "");
	if (hp === pre) return true;
	return hp.startsWith(`${pre}/`);
};

const getBindMountAllowPrefixes = async (organizationId: string) => {
	const org = await db.query.organization.findFirst({
		where: eq(organizationTable.id, organizationId),
	});
	const meta = parseMetadata(org?.metadata ?? null);
	const raw = meta.aiPolicies?.bindMountAllowPrefixes ?? [];
	return raw.map((p) => String(p ?? "").trim()).filter((p) => p.length > 0);
};

const checkBindMountAllowed = async (
	organizationId: string,
	hostPath: string,
) => {
	const prefixes = await getBindMountAllowPrefixes(organizationId);
	return prefixes.some((p) => isUnderPrefix(hostPath, p));
};

const getServiceOrganizationId = async (
	serviceType:
		| "application"
		| "compose"
		| "postgres"
		| "mysql"
		| "mariadb"
		| "mongo"
		| "redis",
	serviceId: string,
) => {
	switch (serviceType) {
		case "application": {
			const a = await findApplicationById(serviceId);
			return a.environment.project.organizationId;
		}
		case "compose": {
			const c = await findComposeById(serviceId);
			return c.environment.project.organizationId;
		}
		case "postgres": {
			const p = await findPostgresById(serviceId);
			return p.environment.project.organizationId;
		}
		case "mysql": {
			const m = await findMySqlById(serviceId);
			return m.environment.project.organizationId;
		}
		case "mariadb": {
			const m = await findMariadbById(serviceId);
			return m.environment.project.organizationId;
		}
		case "mongo": {
			const m = await findMongoById(serviceId);
			return m.environment.project.organizationId;
		}
		case "redis": {
			const r = await findRedisById(serviceId);
			return r.environment.project.organizationId;
		}
	}
};

const listMountsByService = async (
	serviceType:
		| "application"
		| "compose"
		| "postgres"
		| "mysql"
		| "mariadb"
		| "mongo"
		| "redis",
	serviceId: string,
) => {
	const conditions = [];
	switch (serviceType) {
		case "application":
			conditions.push(eq(mountsTable.applicationId, serviceId));
			break;
		case "compose":
			conditions.push(eq(mountsTable.composeId, serviceId));
			break;
		case "postgres":
			conditions.push(eq(mountsTable.postgresId, serviceId));
			break;
		case "mysql":
			conditions.push(eq(mountsTable.mysqlId, serviceId));
			break;
		case "mariadb":
			conditions.push(eq(mountsTable.mariadbId, serviceId));
			break;
		case "mongo":
			conditions.push(eq(mountsTable.mongoId, serviceId));
			break;
		case "redis":
			conditions.push(eq(mountsTable.redisId, serviceId));
			break;
	}

	return db.query.mounts.findMany({
		where: and(...conditions),
	});
};

const triggerApplyIfRequested = async (
	serviceType:
		| "application"
		| "compose"
		| "postgres"
		| "mysql"
		| "mariadb"
		| "mongo"
		| "redis",
	serviceId: string,
	apply: boolean,
) => {
	if (!apply) return;
	if (!serviceId) {
		throw new Error("Cannot apply changes: serviceId is missing");
	}
	switch (serviceType) {
		case "application": {
			await deployApplication({
				applicationId: serviceId,
				titleLog: "AI-triggered deploy after mount change",
				descriptionLog: "Mount change applied by AI tool",
			});
			return;
		}
		case "compose": {
			await deployCompose({
				composeId: serviceId,
				titleLog: "AI-triggered deploy after mount change",
				descriptionLog: "Mount change applied by AI tool",
			});
			return;
		}
		case "postgres":
			await deployPostgres(serviceId);
			return;
		case "mysql":
			await deployMySql(serviceId);
			return;
		case "mariadb":
			await deployMariadb(serviceId);
			return;
		case "mongo":
			await deployMongo(serviceId);
			return;
		case "redis":
			await deployRedis(serviceId);
			return;
	}
};

const mountList: Tool<
	{
		serviceType:
			| "application"
			| "compose"
			| "postgres"
			| "mysql"
			| "mariadb"
			| "mongo"
			| "redis";
		serviceId: string;
	},
	Array<{
		mountId: string;
		type: string;
		mountPath: string;
		hostPath?: string | null;
		volumeName?: string | null;
		filePath?: string | null;
	}>
> = {
	name: "mount_list",
	description:
		"List mounts for a service (application/compose/database). Read-only.",
	category: "server",
	parameters: z.object({
		serviceType: z.enum([
			"application",
			"compose",
			"postgres",
			"mysql",
			"mariadb",
			"mongo",
			"redis",
		]),
		serviceId: z.string().min(1),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const orgId = await getServiceOrganizationId(
			params.serviceType,
			params.serviceId,
		);
		if (orgId !== ctx.organizationId) {
			return { success: false, message: "Service access denied" };
		}

		const items = await listMountsByService(
			params.serviceType,
			params.serviceId,
		);
		return {
			success: true,
			message: `Found ${items.length} mount(s)`,
			data: items.map((m) => ({
				mountId: m.mountId,
				type: m.type,
				mountPath: m.mountPath,
				hostPath: m.hostPath,
				volumeName: m.volumeName,
				filePath: m.filePath,
			})),
		};
	},
};

const mountCreate: Tool<
	{
		serviceType:
			| "application"
			| "compose"
			| "postgres"
			| "mysql"
			| "mariadb"
			| "mongo"
			| "redis";
		serviceId: string;
		type: "bind" | "volume" | "file";
		mountPath: string;
		hostPath?: string;
		volumeName?: string;
		filePath?: string;
		content?: string;
		apply?: boolean;
		confirm: "CONFIRM_MOUNT_CHANGE";
	},
	{
		mountId: string;
		applied: boolean;
		suggestedNextSteps?: unknown;
	}
> = {
	name: "mount_create",
	description:
		"Create a mount (volume/bind/file) for a service. bind mounts require allowlist. Requires approval + confirm.",
	category: "server",
	parameters: z
		.object({
			serviceType: z.enum([
				"application",
				"compose",
				"postgres",
				"mysql",
				"mariadb",
				"mongo",
				"redis",
			]),
			serviceId: z.string().min(1),
			type: z.enum(["bind", "volume", "file"]),
			mountPath: z.string().min(1),
			hostPath: z.string().optional(),
			volumeName: z.string().optional(),
			filePath: z.string().optional(),
			content: z.string().optional(),
			apply: z.boolean().optional().default(false),
			confirm: z.literal("CONFIRM_MOUNT_CHANGE"),
		})
		.superRefine((v, ctx2) => {
			if (v.type === "bind" && !v.hostPath) {
				ctx2.addIssue({
					code: "custom",
					message: "hostPath is required for bind mounts",
				});
			}
			if (v.type === "volume" && !v.volumeName) {
				ctx2.addIssue({
					code: "custom",
					message: "volumeName is required for volume mounts",
				});
			}
			if (v.type === "file" && (!v.filePath || v.content === undefined)) {
				ctx2.addIssue({
					code: "custom",
					message: "filePath and content are required for file mounts",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const orgId = await getServiceOrganizationId(
			params.serviceType,
			params.serviceId,
		);
		if (orgId !== ctx.organizationId) {
			return { success: false, message: "Service access denied" };
		}

		if (params.type === "bind" && params.hostPath) {
			const allowed = await checkBindMountAllowed(
				ctx.organizationId,
				params.hostPath,
			);
			if (!allowed) {
				return {
					success: false,
					message:
						"Bind mount hostPath is not in allowlist. Update allowlist first, then retry mount_create.",
					data: {
						mountId: "",
						applied: false,
						suggestedNextSteps: [
							{
								tool: "org_bind_mount_allowlist_update",
								params: {
									addPrefixes: [params.hostPath],
									confirm: "CONFIRM_BIND_MOUNT_ALLOWLIST_UPDATE",
								},
							},
							{
								tool: "mount_create",
								params,
							},
						],
					},
				};
			}
		}

		const created = await createMount({
			serviceId: params.serviceId,
			serviceType: params.serviceType,
			type: params.type,
			mountPath: params.mountPath,
			hostPath: params.hostPath,
			volumeName: params.volumeName,
			filePath: params.filePath,
			content: params.content,
		});

		await triggerApplyIfRequested(
			params.serviceType,
			params.serviceId,
			Boolean(params.apply),
		);

		return {
			success: true,
			message: "Mount created",
			data: {
				mountId: created.mountId,
				applied: Boolean(params.apply),
			},
		};
	},
};

const mountUpdate: Tool<
	{
		mountId: string;
		type?: "bind" | "volume" | "file";
		mountPath?: string;
		hostPath?: string;
		volumeName?: string;
		filePath?: string;
		content?: string;
		apply?: boolean;
		confirm: "CONFIRM_MOUNT_CHANGE";
	},
	{
		mountId: string;
		applied: boolean;
		suggestedNextSteps?: unknown;
	}
> = {
	name: "mount_update",
	description:
		"Update an existing mount. bind mounts require allowlist. Requires approval + confirm.",
	category: "server",
	parameters: z.object({
		mountId: z.string().min(1),
		type: z.enum(["bind", "volume", "file"]).optional(),
		mountPath: z.string().min(1).optional(),
		hostPath: z.string().optional(),
		volumeName: z.string().optional(),
		filePath: z.string().optional(),
		content: z.string().optional(),
		apply: z.boolean().optional().default(false),
		confirm: z.literal("CONFIRM_MOUNT_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const orgId = await findMountOrganizationId(params.mountId);
		if (orgId !== ctx.organizationId) {
			return { success: false, message: "Mount access denied" };
		}

		const current = await findMountById(params.mountId);
		const nextType = params.type ?? current.type;
		const nextHostPath = params.hostPath ?? current.hostPath ?? undefined;

		if (nextType === "bind" && nextHostPath) {
			const allowed = await checkBindMountAllowed(
				ctx.organizationId,
				nextHostPath,
			);
			if (!allowed) {
				return {
					success: false,
					message:
						"Bind mount hostPath is not in allowlist. Update allowlist first, then retry mount_update.",
					data: {
						mountId: params.mountId,
						applied: false,
						suggestedNextSteps: [
							{
								tool: "org_bind_mount_allowlist_update",
								params: {
									addPrefixes: [nextHostPath],
									confirm: "CONFIRM_BIND_MOUNT_ALLOWLIST_UPDATE",
								},
							},
							{
								tool: "mount_update",
								params,
							},
						],
					},
				};
			}
		}

		await updateMount(params.mountId, {
			type: params.type,
			mountPath: params.mountPath,
			hostPath: params.hostPath,
			volumeName: params.volumeName,
			filePath: params.filePath,
			content: params.content,
		});

		const updated = await findMountById(params.mountId);
		const ref = getMountServiceRef(updated);
		if (params.apply && !ref) {
			return {
				success: false,
				message:
					"Mount updated, but could not determine service reference to apply deploy. Retry with apply=false or check mount/service linkage.",
				data: {
					mountId: params.mountId,
					applied: false,
				},
			};
		}
		if (ref) {
			await triggerApplyIfRequested(
				ref.serviceType,
				ref.serviceId,
				Boolean(params.apply),
			);
		}

		return {
			success: true,
			message: "Mount updated",
			data: {
				mountId: params.mountId,
				applied: Boolean(params.apply),
			},
		};
	},
};

const mountDelete: Tool<
	{
		mountId: string;
		apply?: boolean;
		confirm: "CONFIRM_MOUNT_CHANGE";
	},
	{ deleted: boolean; applied: boolean }
> = {
	name: "mount_delete",
	description:
		"Delete a mount. Requires approval + confirm. Optionally redeploys the service.",
	category: "server",
	parameters: z.object({
		mountId: z.string().min(1),
		apply: z.boolean().optional().default(false),
		confirm: z.literal("CONFIRM_MOUNT_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const orgId = await findMountOrganizationId(params.mountId);
		if (orgId !== ctx.organizationId) {
			return { success: false, message: "Mount access denied" };
		}

		const existing = await findMountById(params.mountId);
		const ref = getMountServiceRef(existing);
		if (params.apply && !ref) {
			return {
				success: false,
				message:
					"Cannot apply deploy: could not determine service reference for this mount.",
			};
		}

		await deleteMount(params.mountId);
		if (ref) {
			await triggerApplyIfRequested(
				ref.serviceType,
				ref.serviceId,
				Boolean(params.apply),
			);
		}

		return {
			success: true,
			message: "Mount deleted",
			data: { deleted: true, applied: Boolean(params.apply) },
		};
	},
};

export function registerMountTools() {
	toolRegistry.register(mountList);
	toolRegistry.register(mountCreate);
	toolRegistry.register(mountUpdate);
	toolRegistry.register(mountDelete);
}

import { existsSync, promises as fsPromises } from "node:fs";
import { db } from "@dokploy/server/db";
import {
	type apiRestoreBackup,
	backups as backupsTable,
	deployments,
} from "@dokploy/server/db/schema";
import {
	createBackup,
	findBackupById,
	removeBackupById,
} from "@dokploy/server/services/backup";
import { findComposeById } from "@dokploy/server/services/compose";
import {
	createDeploymentBackup,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findDestinationById } from "@dokploy/server/services/destination";
import { findMariadbById } from "@dokploy/server/services/mariadb";
import { findMongoById } from "@dokploy/server/services/mongo";
import { findMySqlById } from "@dokploy/server/services/mysql";
import { findPostgresById } from "@dokploy/server/services/postgres";
import { keepLatestNBackups } from "@dokploy/server/utils/backups";
import { runComposeBackup } from "@dokploy/server/utils/backups/compose";
import { runMariadbBackup } from "@dokploy/server/utils/backups/mariadb";
import { runMongoBackup } from "@dokploy/server/utils/backups/mongo";
import { runMySqlBackup } from "@dokploy/server/utils/backups/mysql";
import { runPostgresBackup } from "@dokploy/server/utils/backups/postgres";
import { runWebServerBackup } from "@dokploy/server/utils/backups/web-server";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { restoreComposeBackup } from "@dokploy/server/utils/restore/compose";
import { restoreMariadbBackup } from "@dokploy/server/utils/restore/mariadb";
import { restoreMongoBackup } from "@dokploy/server/utils/restore/mongo";
import { restoreMySqlBackup } from "@dokploy/server/utils/restore/mysql";
import { restorePostgresBackup } from "@dokploy/server/utils/restore/postgres";
import { restoreWebServerBackup } from "@dokploy/server/utils/restore/web-server";
import { and, desc, eq, or } from "drizzle-orm";
import { quote } from "shell-quote";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const listBackups: Tool<
	{ databaseId?: string; composeId?: string },
	Array<{
		backupId: string;
		database: string;
		schedule: string;
		destinationId: string;
		enabled: boolean;
	}>
> = {
	name: "backup_list",
	description: "List backup schedules for a database or compose service",
	category: "backup",
	parameters: z.object({
		databaseId: z.string().optional().describe("Filter by Database ID"),
		composeId: z.string().optional().describe("Filter by Compose ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const conditions = [];

		if (params.composeId) {
			conditions.push(eq(backupsTable.composeId, params.composeId));
		} else if (params.databaseId) {
			conditions.push(
				or(
					eq(backupsTable.postgresId, params.databaseId),
					eq(backupsTable.mysqlId, params.databaseId),
					eq(backupsTable.mariadbId, params.databaseId),
					eq(backupsTable.mongoId, params.databaseId),
				),
			);
		}

		const results = await db.query.backups.findMany({
			where: conditions.length > 0 ? and(...conditions) : undefined,
			with: {
				destination: true,
			},
			orderBy: desc(backupsTable.backupId),
		});

		const filtered = results.filter(
			(b) => b.destination?.organizationId === ctx.organizationId,
		);

		return {
			success: true,
			message: `Found ${filtered.length} backup schedule(s)`,
			data: filtered.map((b) => ({
				backupId: b.backupId,
				database: b.database,
				schedule: b.schedule,
				destinationId: b.destinationId,
				enabled: b.enabled || false,
			})),
		};
	},
};

const getBackupDetails: Tool<
	{ backupId: string },
	{ backupId: string; database: string; schedule: string; enabled: boolean }
> = {
	name: "backup_get",
	description: "Get details of a backup schedule",
	category: "backup",
	parameters: z.object({
		backupId: z.string().describe("The Backup ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const b = await findBackupById(params.backupId);
		if (b.destination?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Backup access denied",
				error: "UNAUTHORIZED",
				data: {
					backupId: params.backupId,
					database: "",
					schedule: "",
					enabled: false,
				},
			};
		}
		return {
			success: true,
			message: "Backup details retrieved",
			data: {
				backupId: b.backupId,
				database: b.database,
				schedule: b.schedule,
				enabled: b.enabled || false,
			},
		};
	},
};

const createBackupSchedule: Tool<
	{
		schedule: string;
		destinationId: string;
		databaseName: string;
		databaseType: "postgres" | "mysql" | "mariadb" | "mongo";
		databaseId: string;
		keepLatestCount?: number;
		enabled?: boolean;
		prefix?: string;
	},
	{ backupId: string }
> = {
	name: "backup_create",
	description: "Create a backup schedule for a database",
	category: "backup",
	parameters: z.object({
		schedule: z.string().describe("Cron expression (e.g. '0 0 * * *')"),
		destinationId: z.string().describe("Destination ID for storage"),
		databaseName: z.string().describe("Name of the database to backup"),
		databaseType: z
			.enum(["postgres", "mysql", "mariadb", "mongo"])
			.describe("Type of database"),
		databaseId: z.string().describe("The ID of the database service"),
		keepLatestCount: z.number().optional().default(5),
		enabled: z.boolean().optional().default(true),
		prefix: z.string().optional().default("backup"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const destination = await findDestinationById(params.destinationId);
		if (destination.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Destination access denied",
				error: "UNAUTHORIZED",
				data: { backupId: "" },
			};
		}
		const input: Record<string, unknown> = {
			schedule: params.schedule,
			destinationId: params.destinationId,
			database: params.databaseName,
			databaseType: params.databaseType,
			keepLatestCount: params.keepLatestCount,
			enabled: params.enabled,
			prefix: params.prefix || "backup",
			backupType: "database",
		};

		if (params.databaseType === "postgres")
			input.postgresId = params.databaseId;
		if (params.databaseType === "mysql") input.mysqlId = params.databaseId;
		if (params.databaseType === "mariadb") input.mariadbId = params.databaseId;
		if (params.databaseType === "mongo") input.mongoId = params.databaseId;

		const backup = await createBackup(
			input as Parameters<typeof createBackup>[0],
		);

		return {
			success: true,
			message: "Backup schedule created successfully",
			data: {
				backupId: backup.backupId,
			},
		};
	},
};

const deleteBackupSchedule: Tool<{ backupId: string }, { deleted: boolean }> = {
	name: "backup_delete",
	description: "Delete a backup schedule",
	category: "backup",
	parameters: z.object({
		backupId: z.string().describe("The Backup ID"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const b = await findBackupById(params.backupId);
		if (b.destination?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Backup access denied",
				error: "UNAUTHORIZED",
				data: { deleted: false },
			};
		}
		await removeBackupById(params.backupId);
		return {
			success: true,
			message: "Backup schedule deleted",
			data: { deleted: true },
		};
	},
};

const loadBackupForOrg = async (
	backupId: string,
	ctx: { organizationId: string },
) => {
	const backup = await findBackupById(backupId);
	const destination = backup.destination
		? backup.destination
		: await findDestinationById(backup.destinationId);
	if (destination.organizationId !== ctx.organizationId) {
		throw new Error("Backup access denied");
	}

	if (backup.backupType === "compose") {
		if (!backup.composeId) throw new Error("Compose backup missing composeId");
		const compose = await findComposeById(backup.composeId);
		if (compose.environment?.project?.organizationId !== ctx.organizationId) {
			throw new Error("Compose access denied");
		}
		return {
			kind: "compose" as const,
			backup,
			destination,
			serverId: compose.serverId ?? null,
			compose,
		};
	}

	switch (backup.databaseType) {
		case "postgres": {
			if (!backup.postgresId) throw new Error("Backup missing postgresId");
			const postgres = await findPostgresById(backup.postgresId);
			if (
				postgres.environment?.project?.organizationId !== ctx.organizationId
			) {
				throw new Error("Postgres access denied");
			}
			return {
				kind: "postgres" as const,
				backup,
				destination,
				serverId: postgres.serverId ?? null,
				postgres,
			};
		}
		case "mysql": {
			if (!backup.mysqlId) throw new Error("Backup missing mysqlId");
			const mysql = await findMySqlById(backup.mysqlId);
			if (mysql.environment?.project?.organizationId !== ctx.organizationId) {
				throw new Error("MySQL access denied");
			}
			return {
				kind: "mysql" as const,
				backup,
				destination,
				serverId: mysql.serverId ?? null,
				mysql,
			};
		}
		case "mariadb": {
			if (!backup.mariadbId) throw new Error("Backup missing mariadbId");
			const mariadb = await findMariadbById(backup.mariadbId);
			if (mariadb.environment?.project?.organizationId !== ctx.organizationId) {
				throw new Error("MariaDB access denied");
			}
			return {
				kind: "mariadb" as const,
				backup,
				destination,
				serverId: mariadb.serverId ?? null,
				mariadb,
			};
		}
		case "mongo": {
			if (!backup.mongoId) throw new Error("Backup missing mongoId");
			const mongo = await findMongoById(backup.mongoId);
			if (mongo.environment?.project?.organizationId !== ctx.organizationId) {
				throw new Error("Mongo access denied");
			}
			return {
				kind: "mongo" as const,
				backup,
				destination,
				serverId: mongo.serverId ?? null,
				mongo,
			};
		}
		case "web-server": {
			return {
				kind: "web-server" as const,
				backup,
				destination,
				serverId: null,
			};
		}
		default:
			throw new Error("Unsupported databaseType");
	}
};

const readLogLimited = async (input: {
	serverId: string | null;
	logPath: string;
	direction: "start" | "end";
	maxBytes: number;
}) => {
	const bytes = input.maxBytes;
	if (!input.logPath) return "";
	if (input.serverId) {
		const base = input.direction === "start" ? "head" : "tail";
		const cmd = `${base} -c ${bytes} ${quote([input.logPath])}`;
		const out = await execAsyncRemote(input.serverId, cmd);
		return (out.stdout || out.stderr || "").trim();
	}
	if (!existsSync(input.logPath)) return "";
	const content = await fsPromises.readFile(input.logPath, "utf8");
	if (content.length <= bytes) return content.trim();
	const sliced =
		input.direction === "start"
			? content.slice(0, bytes).trim()
			: content.slice(-bytes).trim();
	return `${sliced}\n...[TRUNCATED]`;
};

const runBackupNow: Tool<{ backupId: string }, { triggered: boolean }> = {
	name: "backup_run_now",
	description: "Run a backup schedule immediately",
	category: "backup",
	parameters: z.object({
		backupId: z.string().min(1).describe("Backup schedule ID"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		try {
			const loaded = await loadBackupForOrg(params.backupId, ctx);
			switch (loaded.kind) {
				case "compose":
					await runComposeBackup(loaded.compose, loaded.backup);
					await keepLatestNBackups(loaded.backup, loaded.serverId);
					break;
				case "postgres":
					await runPostgresBackup(loaded.postgres, loaded.backup);
					await keepLatestNBackups(loaded.backup, loaded.serverId);
					break;
				case "mysql":
					await runMySqlBackup(loaded.mysql, loaded.backup);
					await keepLatestNBackups(loaded.backup, loaded.serverId);
					break;
				case "mariadb":
					await runMariadbBackup(loaded.mariadb, loaded.backup);
					await keepLatestNBackups(loaded.backup, loaded.serverId);
					break;
				case "mongo":
					await runMongoBackup(loaded.mongo, loaded.backup);
					await keepLatestNBackups(loaded.backup, loaded.serverId);
					break;
				case "web-server":
					await runWebServerBackup(loaded.backup);
					await keepLatestNBackups(loaded.backup);
					break;
			}
			return {
				success: true,
				message: "Backup triggered",
				data: { triggered: true },
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to run backup",
				error: msg,
				data: { triggered: false },
			};
		}
	},
};

const getBackupLastResult: Tool<
	{ backupId: string; direction?: "start" | "end"; maxBytes?: number },
	{
		deploymentId: string;
		status: string;
		createdAt: string;
		startedAt: string | null;
		finishedAt: string | null;
		errorMessage: string | null;
		log: string;
	}
> = {
	name: "backup_last_result",
	description: "Get the latest backup execution result (deployment) and log",
	category: "backup",
	parameters: z.object({
		backupId: z.string().min(1).describe("Backup schedule ID"),
		direction: z.enum(["start", "end"]).optional().default("end"),
		maxBytes: z.number().int().min(1).max(500000).optional().default(200000),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		try {
			const loaded = await loadBackupForOrg(params.backupId, ctx);
			const last = await db.query.deployments.findFirst({
				where: eq(deployments.backupId, params.backupId),
				orderBy: desc(deployments.createdAt),
			});
			if (!last) {
				return {
					success: false,
					message: "No backup deployments found",
					error: "NOT_FOUND",
					data: {
						deploymentId: "",
						status: "unknown",
						createdAt: "",
						startedAt: null,
						finishedAt: null,
						errorMessage: null,
						log: "",
					},
				};
			}
			const log = await readLogLimited({
				serverId: loaded.serverId,
				logPath: last.logPath,
				direction: params.direction ?? "end",
				maxBytes: params.maxBytes ?? 200000,
			});
			return {
				success: true,
				message: "Backup last result retrieved",
				data: {
					deploymentId: last.deploymentId,
					status: last.status ?? "unknown",
					createdAt: last.createdAt,
					startedAt: last.startedAt ?? null,
					finishedAt: last.finishedAt ?? null,
					errorMessage: last.errorMessage ?? null,
					log,
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to get backup last result",
				error: msg,
				data: {
					deploymentId: "",
					status: "unknown",
					createdAt: "",
					startedAt: null,
					finishedAt: null,
					errorMessage: null,
					log: "",
				},
			};
		}
	},
};

const restoreBackupTool: Tool<
	{
		backupId: string;
		backupFile: string;
		databaseName?: string;
		confirm: "RESTORE";
	},
	{ restored: boolean; deploymentId: string; logPath: string; logs: string }
> = {
	name: "backup_restore",
	description:
		"Restore from a backup file stored in the destination. Destructive operation. Requires confirm=RESTORE.",
	category: "backup",
	parameters: z.object({
		backupId: z.string().min(1).describe("Backup schedule ID"),
		backupFile: z.string().min(1).describe("Backup file path in bucket"),
		databaseName: z
			.string()
			.optional()
			.describe("Target database name (defaults to schedule database)"),
		confirm: z.literal("RESTORE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		let deploymentId = "";
		let logPath = "";
		const logs: string[] = [];
		try {
			const loaded = await loadBackupForOrg(params.backupId, ctx);
			const deployment = await createDeploymentBackup({
				backupId: params.backupId,
				title: "Backup Restore",
				description: "Backup Restore",
			});
			deploymentId = deployment.deploymentId;
			logPath = deployment.logPath;
			const emit = (line: string) => {
				logs.push(line);
				if (logs.length > 500) logs.shift();
				try {
					if (!logPath) return;
					if (loaded.serverId) {
						void execAsyncRemote(
							loaded.serverId,
							`echo ${quote([line])} >> ${quote([logPath])}`,
						);
					} else {
						void fsPromises.appendFile(logPath, `${line}\n`);
					}
				} catch {
					// ignore
				}
			};

			const restoreInput: z.infer<typeof apiRestoreBackup> = {
				databaseId:
					loaded.kind === "compose"
						? loaded.compose.composeId
						: loaded.kind === "postgres"
							? loaded.postgres.postgresId
							: loaded.kind === "mysql"
								? loaded.mysql.mysqlId
								: loaded.kind === "mariadb"
									? loaded.mariadb.mariadbId
									: loaded.kind === "mongo"
										? loaded.mongo.mongoId
										: "web-server",
				databaseType: loaded.backup.databaseType,
				backupType: loaded.backup.backupType,
				databaseName: params.databaseName ?? loaded.backup.database,
				backupFile: params.backupFile,
				destinationId: loaded.backup.destinationId,
				metadata: loaded.backup.metadata
					? {
							serviceName: loaded.backup.serviceName ?? undefined,
							...(loaded.backup.metadata as any),
						}
					: loaded.backup.serviceName
						? { serviceName: loaded.backup.serviceName }
						: undefined,
			};

			switch (loaded.kind) {
				case "compose":
					await restoreComposeBackup(
						loaded.compose,
						loaded.destination,
						restoreInput,
						emit,
					);
					break;
				case "postgres":
					await restorePostgresBackup(
						loaded.postgres,
						loaded.destination,
						restoreInput,
						emit,
					);
					break;
				case "mysql":
					await restoreMySqlBackup(
						loaded.mysql,
						loaded.destination,
						restoreInput,
						emit,
					);
					break;
				case "mariadb":
					await restoreMariadbBackup(
						loaded.mariadb,
						loaded.destination,
						restoreInput,
						emit,
					);
					break;
				case "mongo":
					await restoreMongoBackup(
						loaded.mongo,
						loaded.destination,
						restoreInput,
						emit,
					);
					break;
				case "web-server":
					await restoreWebServerBackup(
						loaded.destination,
						params.backupFile,
						emit,
					);
					break;
			}

			await updateDeploymentStatus(deployment.deploymentId, "done");
			return {
				success: true,
				message: "Restore completed",
				data: {
					restored: true,
					deploymentId,
					logPath,
					logs: logs.join("\n"),
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (deploymentId) {
				try {
					await updateDeploymentStatus(deploymentId, "error");
				} catch {
					// ignore
				}
			}
			return {
				success: false,
				message: "Restore failed",
				error: msg,
				data: {
					restored: false,
					deploymentId,
					logPath,
					logs: logs.join("\n"),
				},
			};
		}
	},
};

export function registerBackupTools() {
	toolRegistry.register(listBackups);
	toolRegistry.register(getBackupDetails);
	toolRegistry.register(createBackupSchedule);
	toolRegistry.register(deleteBackupSchedule);
	toolRegistry.register(runBackupNow);
	toolRegistry.register(getBackupLastResult);
	toolRegistry.register(restoreBackupTool);
}

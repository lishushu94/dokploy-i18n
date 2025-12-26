import { existsSync, promises as fsPromises } from "node:fs";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose as composeTable,
	deployments,
	previewDeployments,
} from "@dokploy/server/db/schema";
import { updateDeploymentStatus } from "@dokploy/server/services/deployment";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { Queue } from "bullmq";
import { desc, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const getDeploymentsQueue = () => {
	return new Queue("deployments", {
		connection: {
			host:
				process.env.NODE_ENV === "production"
					? process.env.REDIS_HOST || "dokploy-redis"
					: "127.0.0.1",
		},
	});
};

const findLatestRunningDeploymentId = async (input: {
	applicationId?: string;
	composeId?: string;
	previewDeploymentId?: string;
}) => {
	if (input.applicationId) {
		const d = await db.query.deployments.findFirst({
			where: (t, { and, eq }) =>
				and(eq(t.applicationId, input.applicationId!), eq(t.status, "running")),
			orderBy: desc(deployments.createdAt),
		});
		return d?.deploymentId ?? null;
	}
	if (input.composeId) {
		const d = await db.query.deployments.findFirst({
			where: (t, { and, eq }) =>
				and(eq(t.composeId, input.composeId!), eq(t.status, "running")),
			orderBy: desc(deployments.createdAt),
		});
		return d?.deploymentId ?? null;
	}
	if (input.previewDeploymentId) {
		const d = await db.query.deployments.findFirst({
			where: (t, { and, eq }) =>
				and(
					eq(t.previewDeploymentId, input.previewDeploymentId!),
					eq(t.status, "running"),
				),
			orderBy: desc(deployments.createdAt),
		});
		return d?.deploymentId ?? null;
	}
	return null;
};

const killRunningDeployments = async (
	target: "application" | "compose" | "preview",
	serverId: string | null,
) => {
	const cmd =
		target === "compose"
			? 'pkill -2 -f "docker compose"; pkill -2 -f "docker stack";'
			: 'pkill -2 -f "docker build";';

	if (serverId) {
		await execAsyncRemote(serverId, cmd);
		return;
	}
	await execAsync(cmd);
};

const listDeployments: Tool<
	{ applicationId?: string; composeId?: string; limit?: number },
	Array<{
		deploymentId: string;
		title: string;
		status: string;
		createdAt: string;
		startedAt: string | null;
		finishedAt: string | null;
		errorMessage: string | null;
	}>
> = {
	name: "deployment_list",
	description:
		"List deployments for an application or compose service (most recent first).",
	category: "deployment",
	aliases: [
		"deployments",
		"deployment history",
		"deployment status list",
		"部署列表",
		"部署历史",
		"查看部署",
	],
	tags: ["deploy", "deployment", "history", "list", "部署", "历史", "列表"],
	parameters: z.object({
		applicationId: z.string().optional().describe("Application ID"),
		composeId: z.string().optional().describe("Compose service ID"),
		limit: z
			.number()
			.min(1)
			.max(50)
			.optional()
			.default(10)
			.describe("Maximum number of deployments"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		if (!params.applicationId && !params.composeId) {
			return {
				success: false,
				message: "applicationId or composeId is required",
				error: "Missing target",
				data: [],
			};
		}
		if (params.applicationId && params.composeId) {
			return {
				success: false,
				message: "Provide only one of applicationId or composeId",
				error: "Ambiguous target",
				data: [],
			};
		}

		const rows = await db.query.deployments.findMany({
			where: params.applicationId
				? eq(deployments.applicationId, params.applicationId)
				: eq(deployments.composeId, params.composeId!),
			orderBy: desc(deployments.createdAt),
			limit: params.limit ?? 10,
			with: {
				application: {
					with: {
						environment: {
							with: {
								project: true,
							},
						},
					},
				},
				compose: {
					with: {
						environment: {
							with: {
								project: true,
							},
						},
					},
				},
			},
		});

		const filtered = rows.filter((d) => {
			const appOrg = d.application?.environment?.project?.organizationId;
			const composeOrg = d.compose?.environment?.project?.organizationId;
			return (appOrg ?? composeOrg) === ctx.organizationId;
		});

		return {
			success: true,
			message: `Found ${filtered.length} deployment(s)`,
			data: filtered.map((d) => ({
				deploymentId: d.deploymentId,
				title: d.title,
				status: d.status ?? "running",
				createdAt: d.createdAt,
				startedAt: d.startedAt ?? null,
				finishedAt: d.finishedAt ?? null,
				errorMessage: d.errorMessage ?? null,
			})),
		};
	},
};

const getDeploymentLog: Tool<
	{ deploymentId: string; direction?: "start" | "end"; maxBytes?: number },
	{ deploymentId: string; status: string; log: string }
> = {
	name: "deployment_log_get",
	description:
		"Read deployment log with byte limit (supports local and remote). Use direction=start to read from beginning, direction=end to read from end.",
	category: "deployment",
	aliases: [
		"deployment log",
		"deploy log",
		"build log",
		"deploy output",
		"部署日志",
		"构建日志",
		"查看日志",
	],
	tags: [
		"log",
		"logs",
		"deploy",
		"deployment",
		"output",
		"日志",
		"部署",
		"构建",
	],
	parameters: z.object({
		deploymentId: z.string().min(1).describe("Deployment ID"),
		direction: z
			.enum(["start", "end"])
			.optional()
			.default("end")
			.describe("Read from start or end of the log"),
		maxBytes: z
			.number()
			.int()
			.min(1)
			.max(500000)
			.optional()
			.default(200000)
			.describe("Maximum bytes to read"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const deployment = await db.query.deployments.findFirst({
			where: eq(deployments.deploymentId, params.deploymentId),
			with: {
				application: {
					with: {
						environment: {
							with: {
								project: true,
							},
						},
					},
				},
				compose: {
					with: {
						environment: {
							with: {
								project: true,
							},
						},
					},
				},
			},
		});

		if (!deployment) {
			return {
				success: false,
				message: "Deployment not found",
				error: "NOT_FOUND",
				data: { deploymentId: params.deploymentId, status: "unknown", log: "" },
			};
		}

		const appOrg = deployment.application?.environment?.project?.organizationId;
		const composeOrg = deployment.compose?.environment?.project?.organizationId;
		if ((appOrg ?? composeOrg) !== ctx.organizationId) {
			return {
				success: false,
				message: "Deployment access denied",
				error: "UNAUTHORIZED",
				data: { deploymentId: params.deploymentId, status: "unknown", log: "" },
			};
		}

		const logPath = deployment.logPath;
		if (!logPath) {
			return {
				success: false,
				message: "Deployment logPath is empty",
				error: "MISSING_LOG_PATH",
				data: {
					deploymentId: params.deploymentId,
					status: deployment.status ?? "unknown",
					log: "",
				},
			};
		}

		const remoteServerId =
			deployment.buildServerId ??
			deployment.serverId ??
			deployment.application?.buildServerId ??
			deployment.application?.serverId ??
			deployment.compose?.serverId ??
			null;

		try {
			let log = "";
			const bytes = params.maxBytes ?? 200000;
			if (remoteServerId) {
				const base = params.direction === "start" ? "head" : "tail";
				const cmd = `${base} -c ${bytes} ${quote([logPath])}`;
				const out = await execAsyncRemote(remoteServerId, cmd);
				log = (out.stdout || out.stderr || "").trim();
			} else {
				if (!existsSync(logPath)) {
					return {
						success: false,
						message: "Log file not found",
						error: "LOG_NOT_FOUND",
						data: {
							deploymentId: params.deploymentId,
							status: deployment.status ?? "unknown",
							log: "",
						},
					};
				}
				const content = await fsPromises.readFile(logPath, "utf8");
				if (content.length <= bytes) {
					log = content.trim();
				} else {
					log =
						params.direction === "start"
							? content.slice(0, bytes).trim()
							: content.slice(-bytes).trim();
					log = `${log}\n...[TRUNCATED]`;
				}
			}

			return {
				success: true,
				message: "Deployment log read",
				data: {
					deploymentId: params.deploymentId,
					status: deployment.status ?? "unknown",
					log,
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to read deployment log",
				error: msg,
				data: {
					deploymentId: params.deploymentId,
					status: deployment.status ?? "unknown",
					log: "",
				},
			};
		}
	},
};

const cancelDeploymentTool: Tool<
	{
		deploymentId?: string;
		applicationId?: string;
		composeId?: string;
		previewDeploymentId?: string;
		mode?: "queue" | "running" | "all";
	},
	{
		cancelledQueuedJobs: number;
		killedRunning: boolean;
		queueErrors?: string;
		killErrors?: string;
	}
> = {
	name: "deployment_cancel",
	description:
		"Cancel a deployment: remove queued BullMQ jobs (waiting/delayed) and/or kill running docker build/compose processes. Provide one of deploymentId/applicationId/composeId/previewDeploymentId.",
	category: "deployment",
	aliases: [
		"cancel deploy",
		"stop deploy",
		"abort deploy",
		"kill deployment",
		"取消部署",
		"停止部署",
		"终止部署",
	],
	tags: [
		"cancel",
		"stop",
		"deploy",
		"deployment",
		"queue",
		"取消",
		"停止",
		"部署",
		"队列",
	],
	parameters: z.object({
		deploymentId: z.string().optional().describe("Deployment ID"),
		applicationId: z.string().optional().describe("Application ID"),
		composeId: z.string().optional().describe("Compose ID"),
		previewDeploymentId: z
			.string()
			.optional()
			.describe("Preview Deployment ID"),
		mode: z
			.enum(["queue", "running", "all"])
			.optional()
			.default("all")
			.describe("Cancel queued jobs, kill running processes, or both"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		if (
			!params.deploymentId &&
			!params.applicationId &&
			!params.composeId &&
			!params.previewDeploymentId
		) {
			return {
				success: false,
				message:
					"Must provide deploymentId, applicationId, composeId, or previewDeploymentId",
				data: {
					cancelledQueuedJobs: 0,
					killedRunning: false,
				},
			};
		}

		let cancelledQueuedJobs = 0;
		let killedRunning = false;
		let queueErrors: string | undefined;
		let killErrors: string | undefined;

		let applicationId = params.applicationId;
		let composeId = params.composeId;
		let previewDeploymentId = params.previewDeploymentId;
		let serverId: string | null = null;
		let killTarget: "application" | "compose" | "preview" | null = null;
		let deploymentIdForStatusUpdate: string | null = null;

		if (params.deploymentId) {
			const deployment = await db.query.deployments.findFirst({
				where: eq(deployments.deploymentId, params.deploymentId),
				with: {
					application: {
						with: {
							environment: { with: { project: true } },
						},
					},
					compose: {
						with: {
							environment: { with: { project: true } },
						},
					},
					previewDeployment: {
						with: {
							application: {
								with: {
									environment: { with: { project: true } },
								},
							},
						},
					},
				},
			});

			if (!deployment) {
				return {
					success: false,
					message: "Deployment not found",
					data: {
						cancelledQueuedJobs: 0,
						killedRunning: false,
					},
				};
			}

			const appOrg =
				deployment.application?.environment?.project?.organizationId;
			const composeOrg =
				deployment.compose?.environment?.project?.organizationId;
			const previewOrg =
				deployment.previewDeployment?.application?.environment?.project
					?.organizationId;
			if ((appOrg ?? composeOrg ?? previewOrg) !== ctx.organizationId) {
				return {
					success: false,
					message: "Deployment access denied",
					data: {
						cancelledQueuedJobs: 0,
						killedRunning: false,
					},
				};
			}

			applicationId = deployment.applicationId ?? applicationId;
			composeId = deployment.composeId ?? composeId;
			previewDeploymentId =
				deployment.previewDeploymentId ?? previewDeploymentId;
			deploymentIdForStatusUpdate = deployment.deploymentId;

			serverId =
				deployment.buildServerId ??
				deployment.serverId ??
				deployment.application?.buildServerId ??
				deployment.application?.serverId ??
				deployment.compose?.serverId ??
				deployment.previewDeployment?.application?.serverId ??
				null;

			if (composeId) killTarget = "compose";
			else if (previewDeploymentId) killTarget = "preview";
			else if (applicationId) killTarget = "application";
		} else {
			if (applicationId) {
				const app = await db.query.applications.findFirst({
					where: eq(applications.applicationId, applicationId),
					with: {
						environment: { with: { project: true } },
					},
				});
				if (!app) {
					return {
						success: false,
						message: "Application not found",
						data: { cancelledQueuedJobs: 0, killedRunning: false },
					};
				}
				if (app.environment?.project?.organizationId !== ctx.organizationId) {
					return {
						success: false,
						message: "Application access denied",
						data: { cancelledQueuedJobs: 0, killedRunning: false },
					};
				}
				serverId = app.buildServerId ?? app.serverId ?? null;
				killTarget = "application";
			} else if (composeId) {
				const compose = await db.query.compose.findFirst({
					where: eq(composeTable.composeId, composeId),
					with: {
						environment: { with: { project: true } },
					},
				});
				if (!compose) {
					return {
						success: false,
						message: "Compose not found",
						data: { cancelledQueuedJobs: 0, killedRunning: false },
					};
				}
				if (
					compose.environment?.project?.organizationId !== ctx.organizationId
				) {
					return {
						success: false,
						message: "Compose access denied",
						data: { cancelledQueuedJobs: 0, killedRunning: false },
					};
				}
				serverId = compose.serverId ?? null;
				killTarget = "compose";
			} else if (previewDeploymentId) {
				const preview = await db.query.previewDeployments.findFirst({
					where: eq(
						previewDeployments.previewDeploymentId,
						previewDeploymentId,
					),
					with: {
						application: {
							with: {
								environment: { with: { project: true } },
							},
						},
					},
				});
				if (!preview) {
					return {
						success: false,
						message: "Preview deployment not found",
						data: { cancelledQueuedJobs: 0, killedRunning: false },
					};
				}
				if (
					preview.application?.environment?.project?.organizationId !==
					ctx.organizationId
				) {
					return {
						success: false,
						message: "Preview deployment access denied",
						data: { cancelledQueuedJobs: 0, killedRunning: false },
					};
				}
				applicationId = preview.applicationId;
				serverId = preview.application?.serverId ?? null;
				killTarget = "preview";
			}
		}

		if ((params.mode === "queue" || params.mode === "all") && !queueErrors) {
			const queue = getDeploymentsQueue();
			try {
				const jobs = await queue.getJobs(["waiting", "delayed"]);
				for (const job of jobs) {
					if (applicationId && job?.data?.applicationId === applicationId) {
						await job.remove();
						cancelledQueuedJobs += 1;
						continue;
					}
					if (composeId && job?.data?.composeId === composeId) {
						await job.remove();
						cancelledQueuedJobs += 1;
						continue;
					}
					if (
						previewDeploymentId &&
						job?.data?.previewDeploymentId === previewDeploymentId
					) {
						await job.remove();
						cancelledQueuedJobs += 1;
					}
				}
			} catch (error) {
				queueErrors = error instanceof Error ? error.message : String(error);
			} finally {
				await queue.close().catch(() => {});
			}
		}

		if (params.mode === "running" || params.mode === "all") {
			try {
				if (!killTarget) {
					if (composeId) killTarget = "compose";
					else if (previewDeploymentId) killTarget = "preview";
					else if (applicationId) killTarget = "application";
				}
				if (killTarget) {
					await killRunningDeployments(killTarget, serverId);
					killedRunning = true;
				}
			} catch (error) {
				killErrors = error instanceof Error ? error.message : String(error);
			}
		}

		if (!deploymentIdForStatusUpdate) {
			deploymentIdForStatusUpdate = await findLatestRunningDeploymentId({
				applicationId,
				composeId,
				previewDeploymentId,
			});
		}
		if (deploymentIdForStatusUpdate) {
			try {
				await updateDeploymentStatus(deploymentIdForStatusUpdate, "cancelled");
			} catch {
				// ignore
			}
		}

		return {
			success: true,
			message: "Deployment cancellation attempted",
			data: {
				cancelledQueuedJobs,
				killedRunning,
				...(queueErrors ? { queueErrors } : {}),
				...(killErrors ? { killErrors } : {}),
			},
		};
	},
};

const retryDeploymentTool: Tool<
	{ deploymentId: string; type?: "deploy" | "redeploy" },
	{ queued: boolean }
> = {
	name: "deployment_retry",
	description:
		"Retry a deployment by enqueuing a new deploy/redeploy job for the underlying application/compose/preview deployment.",
	category: "deployment",
	aliases: [
		"retry deploy",
		"redeploy",
		"rebuild",
		"deploy again",
		"重新部署",
		"重试部署",
		"再次部署",
	],
	tags: [
		"retry",
		"redeploy",
		"deploy",
		"deployment",
		"queue",
		"重试",
		"重新部署",
		"部署",
	],
	parameters: z.object({
		deploymentId: z.string().min(1).describe("Deployment ID to retry"),
		type: z
			.enum(["deploy", "redeploy"])
			.optional()
			.default("redeploy")
			.describe("Deploy type to enqueue"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const deployment = await db.query.deployments.findFirst({
			where: eq(deployments.deploymentId, params.deploymentId),
			with: {
				application: {
					with: {
						environment: { with: { project: true } },
					},
				},
				compose: {
					with: {
						environment: { with: { project: true } },
					},
				},
				previewDeployment: {
					with: {
						application: {
							with: {
								environment: { with: { project: true } },
							},
						},
					},
				},
			},
		});

		if (!deployment) {
			return {
				success: false,
				message: "Deployment not found",
				data: { queued: false },
			};
		}

		const appOrg = deployment.application?.environment?.project?.organizationId;
		const composeOrg = deployment.compose?.environment?.project?.organizationId;
		const previewOrg =
			deployment.previewDeployment?.application?.environment?.project
				?.organizationId;
		if ((appOrg ?? composeOrg ?? previewOrg) !== ctx.organizationId) {
			return {
				success: false,
				message: "Deployment access denied",
				data: { queued: false },
			};
		}

		const type = params.type ?? "redeploy";
		const queue = getDeploymentsQueue();
		try {
			if (deployment.applicationId) {
				await queue.add(
					"deployments",
					{
						applicationId: deployment.applicationId,
						titleLog: `Retry deployment (${type})`,
						descriptionLog: `Retry of deployment ${deployment.deploymentId}`,
						type,
						applicationType: "application",
						...(deployment.application?.serverId
							? { serverId: deployment.application.serverId, server: true }
							: {}),
					},
					{ removeOnComplete: true, removeOnFail: true },
				);
			} else if (deployment.composeId) {
				await queue.add(
					"deployments",
					{
						composeId: deployment.composeId,
						titleLog: `Retry deployment (${type})`,
						descriptionLog: `Retry of deployment ${deployment.deploymentId}`,
						type,
						applicationType: "compose",
						...(deployment.compose?.serverId
							? { serverId: deployment.compose.serverId, server: true }
							: {}),
					},
					{ removeOnComplete: true, removeOnFail: true },
				);
			} else if (deployment.previewDeploymentId) {
				const preview = deployment.previewDeployment;
				if (!preview) {
					return {
						success: false,
						message: "Preview deployment not found",
						data: { queued: false },
					};
				}
				await queue.add(
					"deployments",
					{
						applicationId: preview.applicationId,
						previewDeploymentId: deployment.previewDeploymentId,
						titleLog: "Retry preview deployment (deploy)",
						descriptionLog: `Retry of deployment ${deployment.deploymentId}`,
						type: "deploy",
						applicationType: "application-preview",
						...(preview.application?.serverId
							? { serverId: preview.application.serverId, server: true }
							: {}),
					},
					{ removeOnComplete: true, removeOnFail: true },
				);
			} else {
				return {
					success: false,
					message:
						"Deployment has no applicationId/composeId/previewDeploymentId",
					data: { queued: false },
				};
			}
		} finally {
			await queue.close().catch(() => {});
		}

		return {
			success: true,
			message: "Deployment retry queued",
			data: { queued: true },
		};
	},
};

const tailDeploymentLog: Tool<
	{ deploymentId: string; lines?: number },
	{ deploymentId: string; status: string; log: string }
> = {
	name: "deployment_log_tail",
	description:
		"Read the last N lines from a deployment log (supports local and remote servers).",
	category: "deployment",
	aliases: [
		"tail deploy log",
		"tail deployment log",
		"follow deploy log",
		"追踪部署日志",
		"尾部日志",
		"实时日志",
	],
	tags: ["tail", "log", "logs", "deploy", "deployment", "追踪", "日志", "部署"],
	parameters: z.object({
		deploymentId: z.string().min(1).describe("Deployment ID"),
		lines: z
			.number()
			.min(1)
			.max(2000)
			.optional()
			.default(200)
			.describe("Number of lines to read from the end"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const deployment = await db.query.deployments.findFirst({
			where: eq(deployments.deploymentId, params.deploymentId),
			with: {
				application: {
					with: {
						environment: {
							with: {
								project: true,
							},
						},
					},
				},
				compose: {
					with: {
						environment: {
							with: {
								project: true,
							},
						},
					},
				},
			},
		});

		if (!deployment) {
			return {
				success: false,
				message: "Deployment not found",
				error: "NOT_FOUND",
				data: { deploymentId: params.deploymentId, status: "unknown", log: "" },
			};
		}

		const appOrg = deployment.application?.environment?.project?.organizationId;
		const composeOrg = deployment.compose?.environment?.project?.organizationId;
		if ((appOrg ?? composeOrg) !== ctx.organizationId) {
			return {
				success: false,
				message: "Deployment access denied",
				error: "UNAUTHORIZED",
				data: { deploymentId: params.deploymentId, status: "unknown", log: "" },
			};
		}

		const logPath = deployment.logPath;
		if (!logPath) {
			return {
				success: false,
				message: "Deployment logPath is empty",
				error: "MISSING_LOG_PATH",
				data: {
					deploymentId: params.deploymentId,
					status: deployment.status ?? "unknown",
					log: "",
				},
			};
		}

		const remoteServerId =
			deployment.buildServerId ??
			deployment.serverId ??
			deployment.application?.buildServerId ??
			deployment.application?.serverId ??
			deployment.compose?.serverId ??
			null;

		try {
			let log = "";
			if (remoteServerId) {
				const cmd = `tail -n ${params.lines ?? 200} ${quote([logPath])}`;
				const out = await execAsyncRemote(remoteServerId, cmd);
				log = (out.stdout || out.stderr || "").trim();
			} else {
				if (!existsSync(logPath)) {
					return {
						success: false,
						message: "Log file not found",
						error: "LOG_NOT_FOUND",
						data: {
							deploymentId: params.deploymentId,
							status: deployment.status ?? "unknown",
							log: "",
						},
					};
				}
				const content = await fsPromises.readFile(logPath, "utf8");
				const lines = content.split(/\r?\n/g);
				log = lines
					.slice(-(params.lines ?? 200))
					.join("\n")
					.trim();
			}

			return {
				success: true,
				message: `Read last ${params.lines ?? 200} line(s) from deployment log`,
				data: {
					deploymentId: params.deploymentId,
					status: deployment.status ?? "unknown",
					log,
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to read deployment log",
				error: msg,
				data: {
					deploymentId: params.deploymentId,
					status: deployment.status ?? "unknown",
					log: "",
				},
			};
		}
	},
};

export function registerDeploymentTools() {
	toolRegistry.register(listDeployments);
	toolRegistry.register(tailDeploymentLog);
	toolRegistry.register(getDeploymentLog);
	toolRegistry.register(cancelDeploymentTool);
	toolRegistry.register(retryDeploymentTool);
}

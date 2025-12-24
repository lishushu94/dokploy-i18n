import {
	execAsync,
	execAsyncRemote,
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findApplicationById,
	findComposeById,
	findDeploymentById,
	findServerById,
	IS_CLOUD,
	updateDeploymentStatus,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import {
	apiFindAllByApplication,
	apiFindAllByCompose,
	apiFindAllByServer,
	apiFindAllByType,
	deployments,
} from "@/server/db/schema";
import { myQueue } from "@/server/queues/queueSetup";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const deploymentRouter = createTRPCRouter({
	all: protectedProcedure
		.input(apiFindAllByApplication)
		.query(async ({ input, ctx }) => {
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}
			return await findAllDeploymentsByApplicationId(input.applicationId);
		}),

	allByCompose: protectedProcedure
		.input(apiFindAllByCompose)
		.query(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);
			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this compose",
				});
			}
			return await findAllDeploymentsByComposeId(input.composeId);
		}),
	allByServer: protectedProcedure
		.input(apiFindAllByServer)
		.query(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this server",
				});
			}
			return await findAllDeploymentsByServerId(input.serverId);
		}),

	allByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input }) => {
			const deploymentsList = await db.query.deployments.findMany({
				where: eq(deployments[`${input.type}Id`], input.id),
				orderBy: desc(deployments.createdAt),
				with: {
					rollback: true,
				},
			});

			return deploymentsList;
		}),

	queueByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input, ctx }) => {
			if (IS_CLOUD) return [];
			try {
				if (input.type !== "application" && input.type !== "compose") {
					return [];
				}

				if (input.type === "application") {
					const application = await findApplicationById(input.id);
					if (
						application.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this application",
						});
					}
				}

				if (input.type === "compose") {
					const compose = await findComposeById(input.id);
					if (
						compose.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this compose",
						});
					}
				}

				const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
					myQueue.getJobs(["active"]),
					myQueue.getJobs(["waiting"]),
					myQueue.getJobs(["delayed"]),
				]);

				const jobs = [
					...activeJobs.map((job) => ({ job, state: "active" as const })),
					...waitingJobs.map((job) => ({ job, state: "waiting" as const })),
					...delayedJobs.map((job) => ({ job, state: "delayed" as const })),
				];

				return jobs
					.filter((job) => {
						if (input.type === "application") {
							return (
								job.job.data?.applicationType === "application" &&
								job.job.data?.applicationId === input.id
							);
						}
						return (
							job.job.data?.applicationType === "compose" &&
							job.job.data?.composeId === input.id
						);
					})
					.map(({ job, state }) => ({
						jobId: String(job.id ?? ""),
						state,
						name: job.name,
						createdAt: new Date(job.timestamp).toISOString(),
						data: job.data,
					}));
			} catch (error) {
				if (error instanceof TRPCError) {
					throw error;
				}
				return [];
			}
		}),

	killProcess: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input }) => {
			const deployment = await findDeploymentById(input.deploymentId);

			if (!deployment.pid) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment is not running",
				});
			}

			const command = `kill -9 ${deployment.pid}`;
			if (deployment.schedule?.serverId) {
				await execAsyncRemote(deployment.schedule.serverId, command);
			} else {
				await execAsync(command);
			}

			await updateDeploymentStatus(deployment.deploymentId, "error");
		}),
});

import { IS_CLOUD } from "@dokploy/server/constants";
import {
	aiProviderTypeSchema,
	apiApproveExecution,
	apiCancelRun,
	apiCreateAi,
	apiCreateConversation,
	apiFindConversation,
	apiGetMessages,
	apiGetRun,
	apiListConversations,
	apiSendMessage,
	apiStartAgent,
	apiUpdateAi,
	apiUpdateConversation,
	deploySuggestionSchema,
} from "@dokploy/server/db/schema/ai";
import {
	createDomain,
	createMount,
	findEnvironmentById,
} from "@dokploy/server/index";
import {
	approveToolExecution,
	cancelRun,
	chat,
	createConversation,
	createRun,
	deleteAiSettings,
	deleteConversation,
	executeApprovedTool,
	getAiSettingById,
	getAiSettingsByOrganizationId,
	getConversationById,
	getMessages,
	getRunById,
	getToolExecutionById,
	listConversations,
	saveAiSettings,
	suggestVariants,
	updateConversation,
} from "@dokploy/server/services/ai";
import { createComposeByTemplate } from "@dokploy/server/services/compose";
import { findProjectById } from "@dokploy/server/services/project";
import {
	addNewService,
	checkServiceAccess,
} from "@dokploy/server/services/user";
import {
	getProviderHeaders,
	getProviderName,
	type Model,
	normalizeAiApiUrl,
} from "@dokploy/server/utils/ai/select-ai-provider";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { slugify } from "@/lib/slug";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import { generatePassword } from "@/templates/utils";

export const aiRouter = createTRPCRouter({
	one: protectedProcedure
		.input(z.object({ aiId: z.string() }))
		.query(async ({ ctx, input }) => {
			const normalizedAiId = input.aiId.trim();
			if (normalizedAiId.length === 0) return null;
			const aiSetting = await getAiSettingById(normalizedAiId);
			if (aiSetting.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this AI configuration",
				});
			}
			return aiSetting;
		}),

	getModels: protectedProcedure
		.input(
			z.object({
				apiUrl: z.string().min(1),
				apiKey: z.string(),
				providerType: aiProviderTypeSchema.optional(),
			}),
		)
		.query(async ({ input }) => {
			try {
				const detectedProvider = getProviderName(input.apiUrl);
				const explicitProvider =
					input.providerType === "custom"
						? "openai_compatible"
						: input.providerType;
				const providerName = explicitProvider
					? explicitProvider
					: detectedProvider === "custom"
						? "openai_compatible"
						: detectedProvider;
				const apiUrl = normalizeAiApiUrl({
					apiUrl: input.apiUrl,
					providerType: providerName,
				});
				const headers = getProviderHeaders(apiUrl, input.apiKey, providerName);
				let response = null;
				switch (providerName) {
					case "ollama":
						response = await fetch(`${apiUrl}/api/tags`, { headers });
						break;
					case "gemini":
						response = await fetch(
							`${apiUrl}/models?key=${encodeURIComponent(input.apiKey)}`,
							{ headers: {} },
						);
						break;
					default:
						if (!input.apiKey)
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: "API key must contain at least 1 character(s)",
							});
						response = await fetch(`${apiUrl}/models`, { headers });
				}

				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					const details = [
						`status=${response.status}`,
						`provider=${providerName}`,
						`url=${response.url || apiUrl}`,
					]
						.filter(Boolean)
						.join(" ");
					throw new Error(
						`Failed to fetch models (${details})${errorText ? `: ${errorText}` : ""}`,
					);
				}

				const res = await response.json();

				if (Array.isArray(res)) {
					return res.map((model) => ({
						id: model.id || model.name,
						object: "model",
						created: Date.now(),
						owned_by: "provider",
					}));
				}

				if (res.models) {
					return res.models.map((model: any) => ({
						id: model.id || model.name,
						object: "model",
						created: Date.now(),
						owned_by: "provider",
					})) as Model[];
				}

				if (res.data) {
					return res.data as Model[];
				}

				const possibleModels =
					(Object.values(res).find(Array.isArray) as any[]) || [];
				return possibleModels.map((model) => ({
					id: model.id || model.name,
					object: "model",
					created: Date.now(),
					owned_by: "provider",
				})) as Model[];
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error?.message : `Error: ${error}`,
				});
			}
		}),
	create: adminProcedure.input(apiCreateAi).mutation(async ({ ctx, input }) => {
		return await saveAiSettings(ctx.session.activeOrganizationId, input);
	}),

	update: protectedProcedure
		.input(apiUpdateAi)
		.mutation(async ({ ctx, input }) => {
			return await saveAiSettings(ctx.session.activeOrganizationId, input);
		}),

	getAll: adminProcedure.query(async ({ ctx }) => {
		return await getAiSettingsByOrganizationId(
			ctx.session.activeOrganizationId,
		);
	}),

	get: protectedProcedure
		.input(z.object({ aiId: z.string() }))
		.query(async ({ ctx, input }) => {
			const aiSetting = await getAiSettingById(input.aiId);
			if (aiSetting.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this AI configuration",
				});
			}
			return aiSetting;
		}),

	delete: protectedProcedure
		.input(z.object({ aiId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const aiSetting = await getAiSettingById(input.aiId);
			if (aiSetting.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this AI configuration",
				});
			}
			return await deleteAiSettings(input.aiId);
		}),

	suggest: protectedProcedure
		.input(
			z.object({
				aiId: z.string(),
				input: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				return await suggestVariants({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error?.message : `Error: ${error}`,
				});
			}
		}),
	deploy: protectedProcedure
		.input(deploySuggestionSchema)
		.mutation(async ({ ctx, input }) => {
			const environment = await findEnvironmentById(input.environmentId);
			const project = await findProjectById(environment.projectId);
			if (ctx.user.role === "member") {
				await checkServiceAccess(
					ctx.session.activeOrganizationId,
					environment.projectId,
					"create",
				);
			}

			if (IS_CLOUD && !input.serverId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You need to use a server to create a compose",
				});
			}

			const projectName = slugify(`${project.name} ${input.id}`);

			const compose = await createComposeByTemplate({
				...input,
				composeFile: input.dockerCompose,
				env: input.envVariables,
				serverId: input.serverId,
				name: input.name,
				sourceType: "raw",
				appName: `${projectName}-${generatePassword(6)}`,
				isolatedDeployment: true,
				environmentId: input.environmentId,
			});

			if (input.domains && input.domains?.length > 0) {
				for (const domain of input.domains) {
					await createDomain({
						...domain,
						domainType: "compose",
						certificateType: "none",
						composeId: compose.composeId,
					});
				}
			}
			if (input.configFiles && input.configFiles?.length > 0) {
				for (const mount of input.configFiles) {
					await createMount({
						filePath: mount.filePath,
						mountPath: "",
						content: mount.content,
						serviceId: compose.composeId,
						serviceType: "compose",
						type: "file",
					});
				}
			}

			if (ctx.user.role === "member") {
				await addNewService(
					ctx.session.activeOrganizationId,
					ctx.user.ownerId,
					compose.composeId,
				);
			}

			return null;
		}),

	// ============================================
	// Conversation Management
	// ============================================

	conversations: createTRPCRouter({
		create: protectedProcedure
			.input(apiCreateConversation)
			.mutation(async ({ ctx, input }) => {
				const normalizedAiId =
					typeof input.aiId === "string" && input.aiId.trim().length > 0
						? input.aiId
						: undefined;
				const normalizedInput = {
					...input,
					aiId: normalizedAiId,
					title: input.title ?? undefined,
					projectId: input.projectId ?? undefined,
					serverId: input.serverId ?? undefined,
				};
				return await createConversation({
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					...normalizedInput,
				});
			}),

		get: protectedProcedure
			.input(apiFindConversation)
			.query(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this conversation",
					});
				}
				return conversation;
			}),

		list: protectedProcedure
			.input(apiListConversations)
			.query(async ({ ctx, input }) => {
				return await listConversations({
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					...input,
				});
			}),

		update: protectedProcedure
			.input(apiUpdateConversation)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this conversation",
					});
				}
				return await updateConversation(input.conversationId, {
					title: input.title,
					status: input.status,
				});
			}),

		delete: protectedProcedure
			.input(apiFindConversation)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this conversation",
					});
				}
				await deleteConversation(input.conversationId);
				return { success: true };
			}),
	}),

	// ============================================
	// Chat Operations
	// ============================================

	chat: createTRPCRouter({
		send: protectedProcedure
			.input(apiSendMessage)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this conversation",
					});
				}

				return await chat({
					conversationId: input.conversationId,
					message: input.message,
					aiId: input.aiId,
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
				});
			}),

		messages: protectedProcedure
			.input(apiGetMessages)
			.query(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this conversation",
					});
				}
				return await getMessages(input);
			}),
	}),

	// ============================================
	// Agent Operations
	// ============================================

	agent: createTRPCRouter({
		start: protectedProcedure
			.input(apiStartAgent)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this conversation",
					});
				}
				return await createRun({
					conversationId: input.conversationId,
					goal: input.goal,
				});
			}),

		getRun: protectedProcedure.input(apiGetRun).query(async ({ input }) => {
			return await getRunById(input.runId);
		}),

		cancel: protectedProcedure
			.input(apiCancelRun)
			.mutation(async ({ input }) => {
				return await cancelRun(input.runId);
			}),

		approve: protectedProcedure
			.input(apiApproveExecution)
			.mutation(async ({ ctx, input }) => {
				return await approveToolExecution(
					input.executionId,
					input.approved,
					ctx.user.id,
				);
			}),

		execute: protectedProcedure
			.input(
				z.object({
					executionId: z.string(),
					conversationId: z.string().optional(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const execution = await getToolExecutionById(input.executionId);
				if (execution.status !== "approved") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Tool execution must be approved first",
					});
				}

				let projectId: string | undefined;
				let serverId: string | undefined;
				if (input.conversationId) {
					const conversation = await getConversationById(input.conversationId);
					if (
						conversation.organizationId !== ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this conversation",
						});
					}
					projectId = conversation.projectId || undefined;
					serverId = conversation.serverId || undefined;
				}

				return await executeApprovedTool(input.executionId, {
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					projectId,
					serverId,
				});
			}),

		getExecution: protectedProcedure
			.input(z.object({ executionId: z.string() }))
			.query(async ({ input }) => {
				return await getToolExecutionById(input.executionId);
			}),
	}),
});

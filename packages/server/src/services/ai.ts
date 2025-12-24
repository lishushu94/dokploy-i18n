import { db } from "@dokploy/server/db";
import {
	ai,
	aiConversations,
	aiMessages,
	aiRuns,
	aiToolExecutions,
} from "@dokploy/server/db/schema";
import { selectAIProvider } from "@dokploy/server/utils/ai/select-ai-provider";
import { TRPCError } from "@trpc/server";
import {
	type CoreMessage,
	generateObject,
	generateText,
	stepCountIs,
	streamText,
	tool,
} from "ai";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { IS_CLOUD } from "../constants";
import { findOrganizationById } from "./admin";
import { initializeTools, type ToolContext, toolRegistry } from "./ai-tools";
import { findServerById } from "./server";

type ToolPromptInfo = {
	name: string;
	description: string;
	riskLevel: string;
	requiresApproval: boolean;
};

function getZodTypeLabel(schema: z.ZodTypeAny): string {
	const typeName = (schema as unknown as { _def?: { typeName?: string } })._def
		?.typeName;
	if (typeof typeName !== "string") return "unknown";
	return typeName
		.replace(/^Zod/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase();
}

function unwrapZodSchema(schema: z.ZodTypeAny): {
	schema: z.ZodTypeAny;
	flags: { optional: boolean; nullable: boolean; hasDefault: boolean };
} {
	let current: z.ZodTypeAny = schema;
	const flags = { optional: false, nullable: false, hasDefault: false };

	while (true) {
		if (current instanceof z.ZodOptional) {
			flags.optional = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodNullable) {
			flags.nullable = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodDefault) {
			flags.hasDefault = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodEffects) {
			current = current._def.schema;
			continue;
		}
		break;
	}

	return { schema: current, flags };
}

function describeZodParameters(schema: z.ZodTypeAny): string {
	const unwrapped = unwrapZodSchema(schema).schema;
	if (!(unwrapped instanceof z.ZodObject)) {
		return `Schema: ${getZodTypeLabel(unwrapped)}`;
	}

	const rawShape =
		typeof (unwrapped._def as unknown as { shape?: unknown }).shape ===
		"function"
			? (
					unwrapped._def as unknown as {
						shape: () => Record<string, z.ZodTypeAny>;
					}
				).shape()
			: (unwrapped as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;

	const keys = Object.keys(rawShape || {});
	if (keys.length === 0) return "(no parameters)";

	const lines = keys.map((key) => {
		const field = rawShape[key] as z.ZodTypeAny;
		const { schema: fieldSchema, flags } = unwrapZodSchema(field);
		const required = !flags.optional && !flags.hasDefault;
		const desc = (fieldSchema as unknown as { _def?: { description?: string } })
			._def?.description;
		const typeLabel = getZodTypeLabel(fieldSchema);
		const extras = [
			required ? "required" : "optional",
			flags.nullable ? "nullable" : "",
			flags.hasDefault ? "default" : "",
		]
			.filter(Boolean)
			.join(", ");
		return `- ${key}: ${typeLabel} (${extras})${desc ? ` - ${desc}` : ""}`;
	});

	return lines.join("\n");
}

function buildMetaToolPromptInfo(): ToolPromptInfo[] {
	return [
		{
			name: "tool_search",
			description:
				"Search the full tool catalog by natural language and return matching tool names.",
			riskLevel: "low",
			requiresApproval: false,
		},
		{
			name: "tool_describe",
			description:
				"Get details and parameter hints for a specific tool (name, description, approval/risk, parameters).",
			riskLevel: "low",
			requiresApproval: false,
		},
		{
			name: "tool_call",
			description:
				"Execute a specific tool by name with parameters. The target tool may require approval; tool_call itself does not.",
			riskLevel: "low",
			requiresApproval: false,
		},
	];
}

function tokenizeToolSearchQuery(query: string): string[] {
	const q = query.trim().toLowerCase();
	const tokens: string[] = q.split(/\s+/g).filter(Boolean);

	const add = (arr: string[]) => {
		for (const t of arr) tokens.push(t);
	};

	// Lightweight CN->EN keyword hints so tool_search works well in Chinese conversations.
	if (/(数据库|database|\bdb\b)/i.test(q)) add(["database", "db"]);
	if (/(postgres|postgresql|\bpg\b|pgsql|postgre)/i.test(q))
		add(["postgres", "pg"]);
	if (/(mysql)/i.test(q)) add(["mysql"]);
	if (/(mariadb)/i.test(q)) add(["mariadb"]);
	if (/(mongo|mongodb)/i.test(q)) add(["mongo", "mongodb"]);
	if (/(redis)/i.test(q)) add(["redis"]);

	if (/(项目|project)/i.test(q)) add(["project"]);
	if (/(环境|environment|\benv\b)/i.test(q)) add(["environment", "env"]);
	if (/(服务器|主机|server|host)/i.test(q)) add(["server"]);
	if (/(应用|application|\bapp\b)/i.test(q)) add(["application", "app"]);
	if (/(域名|domain|dns)/i.test(q)) add(["domain", "dns"]);
	if (/(证书|certificate|ssl|https|tls)/i.test(q))
		add(["certificate", "ssl", "https", "tls"]);
	if (/(traefik|特雷菲克|反向代理|网关|代理|转发|路由|ingress)/i.test(q))
		add(["traefik", "proxy", "router", "ingress"]);
	if (/(acme|let'?s\s*encrypt|续签|自动续期|证书续期|challenge)/i.test(q))
		add(["acme", "letsencrypt", "challenge"]);
	if (/(挂载|mount|bind\s*mount|绑定挂载|卷|volume)/i.test(q))
		add(["mount", "bind", "volume"]);
	if (/(对象存储|s3|r2|minio|bucket|存储桶|destination|备份目的地)/i.test(q))
		add(["destination", "s3", "bucket", "backup"]);
	if (/(卷备份|volume\s*backup)/i.test(q))
		add(["volume_backup", "volume", "backup"]);
	if (/(执行命令|命令行|终端|terminal|shell|exec)/i.test(q))
		add(["exec", "command", "server_exec"]);
	if (/(镜像仓库|registry|镜像|image|docker\s*hub|ghcr)/i.test(q))
		add(["registry", "image", "docker", "ghcr"]);
	if (/(ssh|ssh\s*key|密钥|密钥对|私钥|公钥)/i.test(q)) add(["ssh", "key"]);
	if (/(集群|cluster|swarm|节点|node)/i.test(q))
		add(["cluster", "swarm", "node"]);
	if (/(回滚|rollback|revert|恢复到上一版)/i.test(q))
		add(["rollback", "revert"]);
	if (/(github|GitHub|git hub)/i.test(q)) add(["github", "git"]);
	if (/(仓库|repo|repository)/i.test(q)) add(["repo", "repository"]);
	if (/(分支|branch)/i.test(q)) add(["branch"]);
	if (/(拉取请求|合并请求|pull request|\bpr\b)/i.test(q))
		add(["pull", "request", "pr"]);
	if (/(提交|commit)/i.test(q)) add(["commit"]);
	if (/(备份|backup)/i.test(q)) add(["backup"]);
	if (/(恢复|restore)/i.test(q)) add(["restore"]);
	if (/(日志|log)/i.test(q)) add(["log", "logs"]);
	if (/(重启|restart)/i.test(q)) add(["restart"]);
	if (/(部署|deploy|发布)/i.test(q)) add(["deploy"]);
	if (/(创建|新建|新增|create|add|new)/i.test(q)) add(["create", "new", "add"]);
	if (/(删除|移除|销毁|delete|remove|destroy)/i.test(q))
		add(["delete", "remove", "destroy"]);
	if (/(列表|list|查看|show|all)/i.test(q)) add(["list", "get", "show"]);
	if (/(详情|detail|info|inspect)/i.test(q)) add(["get", "info", "inspect"]);

	return Array.from(new Set(tokens));
}

function searchToolCatalog(params: { query: string; limit?: number }): {
	success: boolean;
	message: string;
	data: Array<{
		name: string;
		description: string;
		category: string;
		riskLevel: string;
		requiresApproval: boolean;
	}>;
} {
	const all = toolRegistry.getAll();
	const tokens = tokenizeToolSearchQuery(params.query);

	const scored = all
		.map((t) => {
			const hay = `${t.name} ${t.description} ${t.category}`.toLowerCase();
			let score = 0;
			for (const tok of tokens) {
				if (t.name.toLowerCase().includes(tok)) score += 6;
				if (hay.includes(tok)) score += 3;
			}
			if (t.riskLevel === "low") score += 1;
			return { t, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));

	const limit = params.limit ?? 12;
	const picked =
		scored.length > 0
			? scored.slice(0, limit).map((x) => x.t)
			: all
					.filter((t) => t.riskLevel === "low" && !t.requiresApproval)
					.sort((a, b) => a.name.localeCompare(b.name))
					.slice(0, limit);

	const message =
		scored.length > 0
			? `Found ${picked.length} tool(s) matching "${params.query}"`
			: `No direct matches for "${params.query}". Returning ${picked.length} safe tool(s) to help you explore.`;

	return {
		success: true,
		message,
		data: picked.map((t) => ({
			name: t.name,
			description: t.description,
			category: t.category,
			riskLevel: t.riskLevel,
			requiresApproval: t.requiresApproval,
		})),
	};
}

export const getAiSettingsByOrganizationId = async (organizationId: string) => {
	const aiSettings = await db.query.ai.findMany({
		where: eq(ai.organizationId, organizationId),
		orderBy: desc(ai.createdAt),
	});
	return aiSettings;
};

export const getAiSettingById = async (aiId: string) => {
	const aiSetting = await db.query.ai.findFirst({
		where: eq(ai.aiId, aiId),
	});
	if (!aiSetting) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AI settings not found",
		});
	}
	return aiSetting;
};

export const saveAiSettings = async (organizationId: string, settings: any) => {
	const aiId = settings.aiId;
	const existing = aiId
		? await db.query.ai.findFirst({ where: eq(ai.aiId, aiId) })
		: null;
	const providerType =
		(settings?.providerType as string | undefined | null) ??
		(existing?.providerType as string | undefined) ??
		"openai_compatible";
	const apiUrl = String(settings?.apiUrl ?? "")
		.trim()
		.replace(/\/+$/, "");
	const normalizedSettings = {
		...settings,
		providerType,
		apiUrl,
	};

	return db
		.insert(ai)
		.values({
			aiId,
			organizationId,
			...normalizedSettings,
		})
		.onConflictDoUpdate({
			target: ai.aiId,
			set: {
				...normalizedSettings,
			},
		});
};

export const deleteAiSettings = async (aiId: string) => {
	return db.delete(ai).where(eq(ai.aiId, aiId));
};

interface Props {
	organizationId: string;
	aiId: string;
	input: string;
	serverId?: string | undefined;
}

export const suggestVariants = async ({
	organizationId,
	aiId,
	input,
	serverId,
}: Props) => {
	try {
		const aiSettings = await getAiSettingById(aiId);
		if (!aiSettings || !aiSettings.isEnabled) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "AI features are not enabled for this configuration",
			});
		}

		const provider = selectAIProvider(aiSettings);
		const model = provider(aiSettings.model);

		let ip = "";
		if (!IS_CLOUD) {
			const organization = await findOrganizationById(organizationId);
			ip = organization?.owner.serverIp || "";
		}

		if (serverId) {
			const server = await findServerById(serverId);
			ip = server.ipAddress;
		} else if (process.env.NODE_ENV === "development") {
			ip = "127.0.0.1";
		}

		const { object } = await generateObject({
			model,
			output: "object",
			schema: z.object({
				suggestions: z.array(
					z.object({
						id: z.string(),
						name: z.string(),
						shortDescription: z.string(),
						description: z.string(),
					}),
				),
			}),
			prompt: `
        Act as advanced DevOps engineer and generate a list of open source projects what can cover users needs(up to 3 items).
        
        Return your response as a JSON object with the following structure:
        {
          "suggestions": [
            {
              "id": "project-slug",
              "name": "Project Name",
              "shortDescription": "Brief one-line description",
              "description": "Detailed description"
            }
          ]
        }
        
        Important rules for the response:
        1. Use slug format for the id field (lowercase, hyphenated)
        2. The description field should ONLY contain a plain text description of the project, its features, and use cases
        3. Do NOT include any code snippets, configuration examples, or installation instructions in the description
        4. The shortDescription should be a single-line summary focusing on the main technologies
        5. All projects should be installable in docker and have docker compose support
        
        User wants to create a new project with the following details:
        
        ${input}
      `,
		});

		if (object?.suggestions?.length) {
			const result = [];
			for (const suggestion of object.suggestions) {
				try {
					const { object: docker } = await generateObject({
						model,
						output: "object",
						schema: z.object({
							dockerCompose: z.string(),
							envVariables: z.array(
								z.object({
									name: z.string(),
									value: z.string(),
								}),
							),
							domains: z.array(
								z.object({
									host: z.string(),
									port: z.number(),
									serviceName: z.string(),
								}),
							),
							configFiles: z
								.array(
									z.object({
										content: z.string(),
										filePath: z.string(),
									}),
								)
								.optional(),
						}),
						prompt: `
              Act as advanced DevOps engineer and generate docker compose with environment variables and domain configurations needed to install the following project.
              
              Return your response as a JSON object with this structure:
              {
                "dockerCompose": "yaml string here",
                "envVariables": [{"name": "VAR_NAME", "value": "example_value"}],
                "domains": [{"host": "domain.com", "port": 3000, "serviceName": "service"}],
                "configFiles": [{"content": "file content", "filePath": "path/to/file"}]
              }
              
              Note: configFiles is optional - only include it if configuration files are absolutely required.
              
              Follow these rules:

              Docker Compose Rules:
              1. Use placeholder like \${VARIABLE_NAME-default} for generated variables in the docker-compose.yml
              2. Use complex values for passwords/secrets variables
              3. Don't set container_name field in services
              4. Don't set version field in the docker compose
              5. Don't set ports like 'ports: 3000:3000', use 'ports: "3000"' instead
              6. If a service depends on a database or other service, INCLUDE that service in the docker-compose
              7. Make sure all required services are defined in the docker-compose

			  Volume Mounting and Configuration Rules:
              1. DO NOT create configuration files unless the service CANNOT work without them
              2. Most services can work with just environment variables - USE THEM FIRST
              3. Ask yourself: "Can this be configured with an environment variable instead?"
              4. If and ONLY IF a config file is absolutely required:
                 - Keep it minimal with only critical settings
                 - Use "../files/" prefix for all mounts
                 - Format: "../files/folder:/container/path"
              5. DO NOT add configuration files for:
                 - Default configurations that work out of the box
                 - Settings that can be handled by environment variables
                 - Proxy or routing configurations (these are handled elsewhere)

			  Environment Variables Rules:
              1. For the envVariables array, provide ACTUAL example values, not placeholders
              2. Use realistic example values (e.g., "admin@example.com" for emails, "mypassword123" for passwords)
			  3. DO NOT use \${VARIABLE_NAME-default} syntax in the envVariables values
              4. ONLY include environment variables that are actually used in the docker-compose
              5. Every environment variable referenced in the docker-compose MUST have a corresponding entry in envVariables
              6. Do not include environment variables for services that don't exist in the docker-compose
                     
              For each service that needs to be exposed to the internet:
              1. Define a domain configuration with:
                - host: the domain name for the service in format: {service-name}-{random-3-chars-hex}-${ip ? ip.replaceAll(".", "-") : ""}.traefik.me
                - port: the internal port the service runs on
                - serviceName: the name of the service in the docker-compose
              2. Make sure the service is properly configured to work with the specified port
              
              Project details:
              ${suggestion?.description}
            `,
					});
					if (!!docker && !!docker.dockerCompose) {
						result.push({
							...suggestion,
							...docker,
						});
					}
				} catch (error) {
					console.error("Error in docker compose generation:", error);
				}
			}

			return result;
		}

		throw new TRPCError({
			code: "NOT_FOUND",
			message: "No suggestions found",
		});
	} catch (error) {
		console.error("Error in suggestVariants:", error);
		throw error;
	}
};

// ============================================
// Conversation Management
// ============================================

export const createConversation = async (params: {
	organizationId: string;
	userId: string;
	aiId?: string;
	title?: string;
	projectId?: string;
	serverId?: string;
}) => {
	const normalizedAiId =
		typeof params.aiId === "string" && params.aiId.trim().length > 0
			? params.aiId
			: undefined;

	if (normalizedAiId) {
		const existingAi = await db.query.ai.findFirst({
			where: and(
				eq(ai.aiId, normalizedAiId),
				eq(ai.organizationId, params.organizationId),
			),
		});
		if (!existingAi) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "AI settings not found",
			});
		}
	}

	const [conversation] = await db
		.insert(aiConversations)
		.values({
			organizationId: params.organizationId,
			userId: params.userId,
			aiId: normalizedAiId,
			title: params.title || "New Conversation",
			projectId: params.projectId,
			serverId: params.serverId,
		})
		.returning();
	return conversation;
};

export const getConversationById = async (conversationId: string) => {
	const conversation = await db.query.aiConversations.findFirst({
		where: eq(aiConversations.conversationId, conversationId),
		with: {
			messages: {
				orderBy: desc(aiMessages.createdAt),
				limit: 50,
			},
		},
	});
	if (!conversation) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Conversation not found",
		});
	}
	return conversation;
};

export const listConversations = async (params: {
	organizationId: string;
	userId: string;
	projectId?: string;
	serverId?: string;
	status?: "active" | "archived";
	limit?: number;
	offset?: number;
}) => {
	const conditions = [
		eq(aiConversations.organizationId, params.organizationId),
		eq(aiConversations.userId, params.userId),
	];

	if (params.projectId) {
		conditions.push(eq(aiConversations.projectId, params.projectId));
	}
	if (params.serverId) {
		conditions.push(eq(aiConversations.serverId, params.serverId));
	}
	if (params.status) {
		conditions.push(eq(aiConversations.status, params.status));
	}

	const conversations = await db.query.aiConversations.findMany({
		where: and(...conditions),
		orderBy: desc(aiConversations.updatedAt),
		limit: params.limit || 20,
		offset: params.offset || 0,
	});
	return conversations;
};

export const updateConversation = async (
	conversationId: string,
	data: {
		title?: string;
		status?: "active" | "archived";
		metadata?: Record<string, unknown>;
	},
) => {
	const updates: Partial<typeof aiConversations.$inferInsert> & {
		updatedAt: string;
	} = {
		updatedAt: new Date().toISOString(),
	};
	if (data.title !== undefined) updates.title = data.title;
	if (data.status !== undefined) updates.status = data.status;
	if (data.metadata !== undefined) updates.metadata = data.metadata;

	const [updated] = await db
		.update(aiConversations)
		.set(updates)
		.where(eq(aiConversations.conversationId, conversationId))
		.returning();
	return updated;
};

const scheduleConversationSummaryUpdate = (params: {
	conversationId: string;
	model: unknown;
	maxMessages?: number;
}) => {
	void (async () => {
		try {
			const conversation = await getConversationById(params.conversationId);
			const existingSummary =
				conversation.metadata &&
				typeof conversation.metadata === "object" &&
				"summary" in conversation.metadata &&
				typeof (conversation.metadata as { summary?: unknown }).summary ===
					"string"
					? String((conversation.metadata as { summary?: unknown }).summary)
					: "";

			const history = await getMessages({
				conversationId: params.conversationId,
				limit: params.maxMessages ?? 20,
			});

			const transcript = history
				.map((m) => {
					const content = (m.content || "").trim();
					if (content.length > 0) return `${m.role}: ${content}`;
					if (m.toolCalls && m.toolCalls.length > 0) {
						const tools = m.toolCalls
							.map((tc) => tc.function?.name)
							.filter(Boolean)
							.join(", ");
						return `${m.role}: [tool_calls: ${tools}]`;
					}
					return `${m.role}:`;
				})
				.join("\n");

			const summaryText = await generatePromptText({
				model: params.model as any,
				prompt: `Update the conversation memory summary for the Dokploy AI assistant.\n\nRules:\n- Keep it short (max 10 lines).\n- Capture stable facts, user preferences, selected project/server context, and decisions.\n- Do NOT include secrets (API keys, tokens, passwords).\n- Write in the same language as the conversation (if most lines are Chinese, write Chinese).\n\nExisting summary:\n${existingSummary || "(none)"}\n\nRecent conversation (most recent last):\n${transcript}\n\nReturn ONLY the updated summary.`,
				maxOutputTokens: 220,
			});

			const nextSummary = summaryText.trim();
			if (!nextSummary) return;

			await updateConversation(params.conversationId, {
				metadata: {
					...(typeof conversation.metadata === "object" && conversation.metadata
						? conversation.metadata
						: {}),
					summary: nextSummary,
				},
			});
		} catch {
			// Ignore summary errors
		}
	})();
};

export const deleteConversation = async (conversationId: string) => {
	await db
		.delete(aiConversations)
		.where(eq(aiConversations.conversationId, conversationId));
};

// ============================================
// Message Management
// ============================================

export const getMessages = async (params: {
	conversationId: string;
	limit?: number;
	before?: string;
}) => {
	const conditions = [eq(aiMessages.conversationId, params.conversationId)];
	if (params.before) {
		conditions.push(lt(aiMessages.createdAt, params.before));
	}

	const messages = await db.query.aiMessages.findMany({
		where: and(...conditions),
		orderBy: desc(aiMessages.createdAt),
		limit: params.limit || 50,
	});
	return messages.reverse();
};

export const saveMessage = async (params: {
	conversationId: string;
	role: "user" | "assistant" | "system" | "tool";
	content?: string;
	toolCalls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	toolCallId?: string;
	toolName?: string;
	promptTokens?: number;
	completionTokens?: number;
}) => {
	const [message] = await db.insert(aiMessages).values(params).returning();

	// Update conversation timestamp
	await db
		.update(aiConversations)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(aiConversations.conversationId, params.conversationId));

	return message;
};

// ============================================
// Chat Function
// ============================================

interface ChatParams {
	conversationId: string;
	message: string;
	aiId: string;
	organizationId: string;
	userId: string;
}

type ChatUsage = {
	inputTokens?: number;
	outputTokens?: number;
};

function getProviderErrorText(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	const responseBody = (err as { responseBody?: unknown })?.responseBody;
	const responseBodyText =
		typeof responseBody === "string" && responseBody.trim().length > 0
			? responseBody
			: "";

	if (responseBodyText.length === 0) return msg;
	if (msg.includes(responseBodyText)) return msg;
	return `${msg}\n${responseBodyText}`;
}

function isMissingToolUseIdError(err: unknown): boolean {
	const msg = getProviderErrorText(err);
	return (
		msg.includes("tool_use.id") ||
		msg.includes("tool_use.id:") ||
		msg.includes("function_call.args") ||
		msg.includes("type.googleapis.com/google.protobuf.Struct") ||
		(msg.includes("request.contents") &&
			msg.includes("function_call") &&
			msg.includes("Invalid value")) ||
		(msg.includes("messages.") &&
			msg.includes("tool_use") &&
			msg.includes("Field required"))
	);
}

function isInvalidJsonLikelySse(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	if (msg.includes("Invalid JSON response")) return true;
	if (msg.includes("AI_JSONParseError")) return true;
	if (msg.includes("JSON parsing failed")) return true;

	const causeText = (err as { cause?: unknown })?.cause as
		| { text?: unknown }
		| undefined;
	const text = causeText?.text;
	if (typeof text === "string" && text.trimStart().startsWith("data:")) {
		return true;
	}

	return false;
}

function normalizeUnknownToString(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function safeTruncateString(value: string, maxLen: number) {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, maxLen)}\n... (truncated)`;
}

function safeJsonForPrompt(value: unknown, maxLen: number) {
	try {
		return safeTruncateString(JSON.stringify(value, null, 2), maxLen);
	} catch {
		return safeTruncateString(String(value), maxLen);
	}
}

async function generateToolOutcomeSummary(params: {
	model: unknown;
	userMessage: string;
	toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
	toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>;
	streamError?: string | null;
}): Promise<string> {
	const toolCallsText = params.toolCalls
		.map((tc) => {
			return `tool_call_id: ${tc.id}\ntool: ${tc.name}\nargs:\n${safeJsonForPrompt(tc.arguments, 2000)}`;
		})
		.join("\n\n");

	const toolResultsText = params.toolResults
		.map((tr) => {
			return `tool_call_id: ${tr.toolCallId}\ntool: ${tr.toolName}\nresult:\n${safeJsonForPrompt(tr.result, 3000)}`;
		})
		.join("\n\n");

	const streamErrorText =
		typeof params.streamError === "string" &&
		params.streamError.trim().length > 0
			? params.streamError.trim()
			: "";

	const prompt = `You are Dokploy AI Assistant.

Write the final user-facing response for the turn based on the user's request and the tool execution details.

Rules:
- Use the same language as the user's request.
- Be concise (3-8 lines).
- If any tool result indicates pending approval (e.g., status = "pending_approval"), clearly ask the user to approve/reject.
- If any tool failed (success=false or contains error), explain what failed and what the user can do next.
- If tools succeeded, confirm completion and summarize the outcome.
- Do not include secrets.
- Output plain text only.

User request:
${safeTruncateString(params.userMessage, 1200)}

Tool calls:
${toolCallsText || "(none)"}

Tool results:
${toolResultsText || "(none)"}

${streamErrorText ? `Model streaming error (non-fatal):\n${safeTruncateString(streamErrorText, 1200)}\n` : ""}

Return ONLY the final response.`;

	const text = await generatePromptText({
		model: params.model,
		prompt,
		maxOutputTokens: 260,
	});

	return text.trim();
}

async function generatePromptText(params: {
	model: unknown;
	prompt: string;
	maxOutputTokens?: number;
}): Promise<string> {
	try {
		const result = await generateText({
			model: params.model as any,
			prompt: params.prompt,
			maxOutputTokens: params.maxOutputTokens,
		});
		return typeof result.text === "string" ? result.text : "";
	} catch (error) {
		if (!isInvalidJsonLikelySse(error)) throw error;

		const stream = streamText({
			model: params.model as any,
			prompt: params.prompt,
			maxOutputTokens: params.maxOutputTokens,
		});
		let fullText = "";
		for await (const chunk of stream.fullStream) {
			if (chunk.type !== "text-delta") continue;
			const delta = (chunk as { text?: unknown }).text;
			if (typeof delta === "string" && delta.length > 0) {
				fullText += delta;
			}
		}
		return fullText;
	}
}

export type ChatResult = {
	message: Awaited<ReturnType<typeof saveMessage>>;
	usage: ChatUsage | undefined;
	toolResults: unknown;
};

export const chat = async ({
	conversationId,
	message,
	aiId,
	organizationId,
	userId,
}: ChatParams): Promise<ChatResult> => {
	const aiSettings = await getAiSettingById(aiId);
	if (!aiSettings || !aiSettings.isEnabled) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AI features are not enabled for this configuration",
		});
	}

	// Initialize tools on first use
	initializeTools();

	// Save user message
	await saveMessage({
		conversationId,
		role: "user",
		content: message,
	});

	// Get conversation history
	const history = await getMessages({ conversationId, limit: 20 });

	// Build messages array for AI
	const messages: CoreMessage[] = history
		.map((msg) => {
			if (msg.role === "tool") return null;
			const content = (msg.content ?? "").trim();
			if (content.length > 0) {
				return {
					role: msg.role as "user" | "assistant" | "system",
					content,
				};
			}
			const toolNames = (msg.toolCalls ?? [])
				.map((tc) => tc.function?.name)
				.filter(Boolean)
				.join(", ");
			if (toolNames.length > 0) {
				return {
					role: msg.role as "user" | "assistant" | "system",
					content: `[tool_calls: ${toolNames}]`,
				};
			}
			return null;
		})
		.filter(Boolean) as CoreMessage[];

	const provider = selectAIProvider(aiSettings);
	const model = provider(aiSettings.model);

	// Get system prompt with context
	const conversation = await getConversationById(conversationId);
	const systemPrompt = buildSystemPrompt(
		conversation,
		buildMetaToolPromptInfo(),
	);

	// Build tool context
	const toolContext: ToolContext = {
		organizationId,
		userId,
		projectId: conversation.projectId || undefined,
		serverId: conversation.serverId || undefined,
	};

	const tools: Record<string, any> = {
		tool_search: tool({
			description:
				"Search the full tool catalog and return matching tool names and summaries.",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe("What you want to do or find (natural language)"),
				limit: z
					.number()
					.min(1)
					.max(30)
					.optional()
					.default(12)
					.describe("Max number of tools to return"),
			}),
			execute: async (params: { query: string; limit?: number }) => {
				return searchToolCatalog(params);
			},
		}),
		tool_describe: tool({
			description:
				"Describe a specific tool, including parameter hints extracted from its schema.",
			inputSchema: z.object({
				toolName: z
					.string()
					.min(1)
					.describe("Exact tool name, e.g. postgres_create"),
			}),
			execute: async (params: { toolName: string }) => {
				const t = toolRegistry.get(params.toolName);
				if (!t) {
					return {
						success: false,
						message: `Tool "${params.toolName}" not found`,
						error: `Unknown tool: ${params.toolName}`,
					};
				}
				return {
					success: true,
					message: `Tool "${t.name}" description retrieved`,
					data: {
						name: t.name,
						description: t.description,
						category: t.category,
						riskLevel: t.riskLevel,
						requiresApproval: t.requiresApproval,
						parameters: describeZodParameters(t.parameters),
					},
				};
			},
		}),
		tool_call: tool({
			description:
				"Execute a tool by name with params. Enforces validation and approval. Use tool_describe first if unsure about parameters.",
			inputSchema: z.object({
				toolName: z.string().min(1).describe("Exact tool name to execute"),
				params: z
					.record(z.any())
					.optional()
					.default({})
					.describe("Parameters object for the tool"),
			}),
			execute: async (params: { toolName: string; params?: unknown }) => {
				const t = toolRegistry.get(params.toolName);
				if (!t) {
					return {
						success: false,
						message: `Tool "${params.toolName}" not found`,
						error: `Unknown tool: ${params.toolName}`,
					};
				}

				const execution = await createToolExecution({
					messageId: undefined,
					toolName: t.name,
					parameters: (params.params ?? {}) as Record<string, unknown>,
					requiresApproval: t.requiresApproval,
				});

				if (t.requiresApproval) {
					return {
						status: "pending_approval",
						executionId: execution.executionId,
						toolName: t.name,
						message: `This action requires approval. Tool: ${t.name}`,
					};
				}

				try {
					await updateToolExecution(execution.executionId, {
						status: "executing",
						startedAt: new Date().toISOString(),
					});

					const result = await toolRegistry.execute(
						t.name,
						(params.params ?? {}) as Record<string, unknown>,
						toolContext,
					);

					await updateToolExecution(execution.executionId, {
						status: "completed",
						result: result,
						completedAt: new Date().toISOString(),
					});

					return { invokedTool: t.name, ...(result as object) };
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					await updateToolExecution(execution.executionId, {
						status: "failed",
						error: errorMessage,
						completedAt: new Date().toISOString(),
					});
					return {
						success: false,
						message: "Tool execution failed",
						error: errorMessage,
					};
				}
			},
		}),
	};

	const runGenerate = async (withTools: boolean) => {
		return await generateText({
			model,
			system: systemPrompt,
			messages,
			tools: withTools ? tools : undefined,
			stopWhen: stepCountIs(10),
		});
	};

	let result: Awaited<ReturnType<typeof generateText>>;
	try {
		result = await runGenerate(true);
	} catch (error) {
		if (isMissingToolUseIdError(error)) {
			result = await runGenerate(false);
		} else {
			throw error;
		}
	}

	let finalText = typeof result.text === "string" ? result.text : "";
	if (
		finalText.trim().length === 0 &&
		Array.isArray(result.toolCalls) &&
		result.toolCalls.length > 0
	) {
		const summary = await generateToolOutcomeSummary({
			model,
			userMessage: message,
			toolCalls: result.toolCalls.map((tc) => ({
				id: tc.toolCallId,
				name: tc.toolName,
				arguments:
					(tc as unknown as { args?: unknown; input?: unknown }).args ??
					(tc as unknown as { args?: unknown; input?: unknown }).input ??
					{},
			})),
			toolResults: Array.isArray(result.toolResults)
				? (result.toolResults as unknown[]).map((tr) => {
						const toolCallId =
							(tr as { toolCallId?: unknown }).toolCallId ??
							(tr as { id?: unknown }).id;
						const toolName =
							(tr as { toolName?: unknown }).toolName ??
							(tr as { name?: unknown }).name;
						const resultValue =
							(tr as { result?: unknown }).result ??
							(tr as { output?: unknown }).output ??
							tr;
						return {
							toolCallId: typeof toolCallId === "string" ? toolCallId : "",
							toolName: typeof toolName === "string" ? toolName : "",
							result: resultValue,
						};
					})
				: [],
		});
		finalText = summary || finalText;
	}

	// Save assistant response
	const assistantMessage = await saveMessage({
		conversationId,
		role: "assistant",
		content: finalText,
		toolCalls: result.toolCalls?.map((tc) => ({
			id: tc.toolCallId,
			type: "function" as const,
			function: {
				name: tc.toolName,
				arguments: JSON.stringify(
					(tc as unknown as { args?: unknown; input?: unknown }).args ??
						(tc as unknown as { args?: unknown; input?: unknown }).input ??
						{},
				),
			},
		})),
		promptTokens: result.usage?.inputTokens,
		completionTokens: result.usage?.outputTokens,
	});

	scheduleConversationSummaryUpdate({
		conversationId,
		model,
	});

	// Auto-generate title if first response (non-blocking)
	if (history.length <= 2 && conversation.title === "New Conversation") {
		try {
			const titleText = await generatePromptText({
				model,
				prompt: `Generate a short title (max 50 chars, no quotes) for this conversation. User message: "${message}". Reply with ONLY the title, nothing else.`,
				maxOutputTokens: 60,
			});
			const title = titleText.trim().slice(0, 50);
			if (title) {
				await updateConversation(conversationId, { title });
			}
		} catch (e) {
			console.error("Failed to generate title:", e);
		}
	}

	const usage: ChatUsage | undefined = result.usage
		? {
				inputTokens: result.usage.inputTokens,
				outputTokens: result.usage.outputTokens,
			}
		: undefined;

	return {
		message: assistantMessage,
		usage,
		toolResults: (result.toolResults ?? []) as unknown,
	};
};

// ============================================
// Streaming Chat Function (SSE)
// ============================================

export type ChatStreamOptions = {
	abortSignal?: AbortSignal;
	onTextDelta?: (delta: string) => void;
	onToolCall?: (toolCallId: string, toolName: string, args: unknown) => void;
	onToolResult?: (
		toolCallId: string,
		toolName: string,
		result: unknown,
	) => void;
	onError?: (error: string) => void;
};

export const chatStream = async (
	{ conversationId, message, aiId, organizationId, userId }: ChatParams,
	options: ChatStreamOptions = {},
) => {
	const aiSettings = await getAiSettingById(aiId);
	if (!aiSettings || !aiSettings.isEnabled) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AI features are not enabled for this configuration",
		});
	}

	if (aiSettings.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this AI configuration",
		});
	}

	const conversation = await getConversationById(conversationId);
	if (conversation.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this conversation",
		});
	}

	initializeTools();

	await saveMessage({
		conversationId,
		role: "user",
		content: message,
	});

	const history = await getMessages({ conversationId, limit: 20 });
	const messages: CoreMessage[] = history
		.map((msg) => {
			if (msg.role === "tool") return null;
			const content = (msg.content ?? "").trim();
			if (content.length > 0) {
				return {
					role: msg.role as "user" | "assistant" | "system",
					content,
				};
			}
			const toolNames = (msg.toolCalls ?? [])
				.map((tc) => tc.function?.name)
				.filter(Boolean)
				.join(", ");
			if (toolNames.length > 0) {
				return {
					role: msg.role as "user" | "assistant" | "system",
					content: `[tool_calls: ${toolNames}]`,
				};
			}
			return null;
		})
		.filter(Boolean) as CoreMessage[];

	const provider = selectAIProvider(aiSettings);
	const model = provider(aiSettings.model);
	const systemPrompt = buildSystemPrompt(
		conversation,
		buildMetaToolPromptInfo(),
	);

	const toolContext: ToolContext = {
		organizationId,
		userId,
		projectId: conversation.projectId || undefined,
		serverId: conversation.serverId || undefined,
	};

	const tools: Record<string, any> = {
		tool_search: tool({
			description:
				"Search the full tool catalog and return matching tool names and summaries.",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe("What you want to do or find (natural language)"),
				limit: z
					.number()
					.min(1)
					.max(30)
					.optional()
					.default(12)
					.describe("Max number of tools to return"),
			}),
			execute: async (params: { query: string; limit?: number }) => {
				return searchToolCatalog(params);
			},
		}),
		tool_describe: tool({
			description:
				"Describe a specific tool, including parameter hints extracted from its schema.",
			inputSchema: z.object({
				toolName: z
					.string()
					.min(1)
					.describe("Exact tool name, e.g. postgres_create"),
			}),
			execute: async (params: { toolName: string }) => {
				const t = toolRegistry.get(params.toolName);
				if (!t) {
					return {
						success: false,
						message: `Tool "${params.toolName}" not found`,
						error: `Unknown tool: ${params.toolName}`,
					};
				}
				return {
					success: true,
					message: `Tool "${t.name}" description retrieved`,
					data: {
						name: t.name,
						description: t.description,
						category: t.category,
						riskLevel: t.riskLevel,
						requiresApproval: t.requiresApproval,
						parameters: describeZodParameters(t.parameters),
					},
				};
			},
		}),
		tool_call: tool({
			description:
				"Execute a tool by name with params. Enforces validation and approval. Use tool_describe first if unsure about parameters.",
			inputSchema: z.object({
				toolName: z.string().min(1).describe("Exact tool name to execute"),
				params: z
					.record(z.any())
					.optional()
					.default({})
					.describe("Parameters object for the tool"),
			}),
			execute: async (params: { toolName: string; params?: unknown }) => {
				const t = toolRegistry.get(params.toolName);
				if (!t) {
					return {
						success: false,
						message: `Tool "${params.toolName}" not found`,
						error: `Unknown tool: ${params.toolName}`,
					};
				}

				const execution = await createToolExecution({
					messageId: undefined,
					toolName: t.name,
					parameters: (params.params ?? {}) as Record<string, unknown>,
					requiresApproval: t.requiresApproval,
				});

				if (t.requiresApproval) {
					return {
						status: "pending_approval",
						executionId: execution.executionId,
						toolName: t.name,
						message: `This action requires approval. Tool: ${t.name}`,
					};
				}

				try {
					await updateToolExecution(execution.executionId, {
						status: "executing",
						startedAt: new Date().toISOString(),
					});

					const result = await toolRegistry.execute(
						t.name,
						(params.params ?? {}) as Record<string, unknown>,
						toolContext,
					);

					await updateToolExecution(execution.executionId, {
						status: "completed",
						result: result,
						completedAt: new Date().toISOString(),
					});

					return { invokedTool: t.name, ...(result as object) };
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					await updateToolExecution(execution.executionId, {
						status: "failed",
						error: errorMessage,
						completedAt: new Date().toISOString(),
					});
					return {
						success: false,
						message: "Tool execution failed",
						error: errorMessage,
					};
				}
			},
		}),
	};

	const runStream = async (withTools: boolean) => {
		const stopWhen = stepCountIs(10);
		const stream = streamText({
			model,
			system: systemPrompt,
			messages,
			tools: withTools ? tools : undefined,
			stopWhen,
			abortSignal: options.abortSignal,
		});

		let fullText = "";
		const toolCalls: Array<{
			id: string;
			type: "function";
			function: { name: string; arguments: string };
		}> = [];
		let usage: { promptTokens?: number; completionTokens?: number } = {};
		const toolResults: Array<{
			toolCallId: string;
			toolName: string;
			result: unknown;
		}> = [];
		let streamError: string | null = null;
		let hasAnyOutput = false;

		try {
			for await (const chunk of stream.fullStream) {
				if (chunk.type === "text-delta") {
					const delta = typeof chunk.text === "string" ? chunk.text : "";
					if (delta.length === 0) continue;
					hasAnyOutput = true;

					fullText += delta;
					try {
						options.onTextDelta?.(delta);
					} catch {
						// Ignore callback errors (e.g., client disconnected)
					}
				} else if (chunk.type === "tool-call") {
					hasAnyOutput = true;
					const args = (chunk as { input: unknown }).input;
					toolCalls.push({
						id: chunk.toolCallId,
						type: "function",
						function: {
							name: chunk.toolName,
							arguments: JSON.stringify(args ?? {}),
						},
					});
					try {
						options.onToolCall?.(chunk.toolCallId, chunk.toolName, args ?? {});
					} catch {
						// Ignore callback errors
					}
				} else if (chunk.type === "tool-result") {
					hasAnyOutput = true;
					const toolResult =
						(chunk as unknown as { result?: unknown }).result ??
						(chunk as unknown as { output?: unknown }).output;
					toolResults.push({
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						result: toolResult,
					});
					try {
						options.onToolResult?.(
							chunk.toolCallId,
							chunk.toolName,
							toolResult,
						);
					} catch {
						// Ignore callback errors
					}
				} else if (chunk.type === "finish") {
					const usageObj = (chunk as { usage?: unknown }).usage as
						| { inputTokens?: number; outputTokens?: number }
						| undefined;
					usage = {
						promptTokens: usageObj?.inputTokens,
						completionTokens: usageObj?.outputTokens,
					};
				} else if (chunk.type === "error") {
					streamError = normalizeUnknownToString(
						(chunk as unknown as { error?: unknown }).error,
					);
				}
			}
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				// Client disconnected, save what we have
			} else {
				streamError = getProviderErrorText(error);
			}
		}

		if (streamError != null && !options.abortSignal?.aborted && !hasAnyOutput) {
			throw new Error(streamError);
		}

		if (
			!hasAnyOutput &&
			fullText.length === 0 &&
			!options.abortSignal?.aborted
		) {
			throw new Error("AI stream completed with no content");
		}

		return { fullText, toolCalls, toolResults, usage, streamError };
	};

	let streamed: Awaited<ReturnType<typeof runStream>>;
	try {
		streamed = await runStream(true);
	} catch (error) {
		if (isMissingToolUseIdError(error) && !options.abortSignal?.aborted) {
			streamed = await runStream(false);
		} else {
			throw error;
		}
	}

	if (
		streamed.fullText.trim().length === 0 &&
		Array.isArray(streamed.toolCalls) &&
		streamed.toolCalls.length > 0 &&
		!options.abortSignal?.aborted
	) {
		const summary = await generateToolOutcomeSummary({
			model,
			userMessage: message,
			toolCalls: streamed.toolCalls.map((tc) => ({
				id: tc.id,
				name: tc.function.name,
				arguments: (() => {
					try {
						return JSON.parse(tc.function.arguments);
					} catch {
						return tc.function.arguments;
					}
				})(),
			})),
			toolResults: streamed.toolResults,
			streamError: streamed.streamError,
		});

		if (summary.length > 0) {
			try {
				options.onTextDelta?.(summary);
			} catch {
				// Ignore callback errors
			}
			streamed.fullText = summary;
		}
	}

	const assistantMessage = await saveMessage({
		conversationId,
		role: "assistant",
		content: streamed.fullText,
		toolCalls: streamed.toolCalls.length > 0 ? streamed.toolCalls : undefined,
		promptTokens: streamed.usage.promptTokens,
		completionTokens: streamed.usage.completionTokens,
	});

	const usage: ChatUsage | undefined =
		streamed.usage.promptTokens != null ||
		streamed.usage.completionTokens != null
			? {
					inputTokens: streamed.usage.promptTokens,
					outputTokens: streamed.usage.completionTokens,
				}
			: undefined;

	scheduleConversationSummaryUpdate({
		conversationId,
		model,
	});

	if (history.length <= 2 && conversation.title === "New Conversation") {
		void (async () => {
			try {
				const titleText = await generatePromptText({
					model,
					prompt: `Generate a short title (max 50 chars, no quotes) for this conversation. User message: "${message}". Reply with ONLY the title, nothing else.`,
					maxOutputTokens: 60,
				});
				const title = titleText.trim().slice(0, 50);
				if (title) {
					await updateConversation(conversationId, { title });
				}
			} catch (e) {
				console.error("Failed to generate title:", e);
			}
		})();
	}

	return {
		message: assistantMessage,
		usage,
		toolResults: [],
	};
};

function buildSystemPrompt(
	conversation: Awaited<ReturnType<typeof getConversationById>>,
	availableTools: ToolPromptInfo[],
) {
	let context = "";
	if (conversation.projectId) {
		context += `\nUser is viewing project: ${conversation.projectId}`;
	}
	if (conversation.serverId) {
		context += `\nUser is on server: ${conversation.serverId}`;
	}

	const memorySummary =
		conversation.metadata &&
		typeof conversation.metadata === "object" &&
		"summary" in conversation.metadata &&
		typeof (conversation.metadata as { summary?: unknown }).summary === "string"
			? String((conversation.metadata as { summary?: unknown }).summary)
			: "";

	const toolList = availableTools
		.map(
			(t) =>
				`- ${t.name}: ${t.description} (Risk: ${t.riskLevel}${t.requiresApproval ? ", requires approval" : ""})`,
		)
		.join("\n");

	return `You are Dokploy AI Assistant, an expert DevOps assistant for the Dokploy PaaS platform.

You help users manage their applications, databases, and infrastructure through natural language.
You have access to tools that can execute real operations on the platform.

Current Context:${context || " General conversation"}

Conversation Memory Summary:${memorySummary ? `\n${memorySummary}` : " (none)"}

Available Tools (selected for this request):
${toolList}

Guidelines:
- Be concise and helpful
- You can access ALL platform capabilities through a tool catalog.
- Workflow:
  - Use tool_search to find the best tool(s) for the user's intent.
  - Use tool_describe to see parameter hints for the chosen tool.
  - Use tool_call to execute the real tool by name.
- For complex requests (especially GitHub deployments and debugging), always propose at least two viable plans and ask the user to choose one before any write action. The plans should help the user decide key choices like naming (project/appName), deployment method (application vs compose), repo/branch, and buildPath/composePath.
- Naming strategy:
  - If the user does not provide names, auto-generate them from the repository (owner/repo) without asking.
  - Defaults:
    - project name: repo name
    - application display name / compose display name: repo name
    - application appName / compose appName: repo name + short suffix (e.g., "repo-xxxx") to reduce collisions
  - If a create call fails due to name conflicts, retry once with a different suffix. Only ask the user if conflicts persist or if they have a naming preference.
- GitHub repository code changes (optional):
  - If the fix requires changing repository code, first ask the user whether they want you to create a PR.
  - If the user agrees, then use github_file_get to read the current file content, show a unified diff and explain why, and only then call github_branch_create/github_file_upsert/github_pull_request_create (approval required).
- Deployment debugging workflow:
  - Use deployment_list and deployment_log_tail to retrieve the failing deployment and its logs.
  - Prefer fixing Dokploy configuration first (e.g., application_update_github_source/compose_update_github_source).
  - If the fix requires repository code changes, ask the user whether they want a PR.
  - If you cannot fix the issue, clearly explain the root cause, what evidence you used (log excerpts), and what information or access is missing.
- Do NOT invent tool names. Always use tool_search/tool_describe first if unsure.
- For any request that can change platform state (create/deploy/restart/delete/update), first restate the user's intent in one sentence, then list any missing required details, then proceed.
- If the user's request is ambiguous, do NOT assume. Ask focused clarifying questions. Prefer asking 1-3 questions max per turn.
- Never guess IDs (projectId/serverId/environmentId/applicationId/etc). Use *find*/*list* tools to locate candidates, then ask the user to confirm when ambiguous.
- Do not ask the user for information you can retrieve via tools.
- Prefer read-only tools first (list/get/status/check/find) to understand the current state.
- For low-risk operations (list, get, status, check, find), execute immediately.
- For medium/high risk operations, explain what will happen BEFORE the tool is called.
- If a tool requires approval, clearly state that approval is required and WAIT for approval before claiming the action is done.
- Always report the results of tool executions clearly
- If you do not have the necessary tool in the Available Tools list, do NOT claim the platform cannot do it. Instead: explain that the current toolset for this request is insufficient, state what tool/category is missing, and suggest the next best step (e.g., use list/find tools, or ask an admin to enable the capability).
- Database provisioning flow:
  - If user wants to deploy a database, first identify the target project/environment using tools (project_list/project_find, environment_list/environment_find).
  - If the user asks for PostgreSQL 17, prefer docker image "postgres:17".
  - Only call create/deploy tools after you have the environmentId and the user has explicitly confirmed the exact action.`;
}

// ============================================
// Agent Operations
// ============================================

export const createRun = async (params: {
	conversationId: string;
	goal: string;
}) => {
	const [run] = await db
		.insert(aiRuns)
		.values({
			conversationId: params.conversationId,
			goal: params.goal,
			status: "planning",
		})
		.returning();
	return run;
};

export const getRunById = async (runId: string) => {
	const run = await db.query.aiRuns.findFirst({
		where: eq(aiRuns.runId, runId),
		with: {
			toolExecutions: true,
		},
	});
	if (!run) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Run not found",
		});
	}
	return run;
};

export const updateRun = async (
	runId: string,
	data: Partial<{
		status:
			| "pending"
			| "planning"
			| "waiting_approval"
			| "executing"
			| "verifying"
			| "completed"
			| "failed"
			| "cancelled";
		plan: {
			steps: Array<{
				id: string;
				toolName: string;
				description: string;
				parameters: Record<string, unknown>;
				requiresApproval: boolean;
			}>;
		};
		result: { success: boolean; summary: string; data?: unknown };
		error: string;
		startedAt: string;
		completedAt: string;
	}>,
) => {
	const [updated] = await db
		.update(aiRuns)
		.set(data)
		.where(eq(aiRuns.runId, runId))
		.returning();
	return updated;
};

export const cancelRun = async (runId: string) => {
	return updateRun(runId, {
		status: "cancelled",
		completedAt: new Date().toISOString(),
	});
};

// ============================================
// Tool Execution Management
// ============================================

export const createToolExecution = async (params: {
	runId?: string;
	messageId?: string;
	toolName: string;
	parameters: Record<string, unknown>;
	requiresApproval: boolean;
}) => {
	const [execution] = await db
		.insert(aiToolExecutions)
		.values({
			...params,
			status: params.requiresApproval ? "pending" : "executing",
		})
		.returning();
	if (!execution) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to create tool execution",
		});
	}
	return execution;
};

export const getToolExecutionById = async (executionId: string) => {
	const execution = await db.query.aiToolExecutions.findFirst({
		where: eq(aiToolExecutions.executionId, executionId),
	});
	if (!execution) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Tool execution not found",
		});
	}
	return execution;
};

export const approveToolExecution = async (
	executionId: string,
	approved: boolean,
	approvedBy: string,
) => {
	const [updated] = await db
		.update(aiToolExecutions)
		.set({
			status: approved ? "approved" : "rejected",
			approvedBy,
			approvedAt: new Date().toISOString(),
		})
		.where(eq(aiToolExecutions.executionId, executionId))
		.returning();
	return updated;
};

export const updateToolExecution = async (
	executionId: string,
	data: Partial<{
		status:
			| "pending"
			| "approved"
			| "rejected"
			| "executing"
			| "completed"
			| "failed";
		result: {
			success: boolean;
			message?: string;
			data?: unknown;
			error?: string;
		};
		error: string;
		startedAt: string;
		completedAt: string;
	}>,
) => {
	const [updated] = await db
		.update(aiToolExecutions)
		.set(data)
		.where(eq(aiToolExecutions.executionId, executionId))
		.returning();
	return updated;
};

// ============================================
// Execute Approved Tool
// ============================================

export const executeApprovedTool = async (
	executionId: string,
	ctx: ToolContext,
) => {
	const execution = await getToolExecutionById(executionId);

	if (execution.status !== "approved") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Tool execution is not approved. Current status: ${execution.status}`,
		});
	}

	initializeTools();
	const t = toolRegistry.get(execution.toolName);
	if (!t) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Tool "${execution.toolName}" not found`,
		});
	}

	const validation = t.parameters.safeParse(execution.parameters);
	if (!validation.success) {
		await updateToolExecution(executionId, {
			status: "failed",
			error: validation.error.message,
			completedAt: new Date().toISOString(),
		});
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Invalid parameters for tool "${execution.toolName}": ${validation.error.message}`,
		});
	}

	try {
		await updateToolExecution(executionId, {
			status: "executing",
			startedAt: new Date().toISOString(),
		});

		const result = await t.execute(validation.data, ctx);

		await updateToolExecution(executionId, {
			status: "completed",
			result: result,
			completedAt: new Date().toISOString(),
		});

		return result;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await updateToolExecution(executionId, {
			status: "failed",
			error: errorMessage,
			completedAt: new Date().toISOString(),
		});

		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Tool execution failed: ${errorMessage}`,
		});
	}
};

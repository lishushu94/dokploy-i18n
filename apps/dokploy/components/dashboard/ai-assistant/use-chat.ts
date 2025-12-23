"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/utils/api";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function* readSseStream(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		while (true) {
			const lfIndex = buffer.indexOf("\n\n");
			const crlfIndex = buffer.indexOf("\r\n\r\n");
			const useCrlf =
				crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex);
			const splitIndex = useCrlf ? crlfIndex : lfIndex;
			if (splitIndex === -1) break;

			const raw = buffer.slice(0, splitIndex);
			buffer = buffer.slice(splitIndex + (useCrlf ? 4 : 2));

			const lines = raw.split(/\r?\n/);
			let event = "message";
			const dataLines: string[] = [];

			for (const line of lines) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
			}

			const data = dataLines.join("\n");
			if (data.length === 0) continue;
			yield { event, data };
		}
	}
}

export interface ToolCall {
	id: string;
	type: "function";
	status?:
		| "pending"
		| "approved"
		| "rejected"
		| "executing"
		| "completed"
		| "failed";
	executionId?: string;
	result?: {
		success: boolean;
		message?: string;
		data?: unknown;
		error?: string;
	};
	function: {
		name: string;
		arguments: string;
	};
}

export interface Message {
	messageId: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string | null;
	toolCalls?: ToolCall[] | null;
	createdAt: string;
	status?: "sending" | "sent" | "error";
	error?: string;
}

export interface UseChatOptions {
	conversationId?: string;
	aiId?: string;
	projectId?: string;
	serverId?: string;
	onError?: (error: Error) => void;
}

export function useChat(options: UseChatOptions = {}) {
	const [conversationId, setConversationId] = useState<string | undefined>(
		options.conversationId,
	);
	const [pendingMessages, setPendingMessages] = useState<Message[]>([]);
	const [toolCallMeta, setToolCallMeta] = useState<
		Record<string, Pick<ToolCall, "status" | "executionId" | "result">>
	>({});
	const [isLoading, setIsLoading] = useState(false);
	const [abortController, setAbortController] =
		useState<AbortController | null>(null);
	const approveExecution = api.ai.agent.approve.useMutation();
	const executeExecution = api.ai.agent.execute.useMutation();

	useEffect(() => {
		return () => {
			abortController?.abort();
		};
	}, [abortController]);

	const createConversation = api.ai.conversations.create.useMutation({
		onSuccess: (data) => {
			setConversationId(data?.conversationId);
		},
	});

	const { data: serverMessages, refetch: refetchMessages } =
		api.ai.chat.messages.useQuery(
			{ conversationId: conversationId || "" },
			{
				enabled: !!conversationId,
				refetchOnWindowFocus: false,
			},
		);

	const messages = useMemo(() => {
		const applyMeta = (msg: Message): Message => {
			if (!msg.toolCalls || msg.toolCalls.length === 0) return msg;
			return {
				...msg,
				toolCalls: msg.toolCalls.map((tc) => ({
					...tc,
					...(toolCallMeta[tc.id] ?? {}),
				})),
			};
		};

		const server = ((serverMessages || []) as Message[]).map(applyMeta);
		const pendingOnly = pendingMessages
			.filter((pm) => {
				if (pm.status === "sending") return true;
				return !server.some(
					(sm) => sm.content === pm.content && sm.role === pm.role,
				);
			})
			.map(applyMeta);
		return [...server, ...pendingOnly];
	}, [serverMessages, pendingMessages, toolCallMeta]);

	const approveToolCall = useCallback(
		async (toolCallId: string) => {
			const meta = toolCallMeta[toolCallId];
			const executionId = meta?.executionId;
			if (!executionId) return;

			type NormalizedToolResult = NonNullable<ToolCall["result"]>;

			try {
				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: { ...(prev[toolCallId] ?? {}), status: "approved" },
				}));
				await approveExecution.mutateAsync({ executionId, approved: true });

				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: { ...(prev[toolCallId] ?? {}), status: "executing" },
				}));
				const execResult = await executeExecution.mutateAsync({
					executionId,
					conversationId,
				});
				const normalizedResult: NormalizedToolResult = (() => {
					if (isRecord(execResult) && typeof execResult.success === "boolean") {
						return {
							success: execResult.success,
							message:
								typeof execResult.message === "string"
									? execResult.message
									: undefined,
							data: execResult.data,
							error:
								typeof execResult.error === "string"
									? execResult.error
									: undefined,
						};
					}
					return { success: true, data: execResult };
				})();

				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: {
						...(prev[toolCallId] ?? {}),
						status: normalizedResult.success ? "completed" : "failed",
						result: normalizedResult,
					},
				}));
				await refetchMessages().catch(() => {});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: {
						...(prev[toolCallId] ?? {}),
						status: "failed",
						result: { success: false, error: message },
					},
				}));
				options.onError?.(error as Error);
			}
		},
		[
			approveExecution,
			executeExecution,
			refetchMessages,
			toolCallMeta,
			options,
		],
	);

	const rejectToolCall = useCallback(
		async (toolCallId: string) => {
			const meta = toolCallMeta[toolCallId];
			const executionId = meta?.executionId;
			if (!executionId) return;

			try {
				await approveExecution.mutateAsync({ executionId, approved: false });
				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: {
						...(prev[toolCallId] ?? {}),
						status: "rejected",
						result: { success: false, message: "Rejected" },
					},
				}));
				await refetchMessages().catch(() => {});
			} catch (error) {
				options.onError?.(error as Error);
			}
		},
		[approveExecution, refetchMessages, toolCallMeta, options],
	);

	const stopGeneration = useCallback(() => {
		abortController?.abort();
		setAbortController(null);
		setIsLoading(false);
	}, [abortController]);

	const send = useCallback(
		async (content: string, aiId: string) => {
			if (!content.trim()) return;

			setIsLoading(true);

			const timestamp = Date.now();
			const userTempId = `temp-${timestamp}-user`;
			const assistantTempId = `temp-${timestamp}-assistant`;

			const userMessage: Message = {
				messageId: userTempId,
				role: "user",
				content,
				createdAt: new Date().toISOString(),
				status: "sending",
			};

			const assistantMessage: Message = {
				messageId: assistantTempId,
				role: "assistant",
				content: "",
				createdAt: new Date().toISOString(),
				status: "sending",
			};

			setPendingMessages((prev) => [...prev, userMessage, assistantMessage]);

			let currentConversationId = conversationId;

			if (!currentConversationId) {
				try {
					const newConversation = await createConversation.mutateAsync({
						aiId,
						projectId: options.projectId,
						serverId: options.serverId,
					});
					if (!newConversation?.conversationId) {
						throw new Error("Failed to create conversation");
					}
					currentConversationId = newConversation.conversationId;
				} catch (error) {
					const errorMsg =
						error instanceof Error
							? error.message
							: "Failed to create conversation";
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setIsLoading(false);
					options.onError?.(error as Error);
					return;
				}
			}

			try {
				const controller = new AbortController();
				setAbortController(controller);

				const response = await fetch("/api/ai/stream", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "text/event-stream",
					},
					body: JSON.stringify({
						conversationId: currentConversationId,
						message: content,
						aiId,
					}),
					signal: controller.signal,
				});

				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					throw new Error(errorText || `Request failed (${response.status})`);
				}

				if (!response.body) {
					throw new Error("Streaming response not available");
				}

				setPendingMessages((prev) =>
					prev.map((m) =>
						m.messageId === userTempId ? { ...m, status: "sent" as const } : m,
					),
				);

				let receivedDone = false;

				for await (const evt of readSseStream(response.body)) {
					if (controller.signal.aborted) break;

					if (evt.event === "delta") {
						const payload = JSON.parse(evt.data) as { delta?: unknown };
						const delta =
							typeof payload.delta === "string" ? payload.delta : "";
						if (delta.length === 0) continue;

						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? {
											...m,
											content: (m.content ?? "") + delta,
											status: "sending" as const,
										}
									: m,
							),
						);
					}

					if (evt.event === "tool-call") {
						const payload = JSON.parse(evt.data) as {
							toolCallId: string;
							toolName: string;
							arguments?: unknown;
						};
						const argsString =
							typeof payload.arguments === "string"
								? payload.arguments
								: JSON.stringify(payload.arguments ?? {});
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? {
											...m,
											toolCalls: [
												...(m.toolCalls || []),
												{
													id: payload.toolCallId,
													type: "function" as const,
													function: {
														name: payload.toolName,
														arguments: argsString,
													},
												},
											],
										}
									: m,
							),
						);
					}

					if (evt.event === "tool-result") {
						const payload = JSON.parse(evt.data) as {
							toolCallId: string;
							toolName: string;
							result?: unknown;
						};

						setPendingMessages((prev) =>
							prev.map((m) => {
								if (m.messageId !== assistantTempId) return m;
								const toolCalls = [...(m.toolCalls || [])];
								const existingIndex = toolCalls.findIndex(
									(tc) => tc.id === payload.toolCallId,
								);

								const existingToolCall =
									existingIndex >= 0 ? toolCalls[existingIndex] : undefined;
								const base: ToolCall = existingToolCall ?? {
									id: payload.toolCallId,
									type: "function" as const,
									function: { name: payload.toolName, arguments: "{}" },
								};

								// Determine status and result from payload
								let status: ToolCall["status"] = "completed";
								let executionId: string | undefined;
								let result: ToolCall["result"] | undefined;

								const payloadResult = isRecord(payload.result)
									? payload.result
									: undefined;
								if (
									payloadResult &&
									payloadResult.status === "pending_approval" &&
									typeof payloadResult.executionId === "string"
								) {
									status = "pending";
									executionId = payloadResult.executionId;
									result = payloadResult.message
										? { success: true, message: String(payloadResult.message) }
										: undefined;
								} else if (
									payloadResult &&
									typeof payloadResult.success === "boolean"
								) {
									status = payloadResult.success ? "completed" : "failed";
									result = {
										success: payloadResult.success,
										message: payloadResult.message as string | undefined,
										data: payloadResult.data,
										error: payloadResult.error as string | undefined,
									};
								}

								const updated: ToolCall = {
									...base,
									executionId: executionId ?? base.executionId,
									status,
									result: result ?? base.result,
									function: {
										...base.function,
										name: payload.toolName || base.function.name,
									},
								};

								setToolCallMeta((prev) => ({
									...prev,
									[payload.toolCallId]: {
										status: updated.status,
										executionId: updated.executionId,
										result: updated.result,
									},
								}));

								if (existingIndex >= 0 && existingToolCall) {
									toolCalls[existingIndex] = updated;
								} else {
									toolCalls.push(updated);
								}

								return { ...m, toolCalls };
							}),
						);
					}

					if (evt.event === "done") {
						receivedDone = true;
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === userTempId || m.messageId === assistantTempId
									? { ...m, status: "sent" as const }
									: m,
							),
						);
						break;
					}

					if (evt.event === "error" || evt.event === "stream-error") {
						const payload = JSON.parse(evt.data) as {
							message?: string;
							error?: string;
						};
						throw new Error(
							payload.message || payload.error || "Streaming error",
						);
					}
				}

				if (!controller.signal.aborted && !receivedDone) {
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				setAbortController(null);
			} catch (error) {
				setAbortController(null);
				if ((error as Error).name === "AbortError") {
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				} else {
					const errorMsg =
						error instanceof Error ? error.message : "Unknown error";
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setIsLoading(false);
					options.onError?.(error as Error);
					return;
				}
			}

			try {
				await refetchMessages();
			} finally {
				setPendingMessages((prev) =>
					prev.filter(
						(m) =>
							m.messageId !== userTempId && m.messageId !== assistantTempId,
					),
				);
				setIsLoading(false);
			}
		},
		[
			conversationId,
			createConversation,
			refetchMessages,
			options.projectId,
			options.serverId,
			options,
		],
	);

	const reset = useCallback(() => {
		abortController?.abort();
		setAbortController(null);
		setConversationId(undefined);
		setPendingMessages([]);
		setToolCallMeta({});
	}, [abortController]);

	const retryMessage = useCallback(
		async (messageId: string, aiId: string) => {
			const message = pendingMessages.find((m) => m.messageId === messageId);
			if (!message || !message.content) return;

			setPendingMessages((prev) =>
				prev.filter((m) => m.messageId !== messageId),
			);

			await send(message.content, aiId);
		},
		[pendingMessages, send],
	);

	return {
		conversationId,
		messages,
		isLoading,
		send,
		approveToolCall,
		rejectToolCall,
		reset,
		retryMessage,
		refetchMessages,
		stopGeneration,
	};
}

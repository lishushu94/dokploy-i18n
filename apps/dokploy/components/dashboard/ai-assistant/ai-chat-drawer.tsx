"use client";

import { Bot, Loader2, MessageSquare, Send, Square } from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { api } from "@/utils/api";
import { MessageBubble } from "./message-bubble";
import { ToolExecutionHistory } from "./tool-execution-history";
import { useChat } from "./use-chat";

interface AIChatDrawerProps {
	projectId?: string;
	serverId?: string;
}

export function AIChatDrawer({
	projectId: _projectId,
	serverId: _serverId,
}: AIChatDrawerProps) {
	const router = useRouter();
	const { t } = useTranslation("common");
	const [isOpen, setIsOpen] = useState(false);
	const [input, setInput] = useState("");
	const [selectedAiId, setSelectedAiId] = useState<string>("");
	const viewportRef = useRef<HTMLDivElement>(null);
	const isNearBottomRef = useRef(true);

	const routeProjectId =
		typeof router.query.projectId === "string"
			? router.query.projectId
			: Array.isArray(router.query.projectId)
				? router.query.projectId[0]
				: undefined;
	const routeServerId =
		typeof router.query.serverId === "string"
			? router.query.serverId
			: Array.isArray(router.query.serverId)
				? router.query.serverId[0]
				: undefined;

	const projectId = _projectId ?? routeProjectId;
	const serverId = _serverId ?? routeServerId;

	// Lazy load AI configs only when drawer is open
	const { data: aiConfigs, isLoading: isLoadingConfigs } =
		api.ai.getAll.useQuery(undefined, {
			enabled: isOpen,
		});

	const {
		messages,
		isLoading,
		send,
		reset,
		retryMessage,
		approveToolCall,
		rejectToolCall,
		stopGeneration,
	} = useChat({
		onError: (error) => {
			toast.error(error.message || t("ai.chat.sendError"));
		},
		projectId,
		serverId,
	});

	// Auto-select first AI config
	useEffect(() => {
		if (aiConfigs && aiConfigs.length > 0 && !selectedAiId) {
			const enabledConfig = aiConfigs.find((c) => c.isEnabled);
			if (enabledConfig) {
				setSelectedAiId(enabledConfig.aiId);
			}
		}
	}, [aiConfigs, selectedAiId]);

	// Track scroll position
	const handleViewportScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			const target = e.currentTarget;
			const threshold = 100;
			isNearBottomRef.current =
				target.scrollHeight - target.scrollTop - target.clientHeight <
				threshold;
		},
		[],
	);

	// Smart auto-scroll - only if near bottom
	useEffect(() => {
		if (viewportRef.current && isNearBottomRef.current) {
			viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
		}
	}, [messages]);

	useEffect(() => {
		if (!isOpen) return;
		if (!viewportRef.current) return;
		viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
	}, [isOpen]);

	const handleSend = async () => {
		if (!input.trim() || !selectedAiId || isLoading) return;

		const message = input;
		setInput("");
		await send(message, selectedAiId);
	};

	const handleKeyPress = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const handleRetry = async (messageId: string) => {
		if (selectedAiId) {
			await retryMessage(messageId, selectedAiId);
		}
	};

	const hasAiConfigs = aiConfigs && aiConfigs.length > 0;

	return (
		<Sheet open={isOpen} onOpenChange={setIsOpen}>
			<SheetTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-shadow z-50"
					aria-label={t("ai.chat.openAssistant")}
				>
					<Bot className="h-6 w-6" />
				</Button>
			</SheetTrigger>
			<SheetContent className="w-full sm:w-[440px] p-0 flex flex-col gap-0">
				<SheetHeader className="px-4 py-3 border-b pr-12">
					<div className="flex items-center justify-between">
						<SheetTitle className="flex items-center gap-2">
							<Bot className="h-5 w-5" />
							{t("ai.chat.title")}
						</SheetTitle>
						<div className="flex items-center gap-1">
							<ToolExecutionHistory messages={messages} />
							<Button
								variant="ghost"
								size="icon"
								onClick={() => reset()}
								className="h-8 w-8"
								title={t("ai.chat.newConversation")}
								aria-label={t("ai.chat.newConversation")}
							>
								<MessageSquare className="h-4 w-4" />
							</Button>
						</div>
					</div>
					{hasAiConfigs && (
						<Select value={selectedAiId} onValueChange={setSelectedAiId}>
							<SelectTrigger
								className="w-full mt-2"
								aria-label={t("ai.chat.selectModel")}
							>
								<SelectValue placeholder={t("ai.chat.selectModel")} />
							</SelectTrigger>
							<SelectContent>
								{aiConfigs
									.filter((c) => c.isEnabled)
									.map((config) => (
										<SelectItem key={config.aiId} value={config.aiId}>
											{config.name} ({config.model})
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					)}
				</SheetHeader>

				<ScrollArea
					className="flex-1 min-h-0"
					viewPortClassName="p-4"
					viewportRef={viewportRef}
					onViewportScroll={handleViewportScroll}
					role="log"
					aria-live="polite"
					aria-label="Chat messages"
				>
					{!hasAiConfigs && !isLoadingConfigs ? (
						<div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-4 py-20">
							<Bot className="h-12 w-12" />
							<div>
								<p className="font-medium">{t("ai.chat.noConfigured")}</p>
								<p className="text-sm">{t("ai.chat.goToSettings")}</p>
							</div>
						</div>
					) : isLoadingConfigs ? (
						<div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-4 py-20">
							<Loader2 className="h-8 w-8 animate-spin" />
							<p className="text-sm">{t("common.loading")}</p>
						</div>
					) : messages.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-6 px-8">
							<div className="bg-primary/10 p-4 rounded-full">
								<Bot className="h-12 w-12 text-primary" />
							</div>
							<div className="space-y-2">
								<p className="font-medium text-lg text-foreground">
									{t("ai.chat.welcomeTitle")}
								</p>
								<p className="text-sm leading-relaxed max-w-[280px] mx-auto">
									{t("ai.chat.welcomeDescription")}
								</p>
							</div>
						</div>
					) : (
						<div className="space-y-1">
							{messages.map((message, index) => (
								<div key={message.messageId}>
									<MessageBubble
										message={message}
										onApproveToolCall={approveToolCall}
										onRejectToolCall={rejectToolCall}
										isLast={index === messages.length - 1}
										onRetry={() => handleRetry(message.messageId)}
									/>
								</div>
							))}
						</div>
					)}
				</ScrollArea>

				<div className="border-t p-4">
					<div className="flex gap-2">
						<Input
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={handleKeyPress}
							placeholder={
								hasAiConfigs
									? t("ai.chat.inputPlaceholder")
									: t("ai.chat.configureFirst")
							}
							disabled={!hasAiConfigs || (isLoading && !stopGeneration)}
							className="flex-1"
							aria-label={t("ai.chat.inputLabel")}
						/>
						{isLoading ? (
							<Button
								onClick={stopGeneration}
								variant="destructive"
								size="icon"
								aria-label={t("common.stop")}
							>
								<Square className="h-4 w-4 fill-current" />
							</Button>
						) : (
							<Button
								onClick={handleSend}
								disabled={!hasAiConfigs || !input.trim()}
								size="icon"
								aria-label={t("ai.chat.sendMessage")}
							>
								<Send className="h-4 w-4" />
							</Button>
						)}
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}

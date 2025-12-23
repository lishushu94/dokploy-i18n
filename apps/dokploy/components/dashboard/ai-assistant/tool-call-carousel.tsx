"use client";

import { ChevronLeft, ChevronRight, Layers } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ToolCallBlock } from "./tool-call-block";
import type { ToolCall } from "./use-chat";

interface ToolCallCarouselProps {
	toolCalls: ToolCall[];
	onApproveToolCall?: (toolCallId: string) => void;
	onRejectToolCall?: (toolCallId: string) => void;
}

export function ToolCallCarousel({
	toolCalls,
	onApproveToolCall,
	onRejectToolCall,
}: ToolCallCarouselProps) {
	const { t } = useTranslation("common");
	const [currentIndex, setCurrentIndex] = useState(0);

	if (!toolCalls || toolCalls.length === 0) return null;

	const currentToolCall = toolCalls[currentIndex];
	const hasNext = currentIndex < toolCalls.length - 1;
	const hasPrev = currentIndex > 0;

	const handleNext = () => {
		if (hasNext) setCurrentIndex((prev) => prev + 1);
	};

	const handlePrev = () => {
		if (hasPrev) setCurrentIndex((prev) => prev - 1);
	};

	// Determine status for the current tool call to pass to the block
	const status =
		currentToolCall.status ??
		(currentToolCall.executionId ? "pending" : "completed");

	const canApprove =
		status === "pending" &&
		!!currentToolCall.executionId &&
		!!onApproveToolCall &&
		!!onRejectToolCall;

	return (
		<div className="rounded-md border bg-card my-1 overflow-hidden shadow-sm w-full">
			{/* Header / Navigation Bar */}
			<div className="flex items-center justify-between bg-muted/30 px-2 py-1.5 border-b">
				<div className="flex items-center gap-2">
					<Layers className="h-3.5 w-3.5 text-muted-foreground" />
					<span className="text-xs font-medium text-muted-foreground">
						{t("ai.toolCall.calls")} ({currentIndex + 1}/{toolCalls.length})
					</span>
				</div>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6"
						onClick={handlePrev}
						disabled={!hasPrev}
						title={t("common.previous")}
					>
						<ChevronLeft className="h-3.5 w-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6"
						onClick={handleNext}
						disabled={!hasNext}
						title={t("common.next")}
					>
						<ChevronRight className="h-3.5 w-3.5" />
					</Button>
				</div>
			</div>

			{/* Content Area - Reusing ToolCallBlock but removing its outer margins/border if needed, 
                but since ToolCallBlock has its own style, we will wrap it lightly */}
			<div className="px-1">
				<ToolCallBlock
					key={currentToolCall.id}
					toolCall={currentToolCall}
					status={status}
					result={currentToolCall.result}
					executionId={currentToolCall.executionId}
					onApprove={
						canApprove
							? () => onApproveToolCall?.(currentToolCall.id)
							: undefined
					}
					onReject={
						canApprove
							? () => onRejectToolCall?.(currentToolCall.id)
							: undefined
					}
					className="my-0 border-none shadow-none bg-transparent"
				/>
			</div>
		</div>
	);
}

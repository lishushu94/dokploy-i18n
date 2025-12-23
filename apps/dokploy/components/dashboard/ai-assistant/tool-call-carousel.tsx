"use client";

import { Layers } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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
			<div className="border-b px-2 py-1 bg-muted/30">
				<Select
					value={currentIndex.toString()}
					onValueChange={(val) => setCurrentIndex(Number.parseInt(val))}
				>
					<SelectTrigger className="h-7 text-xs border-none shadow-none bg-transparent px-0 hover:bg-muted/50 w-full justify-between focus:ring-0">
						<div className="flex items-center gap-2 truncate">
							<Layers className="h-3 w-3 text-muted-foreground shrink-0" />
							<SelectValue />
						</div>
					</SelectTrigger>
					<SelectContent position="popper" className="w-[300px] max-w-[90vw]">
						{toolCalls.map((tc, index) => (
							<SelectItem key={tc.id} value={index.toString()} className="text-xs">
								<span className="font-medium text-muted-foreground mr-2">
									{index + 1}.
								</span>
								{tc.function.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Content Area */}
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
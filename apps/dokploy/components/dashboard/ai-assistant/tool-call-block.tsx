"use client";

import {
	AlertCircle,
	AppWindow,
	Archive,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Database,
	FileKey,
	FolderKanban,
	GitBranch,
	Globe,
	Layers,
	ListChecks,
	Loader2,
	Server,
	ShieldAlert,
	Wrench,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ToolCall } from "./use-chat";

interface ToolCallBlockProps {
	toolCall: ToolCall;
	status?:
		| "pending"
		| "approved"
		| "rejected"
		| "executing"
		| "completed"
		| "failed";
	result?: {
		success: boolean;
		message?: string;
		data?: unknown;
		error?: string;
	};
	executionId?: string;
	onApprove?: () => void;
	onReject?: () => void;
	className?: string;
}

const toolIcons: Record<string, typeof Wrench> = {
	postgres: Database,
	mysql: Database,
	mariadb: Database,
	mongo: Database,
	redis: Database,
	application: AppWindow,
	server: Server,
	compose: Layers,
	domain: Globe,
	backup: Archive,
	deployment: ListChecks,
	github: GitBranch,
	traefik: Globe,
	destination: Archive,
	mount: Server,
	certificate: FileKey,
	project: FolderKanban,
	environment: GitBranch,
};

function getToolIcon(toolName: string) {
	const normalized = String(toolName ?? "")
		.trim()
		.toLowerCase();
	if (normalized.startsWith("volume_backup_")) {
		return toolIcons.backup ?? Wrench;
	}
	const category = normalized.split(/[._]/)[0] ?? normalized;
	return toolIcons[category] ?? Wrench;
}

function getRiskColor(toolName: string) {
	if (
		toolName.includes("delete") ||
		toolName.includes("remove") ||
		toolName.includes("restore")
	) {
		return "border-destructive bg-destructive/5";
	}
	if (
		toolName.includes("deploy") ||
		toolName.includes("create") ||
		toolName.includes("restart")
	) {
		return "border-amber-500/50 bg-amber-500/5";
	}
	return "border-border bg-card";
}

export function ToolCallBlock({
	toolCall,
	status = "pending",
	result,
	onApprove,
	onReject,
	className,
}: ToolCallBlockProps) {
	const { t } = useTranslation("common");
	const [expanded, setExpanded] = useState(false);
	const [showApprovalDialog, setShowApprovalDialog] = useState(false);

	const Icon = getToolIcon(toolCall.function.name);
	const riskColor = getRiskColor(toolCall.function.name);

	const parsedArgs = (() => {
		try {
			return JSON.parse(toolCall.function.arguments);
		} catch {
			return toolCall.function.arguments;
		}
	})();

	const statusConfig = {
		pending: {
			icon: ShieldAlert,
			color: "text-amber-500",
			label: t("ai.toolCall.pendingApproval"),
		},
		approved: {
			icon: CheckCircle2,
			color: "text-emerald-500",
			label: t("ai.toolCall.approved"),
		},
		rejected: {
			icon: AlertCircle,
			color: "text-destructive",
			label: t("ai.toolCall.rejected"),
		},
		executing: {
			icon: Loader2,
			color: "text-blue-500",
			label: t("ai.toolCall.executing"),
		},
		completed: {
			icon: CheckCircle2,
			color: "text-emerald-500",
			label: t("ai.toolCall.completed"),
		},
		failed: {
			icon: AlertCircle,
			color: "text-destructive",
			label: t("ai.toolCall.failed"),
		},
	};

	const StatusIcon = statusConfig[status].icon;
	const isDestructive =
		toolCall.function.name.includes("delete") ||
		toolCall.function.name.includes("remove") ||
		toolCall.function.name.includes("restore");

	return (
		<>
			<div
				className={cn(
					"rounded border p-2 my-1 text-xs transition-colors shadow-sm",
					riskColor,
					className,
				)}
			>
				<div
					className="flex items-center justify-between cursor-pointer select-none group"
					onClick={() => setExpanded(!expanded)}
				>
					<div className="flex items-center gap-2">
						<div className="p-1 rounded bg-background border shadow-sm">
							<Icon className="h-3 w-3 text-foreground" />
						</div>
						<div className="flex items-center gap-2">
							<span className="font-semibold text-foreground text-[11px]">
								{toolCall.function.name}
							</span>
							<span
								className={cn(
									"flex items-center gap-1 font-medium text-[10px]",
									statusConfig[status].color,
								)}
							>
								<StatusIcon
									className={cn(
										"h-2.5 w-2.5",
										status === "executing" && "animate-spin",
									)}
								/>
								{statusConfig[status].label}
							</span>
						</div>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="h-5 w-5 p-0 hover:bg-transparent opacity-50 group-hover:opacity-100 transition-opacity"
					>
						{expanded ? (
							<ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
						) : (
							<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
						)}
					</Button>
				</div>

				{expanded && (
					<div className="mt-2 space-y-2 pt-2 border-t border-border/50">
						<div className="space-y-1">
							<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
								Arguments
							</span>
							<div className="rounded bg-muted/50 p-2 font-mono text-[10px] border border-border/50 max-h-[300px] overflow-y-auto">
								<pre className="whitespace-pre-wrap break-words">
									{JSON.stringify(parsedArgs, null, 2)}
								</pre>
							</div>
						</div>

						{result && (
							<div className="space-y-1">
								<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
									Result
								</span>
								<div
									className={cn(
										"rounded p-2 border text-[10px] max-h-[300px] overflow-y-auto",
										result.success
											? "bg-emerald-500/5 border-emerald-500/20 text-emerald-900 dark:text-emerald-200"
											: "bg-destructive/5 border-destructive/20 text-destructive-foreground",
									)}
								>
									{result.message && (
										<p className="font-medium mb-1 break-words">
											{result.message}
										</p>
									)}
									{result.data != null && (
										<pre className="font-mono opacity-90 whitespace-pre-wrap break-words">
											{JSON.stringify(result.data, null, 2)}
										</pre>
									)}
									{result.error && (
										<p className="font-medium text-destructive break-words">
											{result.error}
										</p>
									)}
								</div>
							</div>
						)}
					</div>
				)}

				{status === "pending" && onApprove && onReject && (
					<div className="mt-2 pt-2 border-t border-border/50 flex gap-2">
						<Button
							size="sm"
							className="h-6 px-2 text-[10px] flex-1"
							variant={isDestructive ? "destructive" : "default"}
							onClick={(e) => {
								e.stopPropagation();
								setShowApprovalDialog(true);
							}}
						>
							{t("ai.toolCall.reviewApprove")}
						</Button>
						<Button
							size="sm"
							variant="outline"
							className="h-6 px-2 text-[10px] flex-1 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50"
							onClick={(e) => {
								e.stopPropagation();
								onReject();
							}}
						>
							{t("ai.toolCall.reject")}
						</Button>
					</div>
				)}
			</div>

			<Dialog open={showApprovalDialog} onOpenChange={setShowApprovalDialog}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							{isDestructive && (
								<AlertCircle className="h-5 w-5 text-destructive" />
							)}
							{t("ai.toolCall.confirmAction")}
						</DialogTitle>
						<DialogDescription>
							{t("ai.toolCall.aiRequestExecute")}{" "}
							<strong>{toolCall.function.name}</strong>
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						<div className="rounded-lg border p-3">
							<h4 className="text-sm font-medium mb-2">
								{t("ai.toolCall.parameters")}
							</h4>
							<pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto">
								{JSON.stringify(parsedArgs, null, 2)}
							</pre>
						</div>
						{isDestructive && (
							<div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
								{t("ai.toolCall.cannotUndo")}
							</div>
						)}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setShowApprovalDialog(false);
								onReject?.();
							}}
						>
							{t("common.cancel")}
						</Button>
						<Button
							variant={isDestructive ? "destructive" : "default"}
							onClick={() => {
								setShowApprovalDialog(false);
								onApprove?.();
							}}
						>
							{t("common.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

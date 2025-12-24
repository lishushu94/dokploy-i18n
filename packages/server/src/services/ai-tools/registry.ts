import { getCategory, type ToolCategory } from "./categories";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./types";

export interface ToolWithCategory extends Tool {
	categoryInfo?: ToolCategory;
}

class ToolRegistry {
	private tools: Map<string, Tool> = new Map();

	register<TParams, TResult>(tool: Tool<TParams, TResult>): void {
		this.tools.set(tool.name, tool as Tool);
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	getAll(): Tool[] {
		return Array.from(this.tools.values());
	}

	getAllWithCategories(): ToolWithCategory[] {
		return this.getAll().map((tool) => ({
			...tool,
			categoryInfo: getCategory(tool.category),
		}));
	}

	getByCategory(category: string): Tool[] {
		return this.getAll().filter((tool) => tool.category === category);
	}

	getByCategoryWithInfo(category: string): ToolWithCategory[] {
		const categoryInfo = getCategory(category);
		return this.getByCategory(category).map((tool) => ({
			...tool,
			categoryInfo,
		}));
	}

	async execute(
		name: string,
		params: unknown,
		ctx: ToolContext,
	): Promise<ToolResult> {
		const tool = this.get(name);
		if (!tool) {
			return {
				success: false,
				message: `Tool "${name}" not found`,
				error: `Unknown tool: ${name}`,
			};
		}

		const validation = tool.parameters.safeParse(params);
		if (!validation.success) {
			return {
				success: false,
				message: "Invalid parameters",
				error: validation.error.message,
			};
		}

		return tool.execute(validation.data, ctx);
	}

	requiresApproval(name: string): boolean {
		const tool = this.get(name);
		return tool?.requiresApproval ?? true;
	}

	getRiskLevel(name: string): string {
		const tool = this.get(name);
		return tool?.riskLevel ?? "high";
	}
}

export const toolRegistry = new ToolRegistry();

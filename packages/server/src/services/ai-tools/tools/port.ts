import {
	apiCreatePort,
	apiFindOnePort,
	apiUpdatePort,
} from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import {
	createPort,
	finPortById,
	removePortById,
	updatePortById,
} from "@dokploy/server/services/port";
import { findMemberById } from "@dokploy/server/services/user";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

type PortSummary = {
	portId: string;
	applicationId: string;
	publishedPort: number;
	publishMode: "ingress" | "host";
	targetPort: number;
	protocol: "tcp" | "udp";
};

type PortDetails = PortSummary & {
	applicationName: string;
};

const toPortSummary = (p: {
	portId: string;
	applicationId: string;
	publishedPort: number;
	publishMode: "ingress" | "host";
	targetPort: number;
	protocol: "tcp" | "udp";
}): PortSummary => ({
	portId: p.portId,
	applicationId: p.applicationId,
	publishedPort: p.publishedPort,
	publishMode: p.publishMode,
	targetPort: p.targetPort,
	protocol: p.protocol,
});

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const portAccessDenied = <T>(message: string, data: T): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const portList: Tool<{ applicationId: string }, PortSummary[]> = {
	name: "port_list",
	description: "List ports for an application.",
	category: "application",
	parameters: z.object({
		applicationId: z.string().min(1).describe("Application ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const app = await findApplicationById(params.applicationId);
		if (app.environment?.project?.organizationId !== ctx.organizationId) {
			return portAccessDenied("Application access denied", []);
		}

		return {
			success: true,
			message: `Found ${app.ports.length} port(s)`,
			data: app.ports.map((p) =>
				toPortSummary({
					portId: p.portId,
					applicationId: p.applicationId,
					publishedPort: p.publishedPort,
					publishMode: p.publishMode,
					targetPort: p.targetPort,
					protocol: p.protocol,
				}),
			),
		};
	},
};

const portGet: Tool<{ portId: string }, PortDetails> = {
	name: "port_get",
	description: "Get a port by ID.",
	category: "application",
	parameters: apiFindOnePort,
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const port = await finPortById(params.portId);
		if (
			port.application.environment.project.organizationId !== ctx.organizationId
		) {
			return portAccessDenied("Port access denied", {
				portId: params.portId,
				applicationId: "",
				publishedPort: 0,
				publishMode: "host",
				targetPort: 0,
				protocol: "tcp",
				applicationName: "",
			});
		}
		return {
			success: true,
			message: "Port retrieved",
			data: {
				...toPortSummary({
					portId: port.portId,
					applicationId: port.applicationId,
					publishedPort: port.publishedPort,
					publishMode: port.publishMode,
					targetPort: port.targetPort,
					protocol: port.protocol,
				}),
				applicationName: port.application.name,
			},
		};
	},
};

const portCreate: Tool<
	z.infer<typeof apiCreatePort> & { confirm: "CONFIRM_PORT_CHANGE" },
	PortSummary
> = {
	name: "port_create",
	description:
		"Create a port mapping for an application (requires approval + confirm).",
	category: "application",
	parameters: apiCreatePort.extend({
		confirm: z.literal("CONFIRM_PORT_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const app = await findApplicationById(params.applicationId);
		if (app.environment?.project?.organizationId !== ctx.organizationId) {
			return portAccessDenied("Application access denied", {
				portId: "",
				applicationId: params.applicationId,
				publishedPort: params.publishedPort,
				publishMode: params.publishMode,
				targetPort: params.targetPort,
				protocol: params.protocol,
			});
		}

		const created = await createPort({
			applicationId: params.applicationId,
			publishedPort: params.publishedPort,
			publishMode: params.publishMode,
			targetPort: params.targetPort,
			protocol: params.protocol,
		});

		return {
			success: true,
			message: "Port created",
			data: toPortSummary({
				portId: created.portId,
				applicationId: created.applicationId,
				publishedPort: created.publishedPort,
				publishMode: created.publishMode,
				targetPort: created.targetPort,
				protocol: created.protocol,
			}),
		};
	},
};

const portUpdate: Tool<
	z.infer<typeof apiUpdatePort> & { confirm: "CONFIRM_PORT_CHANGE" },
	PortSummary
> = {
	name: "port_update",
	description: "Update a port mapping (requires approval + confirm).",
	category: "application",
	parameters: apiUpdatePort.extend({
		confirm: z.literal("CONFIRM_PORT_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const port = await finPortById(params.portId);
		if (
			port.application.environment.project.organizationId !== ctx.organizationId
		) {
			return portAccessDenied("Port access denied", {
				portId: params.portId,
				applicationId: port.applicationId,
				publishedPort: port.publishedPort,
				publishMode: port.publishMode,
				targetPort: port.targetPort,
				protocol: port.protocol,
			});
		}

		const updated = await updatePortById(params.portId, {
			publishedPort: params.publishedPort,
			publishMode: params.publishMode,
			targetPort: params.targetPort,
			protocol: params.protocol,
		});
		if (!updated) {
			throw new Error("Port update failed");
		}

		return {
			success: true,
			message: "Port updated",
			data: toPortSummary({
				portId: updated.portId,
				applicationId: updated.applicationId,
				publishedPort: updated.publishedPort,
				publishMode: updated.publishMode,
				targetPort: updated.targetPort,
				protocol: updated.protocol,
			}),
		};
	},
};

const portRemove: Tool<
	{ portId: string; confirm: "CONFIRM_PORT_REMOVE" },
	{ removed: boolean; portId: string }
> = {
	name: "port_remove",
	description: "Remove a port mapping (requires approval + confirm).",
	category: "application",
	parameters: z.object({
		portId: z.string().min(1),
		confirm: z.literal("CONFIRM_PORT_REMOVE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const port = await finPortById(params.portId);
		if (
			port.application.environment.project.organizationId !== ctx.organizationId
		) {
			return portAccessDenied("Port access denied", {
				removed: false,
				portId: params.portId,
			});
		}

		await removePortById(params.portId);
		return {
			success: true,
			message: "Port removed",
			data: { removed: true, portId: params.portId },
		};
	},
};

export function registerPortTools() {
	toolRegistry.register(portList);
	toolRegistry.register(portGet);
	toolRegistry.register(portCreate);
	toolRegistry.register(portUpdate);
	toolRegistry.register(portRemove);
}

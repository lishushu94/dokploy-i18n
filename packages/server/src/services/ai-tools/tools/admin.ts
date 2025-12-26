import { IS_CLOUD } from "@dokploy/server/constants";
import { apiUpdateWebServerMonitoring } from "@dokploy/server/db/schema";
import { findMemberById, updateUser } from "@dokploy/server/services/user";
import { setupWebMonitoring } from "@dokploy/server/setup/monitoring-setup";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const adminSetupMonitoringParams = apiUpdateWebServerMonitoring.extend({
	confirm: z.literal("SETUP_MONITORING"),
});

const adminSetupMonitoring: Tool<
	z.infer<typeof adminSetupMonitoringParams>,
	{ started: boolean }
> = {
	name: "admin_setup_monitoring",
	description:
		"Configure and start Dokploy monitoring (self-hosted only). Requires owner approval and confirm=SETUP_MONITORING.",
	category: "server",
	parameters: adminSetupMonitoringParams,
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		try {
			if (IS_CLOUD) {
				return {
					success: false,
					message: "Feature disabled on cloud",
					error: "UNAUTHORIZED",
					data: { started: false },
				};
			}

			const member = await findMemberById(ctx.userId, ctx.organizationId);
			if (member.role !== "owner") {
				return {
					success: false,
					message: "Only organization owner can setup monitoring",
					error: "UNAUTHORIZED",
					data: { started: false },
				};
			}

			await updateUser(member.userId, {
				metricsConfig: {
					server: {
						type: "Dokploy",
						refreshRate: params.metricsConfig.server.refreshRate,
						port: params.metricsConfig.server.port,
						token: params.metricsConfig.server.token,
						cronJob: params.metricsConfig.server.cronJob,
						urlCallback: params.metricsConfig.server.urlCallback,
						retentionDays: params.metricsConfig.server.retentionDays,
						thresholds: {
							cpu: params.metricsConfig.server.thresholds.cpu,
							memory: params.metricsConfig.server.thresholds.memory,
						},
					},
					containers: {
						refreshRate: params.metricsConfig.containers.refreshRate,
						services: {
							include: params.metricsConfig.containers.services.include || [],
							exclude: params.metricsConfig.containers.services.exclude || [],
						},
					},
				},
			});

			await setupWebMonitoring(member.userId);

			return {
				success: true,
				message: "Monitoring setup triggered",
				data: { started: true },
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to setup monitoring",
				error: msg,
				data: { started: false },
			};
		}
	},
};

export function registerAdminTools() {
	toolRegistry.register(adminSetupMonitoring);
}

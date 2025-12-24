import { X509Certificate } from "node:crypto";
import { db } from "@dokploy/server/db";
import { certificates as certificatesTable } from "@dokploy/server/db/schema";
import {
	createCertificate,
	removeCertificateById,
} from "@dokploy/server/services/certificate";
import { findServerById } from "@dokploy/server/services/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const getFirstPemCertificate = (input: string) => {
	const match = input.match(
		/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
	);
	return match?.[0] ?? input;
};

const listCertificates: Tool<
	{ organizationId?: string },
	Array<{
		certificateId: string;
		name: string;
		autoRenew: boolean;
	}>
> = {
	name: "certificate_list",
	description: "List all certificates",
	category: "certificate",
	parameters: z.object({
		organizationId: z.string().optional().describe("Filter by Organization ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		if (params.organizationId && params.organizationId !== ctx.organizationId) {
			return { success: false, message: "Organization access denied" };
		}

		const results = await db.query.certificates.findMany({
			where: eq(certificatesTable.organizationId, ctx.organizationId),
		});

		return {
			success: true,
			message: `Found ${results.length} certificate(s)`,
			data: results.map((c) => ({
				certificateId: c.certificateId,
				name: c.name,
				autoRenew: c.autoRenew || false,
			})),
		};
	},
};

const createCertificateTool: Tool<
	{
		name: string;
		certificateData: string;
		privateKey: string;
		organizationId: string;
		serverId?: string;
		autoRenew?: boolean;
	},
	{ certificateId: string; name: string }
> = {
	name: "certificate_create",
	description: "Upload/Create a new certificate",
	category: "certificate",
	parameters: z.object({
		name: z.string().describe("Certificate name"),
		certificateData: z.string().describe("Certificate content (CRT)"),
		privateKey: z.string().describe("Private key content (KEY)"),
		organizationId: z.string().describe("Organization ID"),
		serverId: z.string().optional().describe("Server ID"),
		autoRenew: z.boolean().optional().default(false),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		if (params.organizationId !== ctx.organizationId) {
			return { success: false, message: "Organization access denied" };
		}

		if (params.serverId) {
			const server = await findServerById(params.serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		const cert = await createCertificate(
			{
				name: params.name,
				certificateData: params.certificateData,
				privateKey: params.privateKey,
				organizationId: params.organizationId,
				serverId: params.serverId,
				autoRenew: params.autoRenew ?? false,
			},
			ctx.organizationId,
		);

		return {
			success: true,
			message: "Certificate created successfully",
			data: {
				certificateId: cert.certificateId,
				name: cert.name,
			},
		};
	},
};

const certificateStatus: Tool<
	{ certificateId: string },
	{
		certificateId: string;
		name: string;
		autoRenew: boolean;
		serverId?: string | null;
		issuer?: string;
		serialNumber?: string;
		validFrom?: string;
		validTo?: string;
		expiresInDays?: number;
		status: "valid" | "expired" | "unknown";
		parseError?: string;
	}
> = {
	name: "certificate_status",
	description:
		"Get a redacted validity summary for a certificate stored in Dokploy (no private key returned)",
	category: "certificate",
	parameters: z.object({
		certificateId: z.string().min(1).describe("The Certificate ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const cert = await db.query.certificates.findFirst({
			where: eq(certificatesTable.certificateId, params.certificateId),
		});

		if (!cert) {
			return { success: false, message: "Certificate not found" };
		}

		if (cert.organizationId !== ctx.organizationId) {
			return { success: false, message: "Organization access denied" };
		}

		if (cert.serverId) {
			const server = await findServerById(cert.serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		try {
			const firstPem = getFirstPemCertificate(cert.certificateData);
			const x509 = new X509Certificate(firstPem);
			const now = Date.now();
			const validToMs = Date.parse(x509.validTo);
			const expiresInDays = Number.isFinite(validToMs)
				? Math.ceil((validToMs - now) / (1000 * 60 * 60 * 24))
				: undefined;

			return {
				success: true,
				message: "Certificate status",
				data: {
					certificateId: cert.certificateId,
					name: cert.name,
					autoRenew: cert.autoRenew || false,
					serverId: cert.serverId ?? null,
					issuer: x509.issuer,
					serialNumber: x509.serialNumber,
					validFrom: x509.validFrom,
					validTo: x509.validTo,
					expiresInDays,
					status:
						expiresInDays === undefined
							? "unknown"
							: expiresInDays >= 0
								? "valid"
								: "expired",
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				success: true,
				message: "Certificate status (parse failed)",
				data: {
					certificateId: cert.certificateId,
					name: cert.name,
					autoRenew: cert.autoRenew || false,
					serverId: cert.serverId ?? null,
					status: "unknown",
					parseError: msg,
				},
			};
		}
	},
};

const deleteCertificate: Tool<{ certificateId: string }, { deleted: boolean }> =
	{
		name: "certificate_delete",
		description: "Delete a certificate",
		category: "certificate",
		parameters: z.object({
			certificateId: z.string().describe("The Certificate ID"),
		}),
		riskLevel: "high",
		requiresApproval: true,
		execute: async (params, ctx) => {
			const cert = await db.query.certificates.findFirst({
				where: eq(certificatesTable.certificateId, params.certificateId),
			});
			if (!cert) {
				return { success: false, message: "Certificate not found" };
			}
			if (cert.organizationId !== ctx.organizationId) {
				return { success: false, message: "Organization access denied" };
			}
			if (cert.serverId) {
				const server = await findServerById(cert.serverId);
				if (server.organizationId !== ctx.organizationId) {
					return { success: false, message: "Server access denied" };
				}
			}

			await removeCertificateById(params.certificateId);
			return {
				success: true,
				message: "Certificate deleted",
				data: { deleted: true },
			};
		},
	};

export function registerCertificateTools() {
	toolRegistry.register(listCertificates);
	toolRegistry.register(createCertificateTool);
	toolRegistry.register(certificateStatus);
	toolRegistry.register(deleteCertificate);
}

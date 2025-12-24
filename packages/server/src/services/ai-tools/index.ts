export * from "./categories";
export * from "./registry";
export * from "./types";

import { registerApplicationTools } from "./tools/application";
import { registerBackupTools } from "./tools/backup";
import { registerCertificateTools } from "./tools/certificate";
import { registerComposeTools } from "./tools/compose";
import { registerDeploymentTools } from "./tools/deployment";
import { registerDestinationTools } from "./tools/destination";
import { registerDomainTools } from "./tools/domain";
import { registerEnvVarTools } from "./tools/env-vars";
import { registerEnvironmentTools } from "./tools/environment";
import { registerGithubTools } from "./tools/github";
import { registerMariadbTools } from "./tools/mariadb";
import { registerMongoTools } from "./tools/mongo";
import { registerMountTools } from "./tools/mount";
import { registerMysqlTools } from "./tools/mysql";
import { registerOrganizationTools } from "./tools/organization";
import { registerPostgresTools } from "./tools/postgres";
import { registerProjectTools } from "./tools/project";
import { registerRedisTools } from "./tools/redis";
import { registerServerTools } from "./tools/server";
import { registerTraefikTools } from "./tools/traefik";

let toolsInitialized = false;

export function initializeTools() {
	if (toolsInitialized) return;

	registerProjectTools();
	registerEnvironmentTools();
	registerPostgresTools();
	registerMysqlTools();
	registerMariadbTools();
	registerMongoTools();
	registerRedisTools();
	registerApplicationTools();
	registerServerTools();
	registerOrganizationTools();
	registerMountTools();
	registerEnvVarTools();
	registerComposeTools();
	registerDeploymentTools();
	registerDestinationTools();
	registerGithubTools();
	registerDomainTools();
	registerBackupTools();
	registerCertificateTools();
	registerTraefikTools();

	toolsInitialized = true;
}

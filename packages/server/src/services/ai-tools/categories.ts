export interface ToolCategory {
	id: string;
	name: string;
	icon: string;
	description: string;
	displayOrder: number;
}

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
	project: {
		id: "project",
		name: "Project Management",
		icon: "folder",
		description: "Create, list, and manage projects",
		displayOrder: 1,
	},
	environment: {
		id: "environment",
		name: "Environment",
		icon: "layers",
		description: "Manage project environments",
		displayOrder: 2,
	},
	application: {
		id: "application",
		name: "Applications",
		icon: "app-window",
		description: "Deploy and manage applications",
		displayOrder: 3,
	},
	compose: {
		id: "compose",
		name: "Docker Compose",
		icon: "container",
		description: "Manage Docker Compose services",
		displayOrder: 4,
	},
	database: {
		id: "database",
		name: "Databases",
		icon: "database",
		description: "Manage database services",
		displayOrder: 5,
	},
	postgres: {
		id: "postgres",
		name: "PostgreSQL",
		icon: "database",
		description: "PostgreSQL database operations",
		displayOrder: 6,
	},
	mysql: {
		id: "mysql",
		name: "MySQL",
		icon: "database",
		description: "MySQL database operations",
		displayOrder: 7,
	},
	mariadb: {
		id: "mariadb",
		name: "MariaDB",
		icon: "database",
		description: "MariaDB database operations",
		displayOrder: 8,
	},
	mongo: {
		id: "mongo",
		name: "MongoDB",
		icon: "database",
		description: "MongoDB database operations",
		displayOrder: 9,
	},
	redis: {
		id: "redis",
		name: "Redis",
		icon: "database",
		description: "Redis cache operations",
		displayOrder: 10,
	},
	server: {
		id: "server",
		name: "Servers",
		icon: "server",
		description: "Server management and monitoring",
		displayOrder: 11,
	},
	domain: {
		id: "domain",
		name: "Domains",
		icon: "globe",
		description: "Domain and DNS management",
		displayOrder: 12,
	},
	certificate: {
		id: "certificate",
		name: "Certificates",
		icon: "shield-check",
		description: "SSL/TLS certificate management",
		displayOrder: 13,
	},
	backup: {
		id: "backup",
		name: "Backups",
		icon: "archive",
		description: "Backup and restore operations",
		displayOrder: 14,
	},
	github: {
		id: "github",
		name: "GitHub",
		icon: "github",
		description: "GitHub providers, repositories, branches and PR automation",
		displayOrder: 15,
	},
	deployment: {
		id: "deployment",
		name: "Deployments",
		icon: "list-checks",
		description: "Deployment history and logs",
		displayOrder: 16,
	},
	settings: {
		id: "settings",
		name: "Settings",
		icon: "settings",
		description: "Dokploy settings and maintenance operations",
		displayOrder: 17,
	},
	user: {
		id: "user",
		name: "Users",
		icon: "user",
		description: "User and membership management",
		displayOrder: 18,
	},
	stripe: {
		id: "stripe",
		name: "Billing",
		icon: "credit-card",
		description: "Stripe billing and subscriptions",
		displayOrder: 19,
	},
};

export function getCategory(categoryId: string): ToolCategory | undefined {
	return TOOL_CATEGORIES[categoryId];
}

export function getAllCategories(): ToolCategory[] {
	return Object.values(TOOL_CATEGORIES).sort(
		(a, b) => a.displayOrder - b.displayOrder,
	);
}

export function getCategoryIds(): string[] {
	return Object.keys(TOOL_CATEGORIES);
}

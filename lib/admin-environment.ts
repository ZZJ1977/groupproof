export type AdminEnvironment = "develop" | "main";

export const ADMIN_ENVIRONMENT_COOKIE = "gp_admin_environment";

export function normalizeAdminEnvironment(value: string | undefined | null): AdminEnvironment {
  return value === "main" ? "main" : "develop";
}

export function adminApiBase(environment: AdminEnvironment): string {
  const configured = environment === "main" ? process.env.ADMIN_API_MAIN_URL : process.env.ADMIN_API_DEVELOP_URL;
  return (configured || process.env.API_INTERNAL_URL || "http://localhost:8000").replace(/\/$/, "");
}

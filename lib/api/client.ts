import createClient from "openapi-fetch";
import type { paths } from "@/packages/domain/api.generated";
import { apiConfig } from "@/lib/api/config";

export function createApiClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  return createClient<paths>({
    baseUrl: options.baseUrl ?? apiConfig.baseUrl,
    credentials: "include",
    fetch: options.fetch,
  });
}

export const apiClient = createApiClient();

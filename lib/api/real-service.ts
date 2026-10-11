import { apiClient } from "@/lib/api/client";
import type { components } from "@/packages/domain/api.generated";
import type { Evidence, MockData, Project, Task, Verification } from "@/types/domain";

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

function requireResponse<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined) return result.data;
  const detail = typeof result.error === "object" && result.error !== null && "detail" in result.error
    ? String(result.error.detail)
    : `API request failed with status ${result.response.status}`;
  throw new ApiRequestError(detail, result.response.status);
}

export async function getWorkspace(): Promise<MockData> {
  throw new ApiRequestError("Workspace API is not available in the current backend contract.", 501);
}

export async function saveWorkspace(_data: MockData): Promise<void> {
  throw new ApiRequestError("Workspace API is not available in the current backend contract.", 501);
}

export async function getProject(projectId: string): Promise<Project | undefined> {
  const result = await apiClient.GET("/api/examples/projects/{project_id}", {
    params: { path: { project_id: projectId } },
  });
  if (result.response.status === 404) return undefined;
  const envelope = requireResponse(result) as components["schemas"]["SuccessResponse_ProjectExample_"];
  return envelope.data as unknown as Project;
}

export async function getHealth(): Promise<{ service: string; status: string }> {
  const result = await apiClient.GET("/healthz");
  return requireResponse(result) as { service: string; status: string };
}

export async function renameProject(projectId: string, name: string, expectedVersion: number): Promise<Project> {
  const result = await apiClient.PATCH("/api/examples/projects/{project_id}", {
    params: { path: { project_id: projectId } },
    body: { name, expected_version: expectedVersion },
  });
  const envelope = requireResponse(result) as components["schemas"]["SuccessResponse_ProjectExample_"];
  return envelope.data as unknown as Project;
}

export async function getTasks(_projectId: string): Promise<Task[]> {
  throw new ApiRequestError("Project task API is not available in the current backend contract.", 501);
}

export async function getEvidence(_projectId: string, _taskId?: string): Promise<Evidence[]> {
  throw new ApiRequestError("Evidence API is not available in the current backend contract.", 501);
}

export async function getVerification(_taskId: string): Promise<Verification[]> {
  throw new ApiRequestError("Verification API is not available in the current backend contract.", 501);
}

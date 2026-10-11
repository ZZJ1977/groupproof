import { apiMode, type ApiFeature } from "@/lib/api/config";
import * as realService from "@/lib/api/real-service";
import { mockService } from "@/lib/api/mock-service";
import type { Evidence, MockData, Project, Task, Verification } from "@/types/domain";

function select<T>(feature: ApiFeature, mock: () => Promise<T>, real: () => Promise<T>): Promise<T> {
  return apiMode(feature) === "real" ? real() : mock();
}

export const workspaceService = {
  getWorkspace(): Promise<MockData> {
    return select("workspace", mockService.getWorkspace, realService.getWorkspace);
  },

  saveWorkspace(data: MockData): Promise<void> {
    return apiMode("workspace") === "real" ? realService.saveWorkspace(data) : mockService.saveWorkspace(data);
  },

  getProject(projectId: string): Promise<Project | undefined> {
    return select("projects", () => mockService.getProject(projectId), () => realService.getProject(projectId));
  },

  renameProject(projectId: string, name: string, expectedVersion: number): Promise<Project> {
    if (apiMode("projects") === "real") return realService.renameProject(projectId, name, expectedVersion);
    return mockService.getProject(projectId).then((project) => {
      if (!project) throw new Error("Project not found");
      return { ...project, name, version: project.version + 1 };
    });
  },

  getTasks(projectId: string): Promise<Task[]> {
    return select("tasks", () => mockService.getTasks(projectId), () => realService.getTasks(projectId));
  },

  getEvidence(projectId: string, taskId?: string): Promise<Evidence[]> {
    return select("evidence", () => mockService.getEvidence(projectId, taskId), () => realService.getEvidence(projectId, taskId));
  },

  getVerification(taskId: string): Promise<Verification[]> {
    return select("verification", () => mockService.getVerification(taskId), () => realService.getVerification(taskId));
  },
};

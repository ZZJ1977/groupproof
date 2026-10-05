import { seedData } from "@/mocks/seed";
import type { Evidence, MockData, Task, Verification } from "@/types/domain";

const storageKey = "groupproof-v1-workspace";

function cloneSeed(): MockData {
  return structuredClone(seedData);
}

export const mockService = {
  async getWorkspace(): Promise<MockData> {
    if (typeof window === "undefined") return cloneSeed();
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return cloneSeed();
    try {
      return JSON.parse(saved) as MockData;
    } catch {
      return cloneSeed();
    }
  },

  async saveWorkspace(data: MockData): Promise<void> {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, JSON.stringify(data));
    }
  },

  async getProject(projectId: string): Promise<MockData["projects"][number] | undefined> {
    return (await this.getWorkspace()).projects.find((project) => project.id === projectId);
  },

  async getTasks(projectId: string): Promise<Task[]> {
    return (await this.getWorkspace()).tasks.filter((task) => task.projectId === projectId);
  },

  async getEvidence(projectId: string, taskId?: string): Promise<Evidence[]> {
    return (await this.getWorkspace()).evidence.filter((item) => item.projectId === projectId && (!taskId || item.taskId === taskId));
  },

  async getVerification(taskId: string): Promise<Verification[]> {
    return (await this.getWorkspace()).verifications.filter((item) => item.taskId === taskId);
  },
};

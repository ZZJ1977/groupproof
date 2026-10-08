import { seedData } from "@/mocks/seed";
import { migrateWorkspace } from "@/lib/versioning";
import type { Evidence, MockData, Task, Verification } from "@/types/domain";

const storageKey = "groupproof-v1-workspace";
const backupKey = "groupproof-v1-workspace-legacy-backup";

function cloneSeed(): MockData {
  return structuredClone(seedData);
}

export const mockService = {
  async getWorkspace(): Promise<MockData> {
    if (typeof window === "undefined") return cloneSeed();
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return cloneSeed();
    let raw: unknown;
    try {
      raw = JSON.parse(saved);
    } catch {
      console.error("工作区数据不是合法 JSON，已保留原始记录，本次会话使用演示种子。");
      return cloneSeed();
    }
    const { data, migrated, error } = migrateWorkspace(raw);
    if (error) {
      // 迁移失败保留原始浏览器数据并报告格式错误，不自动覆盖为演示种子
      console.error(`工作区数据格式错误：${error}。原始记录已保留。`);
      if (typeof window !== "undefined" && !window.localStorage.getItem(backupKey)) {
        window.localStorage.setItem(backupKey, saved);
      }
      return cloneSeed();
    }
    if (migrated) {
      if (!window.localStorage.getItem(backupKey)) window.localStorage.setItem(backupKey, saved);
      window.localStorage.setItem(storageKey, JSON.stringify(data));
    }
    return data;
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

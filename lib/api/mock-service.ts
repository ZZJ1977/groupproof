import { migrateWorkspace } from "@/lib/versioning";
import { emptyWorkspace } from "@/lib/empty-workspace";
import { apiMode } from "@/lib/api/config";
import { mockWorkspaceBackupKey as backupKey, mockWorkspaceStorageKey as storageKey, workspaceScope } from "@/lib/api/mock-storage";
import type { Evidence, MockData, Task, Verification } from "@/types/domain";

export { setWorkspaceScope } from "@/lib/api/mock-storage";

/**
 * 业务数据适配边界（P2 未完成项）：
 * 当前业务读写仍是浏览器本地演示适配器，仅在服务端确认 active 会话后挂载；
 * 存储键按 userId 隔离，退出/切换账号必须清理，防止跨账号缓存串数据。
 * 接入真实业务 API 时整体替换本适配器，页面调用约定保持不变。
 */
async function cloneSeed(): Promise<MockData> {
  // The fixture belongs to the explicitly enabled demo; real workspaces never load this module.
  const { seedData } = await import("@/mocks/seed");
  return structuredClone(seedData);
}

export const mockService = {
  async getWorkspace(): Promise<MockData> {
    if (apiMode("workspace") !== "mock") return emptyWorkspace(workspaceScope());
    if (typeof window === "undefined") return cloneSeed();
    const saved = window.localStorage.getItem(storageKey());
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
      window.localStorage.setItem(storageKey(), JSON.stringify(data));
    }
    return data;
  },

  async saveWorkspace(data: MockData): Promise<void> {
    if (apiMode("workspace") !== "mock") throw new Error("真实工作区不能保存浏览器演示数据。");
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey(), JSON.stringify(data));
    }
  },

  clearWorkspace() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(storageKey());
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

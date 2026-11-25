const workspacePrefix = "groupproof-v1-workspace:";
export const mockWorkspaceBackupKey = "groupproof-v1-workspace-legacy-backup";

let scopeUserId = "anonymous";

export function setWorkspaceScope(userId: string) {
  scopeUserId = userId || "anonymous";
}

export function workspaceScope() {
  return scopeUserId;
}

export function mockWorkspaceStorageKey() {
  return `${workspacePrefix}${scopeUserId}`;
}

type WorkspaceStorage = Pick<Storage, "length" | "key" | "removeItem">;

/** Remove only the retired browser demo store; account and preference storage are unrelated. */
export function clearMockWorkspaceStorage(storage?: WorkspaceStorage): number {
  try {
    const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    if (!target) return 0;
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key && (key === "groupproof-v1-workspace" || key === mockWorkspaceBackupKey || key.startsWith(workspacePrefix))) {
        keys.push(key);
      }
    }
    for (const key of keys) target.removeItem(key);
    return keys.length;
  } catch (error) {
    // Restricted browser storage must not prevent the authenticated API workspace from opening.
    console.warn("无法清理旧演示缓存；真实工作区不会读取这些记录。", error);
    return 0;
  }
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clearMockWorkspaceStorage, mockWorkspaceStorageKey, setWorkspaceScope } from "../shared/legacy-mock/api/mock-storage";

class MemoryStorage implements Storage {
  private entries = new Map<string, string>();
  reads = 0;
  writes = 0;
  constructor(values: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(values)) this.entries.set(key, value);
  }
  get length() { return this.entries.size; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) { this.reads += 1; return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes += 1; this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
  clear() { this.entries.clear(); }
}

const mode = process.argv[2];
if (mode === "real" || mode === "mock") {
  const storage = new MemoryStorage({ "groupproof-v1-workspace:real-user": '{"courses":[{"name":"stale demo"}]}' });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  setWorkspaceScope(mode === "real" ? "real-user" : "demo-user");
  const { mockService } = await import("../shared/legacy-mock/api/mock-service");
  const workspace = await mockService.getWorkspace();
  if (mode === "real") {
    assert.equal(workspace.currentUserId, "real-user");
    for (const value of Object.values(workspace)) if (Array.isArray(value)) assert.equal(value.length, 0);
    assert.equal(await mockService.getProject("project-1"), undefined);
    assert.deepEqual(await mockService.getTasks("project-1"), []);
    await assert.rejects(mockService.saveWorkspace(workspace), /真实工作区不能保存/);
    assert.equal(storage.reads, 0, "Real mode must not read stale browser demo data");
    assert.equal(storage.writes, 0, "Real mode must not persist demo mutations");
  } else {
    assert.ok(workspace.projects.some((project) => project.id === "project-1"));
    await mockService.saveWorkspace(workspace);
    assert.ok(storage.getItem(mockWorkspaceStorageKey()));
    assert.deepEqual((await mockService.getWorkspace()).projects, workspace.projects);
    mockService.clearWorkspace();
    assert.equal(storage.getItem(mockWorkspaceStorageKey()), null);
  }
  console.log(`${mode} workspace isolation passed`);
} else {
  const storage = new MemoryStorage({
    "groupproof-v1-workspace": "legacy",
    "groupproof-v1-workspace:current-user": "demo",
    "groupproof-v1-workspace:old-user": "demo",
    "groupproof-v1-workspace-legacy-backup": "backup",
    "groupproof-v1-workspace-custom": "unrelated",
    "auth-session": "real account",
    "preferredLocale": "zh-Hans",
  });
  assert.equal(clearMockWorkspaceStorage(storage), 4);
  assert.equal(clearMockWorkspaceStorage(storage), 0);
  assert.equal(storage.getItem("auth-session"), "real account");
  assert.equal(storage.getItem("preferredLocale"), "zh-Hans");
  assert.equal(storage.getItem("groupproof-v1-workspace-custom"), "unrelated");
  assert.equal(storage.length, 3);
  for (const childMode of ["real", "mock"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), childMode], {
      encoding: "utf8",
      env: { ...process.env, NEXT_PUBLIC_APP_ENV: "test", NEXT_PUBLIC_APP_MODE: childMode,
        NEXT_PUBLIC_ENABLE_MOCKS: String(childMode === "mock"), NEXT_PUBLIC_API_FEATURES: "" },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    process.stdout.write(child.stdout);
  }
  console.log("Legacy demo cache cleanup preserves account and preference storage");
}

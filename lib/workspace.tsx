"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { mockService, setWorkspaceScope } from "@/lib/api/mock-service";
import { seedData } from "@/mocks/seed";
import type { CollectionEntity, CollectionKey, MockData, Role } from "@/types/domain";

type SessionUser = { id: string; name: string | null; preferredLocale: string };

type WorkspaceContextValue = {
  data: MockData;
  role: Role;
  loading: boolean;
  /** 当前会话用户：缓存键与本地存储按用户隔离 */
  userId: string;
  /** 仅隔离演示模式（NEXT_PUBLIC_APP_MODE=mock）可用；生产无角色切换入口 */
  setRole: (role: Role) => void;
  demoMode: boolean;
  update: <K extends CollectionKey>(collection: K, id: string, patch: Partial<CollectionEntity<K>>) => void;
  add: <K extends CollectionKey>(collection: K, entity: CollectionEntity<K>) => void;
  remove: <K extends CollectionKey>(collection: K, id: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
/** 工作区缓存键（按用户隔离；命令层等消费方必须使用同一键） */
export const scopedWorkspaceKey = (userId: string) => ["workspace", userId] as const;

const demoMode = process.env.NEXT_PUBLIC_APP_MODE === "mock";

function WorkspaceState({ user, children }: { user: SessionUser; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState(false);
  // 查询键与本地存储均按用户隔离，防止退出后旧请求写入新用户缓存（A21）
  setWorkspaceScope(user.id);
  const scopedKey = scopedWorkspaceKey(user.id);
  const { data = seedData } = useQuery({
    queryKey: scopedKey,
    queryFn: mockService.getWorkspace,
    initialData: seedData,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    let active = true;
    void mockService
      .getWorkspace()
      .then((stored) => {
        if (!active) return;
        queryClient.setQueryData(scopedKey, stored);
        setLoaded(true);
      })
      .catch((error) => {
        // 加载失败可恢复：回落演示种子并结束加载，不永久卡在占位（不静默吞错）
        console.error("工作区数据加载失败，已回退默认数据：", error);
        if (!active) return;
        queryClient.setQueryData(scopedKey, seedData);
        setLoaded(true);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, user.id]);

  const commit = useCallback((change: (current: MockData) => MockData) => {
    const current = queryClient.getQueryData<MockData>(scopedKey) ?? seedData;
    const next = change(current);
    queryClient.setQueryData(scopedKey, next);
    void mockService.saveWorkspace(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, user.id]);

  const setRole = useCallback((role: Role) => {
    if (!demoMode) return; // 生产不存在角色切换/提权入口
    const userByRole: Record<Role, string> = {
      student: "member-21",
      leader: "member-1",
      teacher: "teacher-1",
      ta: "ta-1",
      admin: "admin-1",
    };
    commit((current) => ({ ...current, currentRole: role, currentUserId: userByRole[role] }));
  }, [commit]);

  const update = useCallback(<K extends CollectionKey>(collection: K, id: string, patch: Partial<CollectionEntity<K>>) => {
    commit((current) => {
      const records = current[collection] as { id: string; version?: number }[];
      const nextRecords = records.map((record) => record.id === id ? {
        ...record,
        ...patch,
        version: "version" in record && !("version" in patch) ? (record.version ?? 0) + 1 : (patch as { version?: number }).version ?? record.version,
      } : record);
      const next = { ...current, [collection]: nextRecords } as MockData;
      const taskChanged = collection === "tasks" && Object.keys(patch).some((key) => ["title", "description", "criterionIds", "requirementIds", "moduleId", "responsibleIds"].includes(key));
      if (collection === "evidence" || collection === "criteria" || taskChanged) {
        const changed = nextRecords.find((record) => record.id === id) as { taskId?: string } | undefined;
        const taskId = collection === "tasks" ? id : changed?.taskId;
        if (taskId) next.verifications = next.verifications.map((item) => item.taskId === taskId ? { ...item, status: "outdated" } : item);
      }
      return next;
    });
  }, [commit]);

  const add = useCallback(<K extends CollectionKey>(collection: K, entity: CollectionEntity<K>) => {
    commit((current) => {
      const records = current[collection] as { id: string }[];
      if (records.some((record) => record.id === (entity as { id: string }).id)) return current;
      const next = { ...current, [collection]: [...records, entity] } as MockData;
      if (collection === "evidence") {
        const taskId = (entity as { taskId?: string }).taskId;
        next.verifications = next.verifications.map((item) => item.taskId === taskId ? { ...item, status: "outdated" } : item);
      }
      return next;
    });
  }, [commit]);

  const remove = useCallback(<K extends CollectionKey>(collection: K, id: string) => {
    commit((current) => {
      const records = current[collection] as { id: string; status?: string }[];
      if (collection === "evidence" && records.some((record) => record.id === id && record.status === "formal")) return current;
      return { ...current, [collection]: records.filter((record) => record.id !== id) } as MockData;
    });
  }, [commit]);

  return (
    <WorkspaceContext.Provider value={{ data, role: data.currentRole, loading: !loaded, userId: user.id, setRole, demoMode, update, add, remove }}>
      {loaded ? children : <div className="flex min-h-screen items-center justify-center text-[13px] text-[#75849a]">…</div>}
    </WorkspaceContext.Provider>
  );
}

/** 仅 active 会话进入业务区后挂载；i18n/Query 公共 Provider 在 AppProviders，登录页不加载工作区。 */
export function WorkspaceProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  // 每个账号独立 QueryClient：退出/切换账号时旧缓存不泄漏
  const [clients] = useState(() => new Map<string, QueryClient>());
  const queryClient = clients.get(user.id) ?? (() => {
    const created = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    clients.set(user.id, created);
    return created;
  })();
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceState user={user}>{children}</WorkspaceState>
    </QueryClientProvider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return context;
}

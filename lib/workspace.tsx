"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { mockService } from "@/lib/api/mock-service";
import { seedData } from "@/mocks/seed";
import type { CollectionEntity, CollectionKey, MockData, Role } from "@/types/domain";

type WorkspaceContextValue = {
  data: MockData;
  role: Role;
  loading: boolean;
  setRole: (role: Role) => void;
  update: <K extends CollectionKey>(collection: K, id: string, patch: Partial<CollectionEntity<K>>) => void;
  add: <K extends CollectionKey>(collection: K, entity: CollectionEntity<K>) => void;
  remove: <K extends CollectionKey>(collection: K, id: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const queryKey = ["workspace"] as const;

function WorkspaceState({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState(false);
  const { data = seedData } = useQuery({
    queryKey,
    queryFn: mockService.getWorkspace,
    initialData: seedData,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    let active = true;
    void mockService.getWorkspace().then((stored) => {
      if (!active) return;
      queryClient.setQueryData(queryKey, stored);
      setLoaded(true);
    });
    return () => { active = false; };
  }, [queryClient]);

  const commit = useCallback((change: (current: MockData) => MockData) => {
    const current = queryClient.getQueryData<MockData>(queryKey) ?? seedData;
    const next = change(current);
    queryClient.setQueryData(queryKey, next);
    void mockService.saveWorkspace(next);
  }, [queryClient]);

  const setRole = useCallback((role: Role) => {
    const userByRole: Record<Role, string> = {
      student: "member-21",
      leader: "member-1",
      teacher: "teacher-1",
      ta: "teacher-1",
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
    <WorkspaceContext.Provider value={{ data, role: data.currentRole, loading: !loaded, setRole, update, add, remove }}>
      {loaded ? children : <div className="flex min-h-screen items-center justify-center text-[13px] text-[#75849a]">正在加载工作区...</div>}
    </WorkspaceContext.Provider>
  );
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 0 } } }));
  return (
    <NextIntlClientProvider locale="zh" timeZone="Asia/Macau" messages={{ app: { name: "GroupProof", home: "首页", login: "登录" } }}>
      <QueryClientProvider client={queryClient}>
        <WorkspaceState>{children}</WorkspaceState>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return context;
}

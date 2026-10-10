"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { authClient, type MeDTO } from "@/lib/api/auth-client";

/**
 * 注册进度的唯一状态来源（侧栏、四个页面、登入按钮共用），按用户隔离缓存。
 * 窗口重新获得焦点时强制重读：教师审核、换绑等变化及时同步，刷新/跨页/切换账号不串状态。
 */
export function meQueryKey(userId: string | undefined) {
  return ["me", userId ?? "unknown"] as const;
}

export function useMe(userId: string | undefined) {
  const query = useQuery<MeDTO>({
    queryKey: meQueryKey(userId),
    queryFn: authClient.me,
    staleTime: 30_000,
  });
  const { refetch } = query;
  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);
  return query;
}

/** 验收临时密令是否可用（仅非 real；用于验证码框直通，不改变真实验证流程） */
export function useAcceptanceTest(): boolean {
  const { data } = useQuery({ queryKey: ["capabilities"], queryFn: authClient.capabilities, staleTime: 60_000 });
  return data?.acceptanceTest?.enabled ?? false;
}

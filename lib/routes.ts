export interface ResolvedRoute {
  screen: number;
  projectId?: string;
  taskId?: string;
  milestoneId?: string;
  memberId?: string;
  courseId?: string;
  groupId?: string;
}

const staticRoutes: Record<string, number> = {
  "/": 1,
  "/login": 1,
  "/onboarding/profile": 2,
  "/onboarding/email-verification": 3,
  "/home": 4,
  "/notifications": 5,
  "/action-items": 6,
  "/activity": 30,
  "/courses": 31,
  "/courses/join": 32,
  "/admin/users": 51,
  "/admin/teacher-verifications": 52,
  "/admin/courses": 53,
  "/admin/logs": 54,
  "/admin/ai-usage": 55,
  "/admin/access-requests": 56,
};

export function resolveRoute(pathname: string, view?: string | null): ResolvedRoute | null {
  const normalized = pathname.replace(/\/$/, "") || "/";
  if (staticRoutes[normalized]) return { screen: staticRoutes[normalized] };
  const parts = normalized.split("/").filter(Boolean);

  if (parts[0] === "projects" && parts[1]) {
    const projectId = parts[1];
    if (parts.length === 2) return { screen: 7, projectId };
    const section = parts[2];
    if (section === "setup") return { screen: 8, projectId };
    if (section === "requirements") return { screen: 9, projectId };
    if (section === "planning") return { screen: 10, projectId };
    if (section === "tasks") {
      if (parts.length === 3) return { screen: view === "board" ? 12 : view === "list" ? 13 : 11, projectId };
      const taskId = parts[3];
      if (parts.length === 4) return { screen: 14, projectId, taskId };
      if (parts[4] === "submit") return { screen: 15, projectId, taskId };
      if (parts[4] === "evidence-check") return { screen: 16, projectId, taskId };
      if (parts[4] === "verification") return { screen: 17, projectId, taskId };
    }
    if (section === "milestones") return parts[3] ? { screen: 19, projectId, milestoneId: parts[3] } : { screen: 18, projectId };
    if (section === "evidence") return { screen: 20, projectId };
    if (section === "github") return { screen: 21, projectId };
    if (section === "collaboration") return { screen: 22, projectId };
    if (section === "files") return { screen: 23, projectId };
    if (section === "discussions") return { screen: 24, projectId };
    if (section === "contribution") return parts[3] ? { screen: 26, projectId, memberId: parts[3] } : { screen: 25, projectId };
    if (section === "reports") return { screen: parts[3] === "export" ? 28 : 27, projectId };
    if (section === "settings") return { screen: 29, projectId };
  }

  if (parts[0] === "courses" && parts[1]) {
    const courseId = parts[1];
    if (parts[2] === "groups") {
      const groupId = parts[3];
      if (!groupId) return { screen: 33, courseId };
      if (parts[4] === "change-leader") return { screen: 36, courseId, groupId };
      if (parts[4] === "leave") return { screen: 37, courseId, groupId };
      return { screen: 34, courseId, groupId };
    }
    if (parts[2] === "projects" && parts[3] === "new") return { screen: 35, courseId };
    if (parts[2] === "projects" && parts[3] === "reopen") return { screen: 39, courseId };
    if (parts[2] === "rule-changes") return { screen: 38, courseId };
    if (parts[2] === "rules") return { screen: 40, courseId };
  }

  if (parts[0] === "teacher" && parts[1] === "courses" && parts[2]) {
    const courseId = parts[2];
    if (parts.length === 3) return { screen: 41, courseId };
    if (parts[3] === "groups") return parts[4] ? { screen: 43, courseId, groupId: parts[4] } : { screen: 42, courseId };
    if (parts[3] === "actions") return { screen: 44, courseId };
    if (parts[3] === "reports") return { screen: 45, courseId };
    if (parts[3] === "settings") return { screen: 46, courseId };
    if (parts[3] === "rules") return { screen: 47, courseId };
    if (parts[3] === "member-changes") return { screen: 48, courseId };
    if (parts[3] === "appeals") return { screen: 49, courseId };
    if (parts[3] === "files") return { screen: 50, courseId };
  }

  return null;
}

/** 个人中心与旧 onboarding 别名（新系统页，不冒充原 56 个设计页） */
export const accountScreens: Record<string, number> = {
  "/account": 100,
  "/account/profile": 101,
  "/account/email": 102,
  "/account/status": 103,
  "/account/security": 104,
};

export const onboardingAliases: Record<string, string> = {
  "/onboarding/profile": "/account/profile",
  "/onboarding/email-verification": "/account/email",
};

export type RouteCategory = "public" | "account" | "alias" | "business" | "unknown";

export interface ClassifiedRoute {
  category: RouteCategory;
  screen?: number;
  route?: ResolvedRoute;
  /** 旧链接兼容目标（别名需经相同门禁） */
  aliasOf?: string;
}

/** 页面级路由分类：公开 / 个人中心 / 旧别名 / 业务区 / 未知（默认拒绝业务访问） */
export function classifyPath(pathname: string, view?: string | null): ClassifiedRoute {
  const normalized = pathname.replace(/\/$/, "") || "/";
  if (normalized === "/" || normalized === "/login") return { category: "public", screen: 1 };
  if (normalized === "/reset-password") return { category: "public", screen: 99 };
  if (onboardingAliases[normalized]) return { category: "alias", screen: 2, aliasOf: onboardingAliases[normalized] };
  if (accountScreens[normalized] !== undefined) return { category: "account", screen: accountScreens[normalized] };
  const route = resolveRoute(normalized, view);
  if (route && route.screen >= 4) return { category: "business", screen: route.screen, route };
  return { category: "unknown" };
}

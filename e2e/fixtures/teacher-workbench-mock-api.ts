import { createHash, randomUUID } from "node:crypto";
import type { Page, Request, Route } from "@playwright/test";
import {
  type ActionDef,
  type ActorIdentity,
  type AnnouncementRecord,
  type CourseMaterialRecord,
  type CourseRecord,
  type CourseRulesData,
  type GroupRecord,
  type MockActor,
  type ProjectRecord,
  type StaffPermissions,
  type TeacherActionRecord,
  type TeacherWorkbenchStore,
  TW_STUDENT_2_ID,
  createTeacherWorkbenchStore,
  fullStaffPermissions,
} from "./teacher-workbench-store";

export * from "./teacher-workbench-store";

export interface ErrorOverrideRule {
  method?: string;
  path: string | RegExp;
  status: number;
  code: string;
  message?: string;
  details?: Record<string, unknown> | null;
}

export interface InstallTeacherWorkbenchMocksOptions {
  actor?: MockActor;
  taPermissions?: Partial<StaffPermissions>;
  latencyMs?: number;
  errorOverrides?: ErrorOverrideRule[] | Record<string, Omit<ErrorOverrideRule, "path">>;
}

interface HttpResult {
  status: number;
  body?: unknown;
  rawBody?: string | Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

const VALID_ACTORS = new Set<MockActor>(["teacher", "ta", "student", "outsider", "anonymous"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deterministicUuid(tag: string): string {
  const hex = createHash("sha256").update(tag).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function deterministicSha256(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function toIsoDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

function resolveLoginActor(identifier: string, store: TeacherWorkbenchStore): ActorIdentity | null {
  const norm = identifier.trim().toLowerCase();
  if (!norm) return null;
  if (norm === "teacher" || norm === "tw_teacher" || norm === "teacher@must.edu.mo") {
    return store.actors.teacher;
  }
  if (norm === "ta" || norm === "tw_ta" || norm === "ta@must.edu.mo") {
    return store.actors.ta;
  }
  if (norm === "student" || norm === "student1" || norm === "tw_student1" || norm === "student1@student.must.edu.mo") {
    return store.actors.student;
  }
  if (norm === "student2" || norm === "tw_student2" || norm === "student2@student.must.edu.mo") {
    return {
      actor: "student",
      authenticated: true,
      id: TW_STUDENT_2_ID,
      name: "赵同学",
      username: "tw_student2",
      email: "student2@student.must.edu.mo",
      studentId: "20260002",
      college: "计算机科学与工程学院",
      requestedIdentity: "student",
      roles: ["student"],
      preferredLocale: "zh-Hans",
      csrfToken: "tw-csrf-student2",
      nextActionHref: "/home",
    };
  }
  if (norm === "outsider" || norm === "tw_outsider" || norm === "outsider@student.must.edu.mo") {
    return store.actors.outsider;
  }
  return null;
}

function toFileDetailDto(
  project: ProjectRecord,
  lf: ProjectRecord["logicalFiles"][number],
  fallbackUploaderId: string,
) {
  const uploaderId = lf.uploaded_by ?? fallbackUploaderId;
  const ext = lf.filename.includes(".") ? lf.filename.split(".").pop()!.toLowerCase() : "";
  const normCategory =
    lf.category === "documents" || lf.category === "images" || lf.category === "exports"
      ? lf.category
      : "documents";
  const normStatus = lf.status === "published" ? "current" : lf.status;
  const verId = deterministicUuid(`file-ver:${lf.id}:${lf.version}`);
  const decId = deterministicUuid(`file-dec:${lf.id}:${lf.version}`);
  return {
    id: lf.id,
    project_id: project.id,
    name: lf.filename,
    category: normCategory,
    created_by: uploaderId,
    created_at: lf.created_at,
    updated_at: lf.created_at,
    latest_version_no: lf.version,
    official_version_no: normStatus === "current" ? lf.version : null,
    lock_version: 1,
    versions: [
      {
        id: verId,
        file_id: lf.id,
        version_no: lf.version,
        original_name: lf.filename,
        extension: ext,
        content_hash: lf.content_hash ?? deterministicSha256(lf.id),
        mime_type: lf.mime_type ?? "application/pdf",
        size_bytes: lf.size_bytes ?? 24576,
        status: normStatus,
        uploaded_by: uploaderId,
        created_at: lf.created_at,
      },
    ],
    decisions: [
      {
        id: decId,
        version_id: verId,
        actor_id: uploaderId,
        action: "created" as const,
        reason: lf.reason ?? "初始上传",
        resulting_lock_version: 1,
        previous_official_version_no: null,
        created_at: lf.created_at,
      },
    ],
  };
}

function reqId(): string {
  return randomUUID();
}

function ok(data: unknown, status = 200): HttpResult {
  return { status, body: { data, meta: { request_id: reqId() } } };
}

function err(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> | null = null,
): HttpResult {
  return { status, body: { error: { code, message, details }, meta: { request_id: reqId() } } };
}

function parseJsonBody(request: Request): Record<string, unknown> {
  const raw = request.postData();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

async function resolveActor(
  page: Page,
  request: Request,
  store: TeacherWorkbenchStore,
  fallback: MockActor,
): Promise<ActorIdentity> {
  const cookies = parseCookieHeader(request.headers()["cookie"]);
  let rawActor: string | undefined = cookies.gp_tw_actor;
  if (!rawActor) {
    const ctxCookies = await page.context().cookies("http://127.0.0.1:13009").catch(() => []);
    rawActor = ctxCookies.find((c) => c.name === "gp_tw_actor")?.value;
  }
  const actorKey: MockActor =
    rawActor && VALID_ACTORS.has(rawActor as MockActor) ? (rawActor as MockActor) : fallback;
  return store.actors[actorKey];
}

function findMatchingOverride(
  method: string,
  pathname: string,
  overrides: InstallTeacherWorkbenchMocksOptions["errorOverrides"],
): ErrorOverrideRule | null {
  if (!overrides) return null;
  if (Array.isArray(overrides)) {
    for (const rule of overrides) {
      if (rule.method && rule.method.toUpperCase() !== method) continue;
      if (typeof rule.path === "string" ? pathname === rule.path : rule.path.test(pathname)) {
        return rule;
      }
    }
    return null;
  }
  for (const [key, rule] of Object.entries(overrides)) {
    const parts = key.split(" ");
    const keyMethod = parts.length === 2 ? parts[0].toUpperCase() : undefined;
    const keyPath = parts.length === 2 ? parts[1] : key;
    if (keyMethod && keyMethod !== method) continue;
    if (pathname === keyPath) return { ...rule, path: keyPath, method: keyMethod };
  }
  return null;
}

function getEffectivePermissions(
  course: CourseRecord,
  actor: ActorIdentity,
  taOverride?: Partial<StaffPermissions>,
): { role: "teacher" | "ta"; is_owner: boolean; can_manage: boolean; permissions: StaffPermissions } | null {
  if (actor.actor === "teacher" || course.owner_id === actor.id) {
    return { role: "teacher", is_owner: true, can_manage: true, permissions: fullStaffPermissions() };
  }
  const staff = course.staff.find((s) => s.user_id === actor.id);
  if (staff) {
    const permissions =
      actor.actor === "ta" && taOverride ? { ...staff.permissions, ...taOverride } : { ...staff.permissions };
    return { role: staff.role, is_owner: staff.is_owner, can_manage: true, permissions };
  }
  if (actor.actor === "ta") {
    const baseTa = course.staff.find((s) => s.role === "ta")?.permissions ?? fullStaffPermissions();
    return {
      role: "ta",
      is_owner: false,
      can_manage: true,
      permissions: taOverride ? { ...baseTa, ...taOverride } : { ...baseTa },
    };
  }
  return null;
}

function computeProjectMetrics(project: ProjectRecord | undefined) {
  if (!project) {
    return {
      progress_percent: null as number | null,
      completed_tasks: 0,
      total_tasks: 0,
      milestones_completed: 0,
      milestones_total: 0,
      overdue_milestones: 0,
    };
  }
  const total_tasks = project.tasks.length;
  const completed_tasks = project.tasks.filter((t) => t.status === "done").length;
  const milestones_total = project.milestones.length;
  const milestones_completed = project.milestones.filter((m) => m.status === "completed").length;
  const overdue_milestones = project.milestones.filter((m) => m.overdue).length;
  const totalWeight = project.tasks.reduce((acc, t) => acc + t.weight, 0);
  const progress_percent =
    totalWeight > 0
      ? Math.round(project.tasks.reduce((acc, t) => acc + (t.progress_percent * t.weight) / totalWeight, 0))
      : total_tasks > 0
        ? Math.round(project.tasks.reduce((acc, t) => acc + t.progress_percent, 0) / total_tasks)
        : 0;
  return { progress_percent, completed_tasks, total_tasks, milestones_completed, milestones_total, overdue_milestones };
}

function toClassSummary(course: CourseRecord) {
  const activeRoster = course.roster.filter((s) => s.status !== "left");
  const ungrouped = activeRoster.filter((s) => s.status === "ungrouped").length;
  const pendingJoin = course.joinRequests.filter((j) => j.status === "pending").length;
  return {
    id: course.id,
    code: course.code,
    name: course.name,
    semester: course.semester,
    college: course.college,
    status: course.status,
    student_count: activeRoster.length,
    group_count: course.groups.length,
    ungrouped_count: ungrouped,
    pending_join_count: pendingJoin,
    href: `/teacher/courses/${course.id}`,
  };
}

function toClassDetail(course: CourseRecord, canManage: boolean) {
  return {
    ...toClassSummary(course),
    invite_code: course.invite_code,
    join_url: course.invite_code ? `http://127.0.0.1:13009/join?code=${encodeURIComponent(course.invite_code)}` : null,
    join_mode: course.join_mode,
    project_deadline: course.project_deadline,
    formation_deadline: course.formation_deadline,
    min_group_size: course.min_group_size,
    max_group_size: course.max_group_size,
    lock_version: course.lock_version,
    can_manage: canManage,
  };
}

function toClassSettings(course: CourseRecord, isOwner: boolean, canManage: boolean) {
  return {
    ...toClassDetail(course, canManage),
    description: course.description,
    archived_at: course.archived_at,
    can_delete: isOwner,
    is_owner: isOwner,
  };
}

function toMilestoneDto(project: ProjectRecord, ms: ProjectRecord["milestones"][number]) {
  return {
    id: ms.id,
    title: ms.title,
    description: ms.description ?? null,
    deadline: ms.deadline,
    status: ms.status,
    overdue: ms.overdue,
    progress_percent: ms.progress_percent,
    task_count: ms.task_count,
    completed_task_count: ms.completed_task_count,
    deliverables_done: ms.status === "completed" ? 1 : 0,
    deliverables_total: 1,
    risk: ms.overdue
      ? {
          level: project.risk_level ?? "medium",
          open_count: 1,
          items: [
            {
              id: deterministicUuid(`risk:${ms.id}`),
              title: `${ms.title} 存在逾期风险`,
              level: project.risk_level ?? "medium",
              status: "open",
              due_at: ms.deadline,
              owner: null,
              task: null,
            },
          ],
        }
      : null,
    lock_version: 1,
    href: `/projects/${project.id}/milestones/${ms.id}`,
  };
}

function toPlazaGroup(course: CourseRecord, group: GroupRecord, store: TeacherWorkbenchStore) {
  const project = group.project_id ? store.projects.get(group.project_id) : undefined;
  const metrics = computeProjectMetrics(project);
  const members = group.member_ids
    .map((uid) => course.roster.find((s) => s.id === uid))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => ({
      id: s.id,
      name: s.name,
      student_number: s.student_number,
      initial: s.initial,
      is_leader: group.leader_id === s.id,
    }));
  const nextMilestone = project?.milestones.find((m) => m.status !== "completed") ?? null;
  return {
    id: group.id,
    name: group.name,
    direction: group.direction,
    leader_id: group.leader_id,
    members,
    member_count: members.length,
    max_group_size: group.max_group_size,
    roster_frozen: group.roster_frozen,
    has_project: Boolean(project),
    project: project ? { id: project.id, name: project.name, href: `/projects/${project.id}` } : null,
    lock_version: group.lock_version,
    accepts_drop: !group.roster_frozen && members.length < group.max_group_size,
    locked_reason: group.locked_reason,
    members_locked: group.roster_frozen,
    progress: {
      state: !project ? "no_project" : metrics.milestones_total === 0 ? "no_milestones" : "tracking",
      milestones_total: metrics.milestones_total,
      milestones_completed: metrics.milestones_completed,
      overall_percent: metrics.progress_percent,
      next_milestone: nextMilestone && project
        ? {
            id: nextMilestone.id,
            title: nextMilestone.title,
            deadline: nextMilestone.deadline,
            href: `/projects/${project.id}/milestones/${nextMilestone.id}`,
          }
        : null,
      overdue_count: metrics.overdue_milestones,
      risk_level: project?.risk_level ?? null,
    },
    href: `/teacher/courses/${course.id}/groups/${group.id}`,
  };
}

function toMaterialItem(course: CourseRecord, mat: CourseMaterialRecord) {
  const latest = mat.versions[mat.versions.length - 1];
  return {
    id: mat.id,
    course_id: course.id,
    folder_id: mat.folder_id,
    name: mat.name,
    visibility: mat.visibility,
    status: mat.status,
    latest_version_no: latest?.version_no ?? 1,
    mime_type: latest?.mime_type ?? "application/octet-stream",
    size_bytes: latest?.size_bytes ?? 0,
    uploaded_by: mat.uploaded_by,
    uploader_name: mat.uploader_name,
    created_at: mat.created_at,
    updated_at: mat.updated_at,
    download_href: `/api/v1/teacher/classes/${course.id}/files/${mat.id}/download`,
  };
}

function toAnnouncementItem(course: CourseRecord, ann: AnnouncementRecord) {
  const totalStudents = course.roster.filter((s) => s.status !== "left").length;
  const readCount = Object.keys(ann.read_by).length;
  return {
    id: ann.id,
    course_id: course.id,
    course_name: course.name,
    title: ann.title,
    content: ann.content,
    priority: ann.priority,
    is_pinned: ann.is_pinned,
    status: ann.status,
    published_by: ann.published_by,
    publisher_name: ann.publisher_name,
    published_at: ann.published_at,
    created_at: ann.created_at,
    updated_at: ann.updated_at,
    read_count: readCount,
    total_students: totalStudents,
    unread_count: Math.max(0, totalStudents - readCount),
  };
}

function toSessionDto(actor: ActorIdentity) {
  if (!actor.authenticated) return { authenticated: false };
  return {
    authenticated: true,
    sessionScope: "full",
    authMethod: "password",
    user: { id: actor.id, name: actor.name, preferredLocale: actor.preferredLocale },
    accountState: "active",
    loginEmailVerified: true,
    identityConfirmed: true,
    securityComplete: true,
    requiredCompletedCount: 3,
    canEnterWorkspace: true,
    nextAction: { type: "workspace", href: actor.nextActionHref },
    csrfToken: actor.csrfToken,
  };
}

function toMeDto(actor: ActorIdentity) {
  return {
    user: {
      id: actor.id,
      name: actor.name,
      username: actor.username,
      studentId: actor.studentId,
      college: actor.college,
      githubUsername: `${actor.username}-gh`,
      feishuAccount: actor.name,
      requestedIdentity: actor.requestedIdentity,
      roles: [...actor.roles],
      preferredLocale: actor.preferredLocale,
      version: 1,
      googleEmailBound: false,
      googleEmail: null,
      passwordLoginEnabled: true,
    },
    schoolEmail: {
      verifiedEmail: actor.email,
      verifiedAt: "2026-10-01T00:00:00Z",
      pendingEmail: null,
      verified: true,
    },
    registration: {
      profileComplete: true,
      profileFieldErrors: {},
      schoolEmailVerified: true,
      identityConfirmed: true,
      securityComplete: true,
      requiredCompletedCount: 3,
      canEnterWorkspace: true,
      loginEmailVerified: true,
      teacherReviewStatus: actor.requestedIdentity === "teacher" ? "approved" : null,
      academicIdentityStatus: "verified",
      verificationBasis: [{ kind: "school_email", at: "2026-10-01T00:00:00Z", method: "mock" }],
      accountState: "active",
      nextAction: { type: "workspace", href: actor.nextActionHref },
    },
    teacherApplication:
      actor.requestedIdentity === "teacher"
        ? { id: "app-1", status: "approved", applicationVersion: 1, reviewedAt: "2026-10-01T00:00:00Z", reason: null }
        : null,
    studentIdRule: { pattern: "^[0-9]{8}$", emailPrefixRule: "student_id", confirmedBySchool: true },
  };
}

function ensureCourseStaff(
  course: CourseRecord | undefined,
  actor: ActorIdentity,
  taOverride?: Partial<StaffPermissions>,
  requiredPerm?: keyof StaffPermissions,
): { ok: true; course: CourseRecord; perms: NonNullable<ReturnType<typeof getEffectivePermissions>> } | { ok: false; res: HttpResult } {
  if (!course) return { ok: false, res: err(404, "COURSE_NOT_FOUND", "班级不存在") };
  const perms = getEffectivePermissions(course, actor, taOverride);
  if (!perms) return { ok: false, res: err(403, "COURSE_STAFF_REQUIRED", "需要教师或助教权限") };
  if (requiredPerm && !perms.permissions[requiredPerm]) {
    return { ok: false, res: err(403, "PERMISSION_DENIED", `缺少权限: ${requiredPerm}`) };
  }
  return { ok: true, course, perms };
}

function buildGroupRisks(course: CourseRecord, store: TeacherWorkbenchStore) {
  return course.groups
    .map((group) => {
      const project = group.project_id ? store.projects.get(group.project_id) : undefined;
      if (!project || (project.risk_level !== "high" && project.risk_level !== "medium")) return null;
      const metrics = computeProjectMetrics(project);
      return {
        group_id: group.id,
        group_name: group.name,
        project_id: project.id,
        project_name: project.name,
        risk_level: project.risk_level,
        overdue_milestones: metrics.overdue_milestones,
        progress_percent: metrics.progress_percent,
        open_risk_count: metrics.overdue_milestones,
        reasons: metrics.overdue_milestones > 0 ? ["存在逾期里程碑"] : ["任务进度偏慢"],
        risks: project.milestones
          .filter((m) => m.overdue)
          .map((m) => ({ id: m.id, title: `${m.title} 逾期`, level: project.risk_level ?? "medium", status: "open", due_at: m.deadline })),
      };
    })
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
}

function requiredActionPermission(type: TeacherActionRecord["type"]): keyof StaffPermissions | null {
  if (type === "join_request") return "approve_joins";
  if (type === "post_deadline_invite") return "manage_groups";
  if (type === "member_leave" || type === "member_remove" || type === "appeal") return "approve_changes";
  return null;
}

function applyActionDecision(
  course: CourseRecord,
  action: TeacherActionRecord,
  actionKey: string,
  reason: string | undefined,
  actor: ActorIdentity,
  perms: NonNullable<ReturnType<typeof getEffectivePermissions>>,
  store: TeacherWorkbenchStore,
): HttpResult {
  const def: ActionDef | undefined = action.available_actions.find((a) => a.key === actionKey);
  if (!def && actionKey !== "remind" && actionKey !== "mark_read") {
    return err(422, "INVALID_ACTION", "不支持的操作");
  }
  if (actionKey === "remind") return ok({ notified_count: 1 });
  const reqPerm = requiredActionPermission(action.type);
  if (reqPerm && !perms.permissions[reqPerm]) {
    return err(403, "FORBIDDEN", `缺少课程操作权限: ${reqPerm}`, { permission: reqPerm });
  }
  if (def?.requires_reason && (!reason || !reason.trim())) {
    return err(422, "REASON_REQUIRED", "该操作需要填写原因");
  }
  const now = new Date().toISOString();

  if (action.type === "join_request") {
    const jr = course.joinRequests.find((j) => j.id === action.source_id);
    if (!jr) return err(404, "ACTION_NOT_FOUND", "入班申请不存在");
    if (jr.status !== "pending") return err(409, "JOIN_REQUEST_DECIDED", "入班申请已处理");
    if (actionKey === "approve" && course.status !== "active") {
      return err(409, "COURSE_CLOSED", "课程已结束，不能批准新学生入班。");
    }
    jr.status = actionKey === "approve" ? "approved" : "rejected";
    jr.decided_by = actor.id;
    jr.decided_at = now;
    jr.decision_reason = reason ?? null;
    jr.lock_version += 1;
    if (jr.status === "approved" && !course.roster.some((s) => s.id === jr.student.id)) {
      course.roster.push({
        id: jr.student.id,
        name: jr.student.name,
        student_number: jr.student_number,
        email: jr.student_email,
        initial: (jr.student.name ?? "学").slice(0, 1),
        joined_at: now,
        status: "ungrouped",
        group_id: null,
        is_leader: false,
        in_project_group: false,
      });
    }
  } else if (action.type === "post_deadline_invite") {
    const inv = course.groupInvitations.find((i) => i.id === action.source_id);
    if (!inv) return err(404, "ACTION_NOT_FOUND", "组队邀请不存在");
    if (inv.status !== "awaiting_teacher") return err(409, "INVITATION_CLOSED", "邀请已关闭");
    if (actionKey === "approve" && course.status !== "active") {
      return err(409, "COURSE_CLOSED", "课程已结束。");
    }
    inv.status = actionKey === "approve" ? "approved" : "rejected";
    inv.decided_at = now;
    inv.decision_reason = reason ?? null;
    inv.lock_version += 1;
    if (inv.status === "approved" && inv.invitee) {
      const grp = course.groups.find((g) => g.id === inv.group_id);
      const stu = course.roster.find((s) => s.id === inv.invitee?.id);
      if (grp && stu && !grp.member_ids.includes(stu.id)) {
        grp.member_ids.push(stu.id);
        grp.lock_version += 1;
        stu.group_id = grp.id;
        stu.status = "grouped";
        stu.in_project_group = Boolean(grp.project_id);
      }
    }
  } else if (action.type === "member_leave" || action.type === "member_remove") {
    const mc = course.membershipChanges.find((m) => m.id === action.source_id);
    if (!mc) return err(404, "ACTION_NOT_FOUND", "成员变更不存在");
    mc.status = actionKey === "approve" ? "approved" : "rejected";
    mc.decided_by = { id: actor.id, name: actor.name };
    mc.decided_at = now;
    mc.teacher_comment = reason ?? null;
    mc.lock_version += 1;
    if (mc.status === "approved" && mc.member) {
      const grp = course.groups.find((g) => g.id === mc.group_id);
      const stu = course.roster.find((s) => s.id === mc.member?.id);
      if (grp) {
        grp.member_ids = grp.member_ids.filter((id) => id !== mc.member?.id);
        if (grp.leader_id === mc.member.id) grp.leader_id = grp.member_ids[0] ?? null;
        grp.lock_version += 1;
      }
      if (stu) {
        stu.group_id = null;
        stu.status = "ungrouped";
        stu.is_leader = false;
        stu.in_project_group = false;
      }
    }
  }

  action.status = "handled";
  action.handled_at = now;
  action.handled_by = actor.id;
  action.decision = actionKey;
  action.decision_reason = reason ?? null;
  void store;
  return ok(action);
}

async function handleApiRoute(
  method: string,
  url: URL,
  request: Request,
  actor: ActorIdentity,
  store: TeacherWorkbenchStore,
  options: InstallTeacherWorkbenchMocksOptions,
): Promise<HttpResult> {
  const path = url.pathname;
  const body = parseJsonBody(request);
  const now = new Date().toISOString();

  // Auth endpoints
  if (method === "GET" && path === "/api/v1/auth/session") return ok(toSessionDto(actor));
  if (method === "GET" && path === "/api/v1/me") {
    if (!actor.authenticated) return err(401, "UNAUTHENTICATED", "未登录");
    return ok(toMeDto(actor));
  }
  if (method === "POST" && path === "/api/v1/auth/password/login") {
    if (typeof body.identifier !== "string" || typeof body.password !== "string") {
      return err(422, "VALIDATION_ERROR", "Request validation failed.");
    }
    if (!body.password) {
      return err(401, "INVALID_CREDENTIALS", "The credentials are invalid.");
    }
    const matched = resolveLoginActor(body.identifier, store);
    if (!matched) {
      return err(401, "INVALID_CREDENTIALS", "The credentials are invalid.");
    }
    return ok(toSessionDto(matched));
  }
  if (method === "POST" && path === "/api/v1/auth/session/refresh") {
    return ok(toSessionDto(actor));
  }
  if (method === "POST" && path === "/api/v1/auth/logout") {
    return { status: 204 };
  }

  if (!actor.authenticated) return err(401, "UNAUTHENTICATED", "请先登录");

  // Teacher Dashboard
  if (method === "GET" && path === "/api/v1/teacher/dashboard") {
    if (actor.actor !== "teacher" && actor.actor !== "ta") {
      return err(403, "TEACHER_ROLE_REQUIRED", "仅教师或助教可访问工作台");
    }
    const courses = Array.from(store.courses.values());
    const allRisks = courses.flatMap((c) => buildGroupRisks(c, store));
    const allActions = courses.flatMap((c) => c.actions.filter((a) => a.status === "pending"));
    return ok({
      total_pending_actions: allActions.length,
      total_classes: courses.length,
      total_students: courses.reduce((acc, c) => acc + c.roster.filter((s) => s.status !== "left").length, 0),
      total_groups: courses.reduce((acc, c) => acc + c.groups.length, 0),
      total_projects: courses.reduce((acc, c) => acc + c.groups.filter((g) => Boolean(g.project_id)).length, 0),
      high_risk_groups: allRisks.filter((r) => r.risk_level === "high").length,
      medium_risk_groups: allRisks.filter((r) => r.risk_level === "medium").length,
      classes: courses.map((c) => {
        const risks = buildGroupRisks(c, store);
        const projectMetrics = c.groups
          .map((g) => (g.project_id ? computeProjectMetrics(store.projects.get(g.project_id)).progress_percent : null))
          .filter((v): v is number => v !== null);
        const overall =
          projectMetrics.length > 0
            ? Math.round(projectMetrics.reduce((a, b) => a + b, 0) / projectMetrics.length)
            : 0;
        return {
          course_id: c.id,
          name: c.name,
          semester: c.semester,
          status: c.status,
          student_count: c.roster.filter((s) => s.status !== "left").length,
          group_count: c.groups.length,
          project_count: c.groups.filter((g) => Boolean(g.project_id)).length,
          overall_progress: overall,
          pending_actions: c.actions.filter((a) => a.status === "pending").length,
          risk_count: risks.length,
          href: `/teacher/courses/${c.id}`,
        };
      }),
      recent_activity: [
        {
          id: "act-1",
          course_id: courses[0]?.id ?? "",
          course_name: courses[0]?.name ?? "",
          kind: "appeal",
          title: "赵同学提交了贡献度核对申诉",
          actor_name: "赵同学",
          occurred_at: now,
          href: courses[0] ? `/teacher/courses/${courses[0].id}/appeals` : "/teacher/dashboard",
        },
      ],
    });
  }
  if (method === "GET" && path === "/api/v1/teacher/dashboard/actions") {
    const items = Array.from(store.courses.values()).flatMap((c) =>
      c.actions.filter((a) => a.status === "pending"),
    );
    return ok({ total: items.length, items });
  }
  if (method === "GET" && path === "/api/v1/teacher/dashboard/risks") {
    const items = Array.from(store.courses.values()).flatMap((c) => buildGroupRisks(c, store));
    return ok({ total: items.length, items });
  }

  // Teacher Classes collection
  if (method === "GET" && path === "/api/v1/teacher/classes") {
    if (actor.actor !== "teacher" && actor.actor !== "ta") {
      return err(403, "TEACHER_ROLE_REQUIRED", "仅教师或助教可访问班级列表");
    }
    const tab = url.searchParams.get("tab") ?? "all";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const all = Array.from(store.courses.values());
    const searched = q
      ? all.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
      : all;
    const filtered = tab === "all" ? searched : searched.filter((c) => c.status === tab);
    return ok({
      items: filtered.map(toClassSummary),
      counts: {
        all: searched.length,
        active: searched.filter((c) => c.status === "active").length,
        ended: searched.filter((c) => c.status === "ended").length,
      },
    });
  }

  if (method === "POST" && path === "/api/v1/teacher/classes") {
    if (actor.actor !== "teacher" && actor.actor !== "ta") {
      return err(403, "TEACHER_ROLE_REQUIRED", "仅教师或助教可创建班级");
    }
    const name = String(body.name ?? "").trim();
    const semester = String(body.semester ?? "").trim();
    const college = String(body.college ?? "").trim();
    const code = String(body.code ?? `GP-${store.counter + 1}`).trim();
    if (!name || !semester || !college) return err(422, "VALIDATION_ERROR", "班级名称、学期和学院不能为空");
    const rawDeadline = typeof body.project_deadline === "string" ? body.project_deadline.trim() : "";
    const parsedDeadlineMs = rawDeadline ? Date.parse(rawDeadline) : Number.NaN;
    if (!rawDeadline || Number.isNaN(parsedDeadlineMs)) {
      return err(422, "VALIDATION_ERROR", "Request validation failed.", {
        fields: [{ field: "body.project_deadline", message: "Field required", type: "missing" }],
      });
    }
    const projectDeadlineIso = new Date(parsedDeadlineMs).toISOString();
    let formationDeadlineIso: string | null = null;
    if (body.formation_deadline !== undefined && body.formation_deadline !== null && String(body.formation_deadline).trim() !== "") {
      const fdMs = Date.parse(String(body.formation_deadline));
      if (Number.isNaN(fdMs)) {
        return err(422, "VALIDATION_ERROR", "组队截止时间格式无效");
      }
      if (fdMs > parsedDeadlineMs) {
        return err(422, "VALIDATION_ERROR", "组队截止时间不能晚于项目截止时间");
      }
      formationDeadlineIso = new Date(fdMs).toISOString();
    }
    const minSize = Number(body.min_group_size ?? 1);
    const maxSize = Number(body.max_group_size ?? 6);
    if (minSize < 1 || maxSize < 1 || minSize > maxSize) {
      return err(422, "VALIDATION_ERROR", "小组人数限制无效");
    }
    if (Array.from(store.courses.values()).some((c) => c.code.toLowerCase() === code.toLowerCase())) {
      return err(409, "COURSE_CODE_CONFLICT", "班级编码已存在", { field: "code" });
    }
    const id = store.nextUuid("10000000");
    const created: CourseRecord = {
      id,
      owner_id: actor.id,
      code,
      name,
      semester,
      college,
      description: null,
      status: "active",
      archived_at: null,
      invite_code: `TW-${code.slice(0, 6).toUpperCase()}`,
      join_mode: body.join_mode === "approval" ? "approval" : "direct",
      project_deadline: projectDeadlineIso,
      formation_deadline: formationDeadlineIso,
      min_group_size: minSize,
      max_group_size: maxSize,
      lock_version: 1,
      roster: [],
      groups: [],
      joinRequests: [],
      groupInvitations: [],
      membershipChanges: [],
      actions: [],
      appeals: [],
      publishedRuleVersion: null,
      draftRuleVersion: null,
      ruleVersions: [],
      folders: [],
      materials: [],
      announcements: [],
      staff: [
        {
          user_id: actor.id,
          name: actor.name,
          email: actor.email,
          role: "teacher",
          permissions: fullStaffPermissions(),
          joined_at: now,
          is_owner: true,
        },
      ],
    };
    store.courses.set(id, created);
    return ok(toClassDetail(created, true), 201);
  }

  // Teacher Class Detail, Settings, Lifecycle, Roster & Plaza
  let m = path.match(/^\/api\/v1\/teacher\/classes\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const courseId = decodeURIComponent(m[1]);
    const sub = m[2] ? `/${m[2]}` : "";
    const course = store.courses.get(courseId);

    if (sub === "" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      return guard.ok ? ok(toClassDetail(guard.course, guard.perms.can_manage)) : guard.res;
    }
    if (sub === "" && method === "DELETE") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      if (!guard.perms.is_owner) return err(403, "COURSE_OWNER_REQUIRED", "仅课程创建者可删除班级");
      store.courses.delete(courseId);
      return ok({ deleted: true, course_id: courseId });
    }
    if (sub === "/invite-code/rotate" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const expected = Number(body.expected_version);
      if (expected !== guard.course.lock_version) {
        return err(409, "VERSION_CONFLICT", "班级版本已变更", { current_version: guard.course.lock_version });
      }
      guard.course.lock_version += 1;
      guard.course.invite_code = `TW-${guard.course.lock_version}${String(store.counter).slice(-3)}`;
      return ok(toClassDetail(guard.course, guard.perms.can_manage));
    }
    if (sub === "/settings" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      return guard.ok
        ? ok(toClassSettings(guard.course, guard.perms.is_owner, guard.perms.can_manage))
        : guard.res;
    }
    if (sub === "/settings" && method === "PATCH") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      if (Number(body.expected_version) !== guard.course.lock_version) {
        return err(409, "VERSION_CONFLICT", "设置版本已变更", { current_version: guard.course.lock_version });
      }
      const c = guard.course;
      if (typeof body.name === "string" && body.name.trim()) c.name = body.name.trim();
      if (typeof body.semester === "string" && body.semester.trim()) c.semester = body.semester.trim();
      if (typeof body.college === "string" && body.college.trim()) c.college = body.college.trim();
      if (body.description !== undefined) c.description = body.description === null ? null : String(body.description);
      if (body.formation_deadline !== undefined) c.formation_deadline = body.formation_deadline ? String(body.formation_deadline) : null;
      if (body.project_deadline !== undefined) c.project_deadline = body.project_deadline ? String(body.project_deadline) : null;
      if (typeof body.min_group_size === "number") c.min_group_size = body.min_group_size;
      if (typeof body.max_group_size === "number") c.max_group_size = body.max_group_size;
      if (body.join_mode === "direct" || body.join_mode === "approval") c.join_mode = body.join_mode;
      c.lock_version += 1;
      return ok(toClassSettings(c, guard.perms.is_owner, guard.perms.can_manage));
    }
    if ((sub === "/end" || sub === "/archive" || sub === "/reopen") && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      if (guard.perms.role !== "teacher") {
        return err(403, "PERMISSION_DENIED", "仅授课教师可执行此操作");
      }
      if (Number(body.expected_version) !== guard.course.lock_version) {
        return err(409, "VERSION_CONFLICT", "状态版本冲突", { current_version: guard.course.lock_version });
      }
      if ((sub === "/end" || sub === "/reopen") && !String(body.reason ?? "").trim()) {
        return err(422, "REASON_REQUIRED", "请填写原因");
      }
      if (sub === "/reopen") {
        guard.course.status = "active";
        guard.course.archived_at = null;
      } else if (sub === "/archive") {
        if (guard.course.status === "active") {
          guard.course.status = "ended";
        }
        guard.course.archived_at = now;
      } else {
        guard.course.status = "ended";
      }
      guard.course.lock_version += 1;
      return ok(toClassSettings(guard.course, guard.perms.is_owner, guard.perms.can_manage));
    }
    if (sub === "/roster" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const statusFilter = url.searchParams.get("status") ?? "all";
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const active = guard.course.roster.filter((s) => s.status !== "left");
      const searched = q
        ? active.filter(
            (s) =>
              (s.name ?? "").toLowerCase().includes(q) ||
              (s.student_number ?? "").toLowerCase().includes(q) ||
              (s.email ?? "").toLowerCase().includes(q),
          )
        : active;
      const filtered = statusFilter === "all" ? searched : searched.filter((s) => s.status === statusFilter);
      const mapRow = (s: CourseRecord["roster"][number]) => {
        const grp = s.group_id ? guard.course.groups.find((g) => g.id === s.group_id) : undefined;
        return {
          id: s.id,
          name: s.name,
          student_number: s.student_number,
          email: s.email,
          initial: s.initial,
          joined_at: s.joined_at,
          status: s.status,
          group: grp ? { id: grp.id, name: grp.name } : null,
          is_leader: s.is_leader,
          in_project_group: s.in_project_group,
        };
      };
      return ok({
        items: filtered.map(mapRow),
        counts: {
          all: searched.length,
          grouped: searched.filter((s) => s.status === "grouped").length,
          ungrouped: searched.filter((s) => s.status === "ungrouped").length,
        },
        pending_join_count: guard.course.joinRequests.filter((j) => j.status === "pending").length,
      });
    }
    const rmStu = sub.match(/^\/students\/([^/]+)\/remove$/);
    if (rmStu && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "approve_changes");
      if (!guard.ok) return guard.res;
      if (!String(body.reason ?? "").trim()) return err(422, "REASON_REQUIRED", "请填写移出原因");
      const stu = guard.course.roster.find((s) => s.id === decodeURIComponent(rmStu[1]));
      if (!stu) return err(404, "NOT_FOUND", "学生不存在");
      if (stu.group_id) {
        const grp = guard.course.groups.find((g) => g.id === stu.group_id);
        if (grp) {
          grp.member_ids = grp.member_ids.filter((id) => id !== stu.id);
          if (grp.leader_id === stu.id) grp.leader_id = grp.member_ids[0] ?? null;
          grp.lock_version += 1;
        }
      }
      stu.status = "left";
      stu.group_id = null;
      stu.is_leader = false;
      stu.in_project_group = false;
      return ok({
        id: stu.id,
        name: stu.name,
        student_number: stu.student_number,
        email: stu.email,
        initial: stu.initial,
        joined_at: stu.joined_at,
        status: stu.status,
        group: null,
        is_leader: false,
        in_project_group: false,
      });
    }
    if (sub === "/plaza" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      return ok({
        course_id: guard.course.id,
        groups: guard.course.groups.map((g) => toPlazaGroup(guard.course, g, store)),
        ungrouped: guard.course.roster
          .filter((s) => s.status === "ungrouped")
          .map((s) => ({ id: s.id, name: s.name, student_number: s.student_number, initial: s.initial, is_leader: false })),
        formation_deadline: guard.course.formation_deadline,
        formation_open: guard.course.status === "active",
        can_manage: guard.perms.permissions.manage_groups,
      });
    }
    if (sub === "/groups" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "manage_groups");
      if (!guard.ok) return guard.res;
      const gName = String(body.name ?? "").trim();
      if (!gName) return err(422, "VALIDATION_ERROR", "小组名称不能为空");
      if (guard.course.groups.some((g) => g.name === gName)) return err(409, "GROUP_NAME_TAKEN", "小组名称已存在");
      const newGroup: GroupRecord = {
        id: store.nextUuid("20000000"),
        course_id: guard.course.id,
        name: gName,
        direction: typeof body.direction === "string" ? body.direction : null,
        leader_id: null,
        member_ids: [],
        max_group_size: guard.course.max_group_size,
        roster_frozen: false,
        project_id: null,
        lock_version: 1,
        locked_reason: null,
      };
      guard.course.groups.push(newGroup);
      return ok(toPlazaGroup(guard.course, newGroup, store), 201);
    }
    if (sub === "/assignments" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "manage_groups");
      if (!guard.ok) return guard.res;
      if (guard.course.status !== "active") {
        return err(409, "COURSE_NOT_ACTIVE", "课程已结课或未激活，不能调整分组");
      }
      const studentId = String(body.student_id ?? "");
      const toGroupId = body.to_group_id ? String(body.to_group_id) : null;
      const stu = guard.course.roster.find((s) => s.id === studentId && s.status !== "left");
      if (!stu) return err(404, "NOT_FOUND", "学生不在班级名册中");
      const fromGroup = stu.group_id ? guard.course.groups.find((g) => g.id === stu.group_id) ?? null : null;
      const toGroup = toGroupId ? guard.course.groups.find((g) => g.id === toGroupId) ?? null : null;
      if (toGroupId && !toGroup) return err(404, "GROUP_NOT_FOUND", "目标小组不存在");
      if ((fromGroup === null && toGroup === null) || (fromGroup !== null && toGroup?.id === fromGroup.id)) {
        const dto = fromGroup ? toPlazaGroup(guard.course, fromGroup, store) : null;
        return ok({ student_id: stu.id, from_group: dto, to_group: dto });
      }
      if (fromGroup) {
        if (body.from_group_version === undefined || body.from_group_version === null) {
          return err(409, "VERSION_CONFLICT", "内容已被其他人修改，请刷新后再操作。", {
            current_version: fromGroup.lock_version,
          });
        }
        if (Number(body.from_group_version) !== fromGroup.lock_version) {
          return err(409, "VERSION_CONFLICT", "原小组版本冲突", { current_version: fromGroup.lock_version });
        }
      }
      if (toGroup) {
        if (body.to_group_version === undefined || body.to_group_version === null) {
          return err(409, "VERSION_CONFLICT", "内容已被其他人修改，请刷新后再操作。", {
            current_version: toGroup.lock_version,
          });
        }
        if (Number(body.to_group_version) !== toGroup.lock_version) {
          return err(409, "VERSION_CONFLICT", "目标小组版本冲突", { current_version: toGroup.lock_version });
        }
      }
      if (fromGroup) {
        if (fromGroup.roster_frozen) {
          return err(409, "ROSTER_FROZEN", "该队伍名单已冻结，不能移出或调整成员。");
        }
        const hasProject = Boolean(fromGroup.project_id && store.projects.has(fromGroup.project_id));
        if (hasProject) {
          return err(409, "GROUP_HAS_PROJECT", "该队伍已立项，不能直接移出或换组。请通过成员变动流程处理。", {
            group_id: fromGroup.id,
            member_changes_href: `/teacher/courses/${guard.course.id}/member-changes`,
          });
        }
      }
      if (toGroup) {
        if (toGroup.roster_frozen) {
          return err(409, "ROSTER_FROZEN", "目标队伍名单已冻结，不能分配新成员。");
        }
        if (toGroup.member_ids.length >= toGroup.max_group_size) {
          return err(409, "GROUP_FULL", "目标队伍人数已满。");
        }
      }
      if (fromGroup && fromGroup.id !== toGroup?.id) {
        fromGroup.member_ids = fromGroup.member_ids.filter((id) => id !== stu.id);
        if (fromGroup.leader_id === stu.id) fromGroup.leader_id = fromGroup.member_ids[0] ?? null;
        fromGroup.lock_version += 1;
      }
      if (toGroup && !toGroup.member_ids.includes(stu.id)) {
        toGroup.member_ids.push(stu.id);
        if (!toGroup.leader_id) toGroup.leader_id = stu.id;
        toGroup.lock_version += 1;
      }
      stu.group_id = toGroup ? toGroup.id : null;
      stu.status = toGroup ? "grouped" : "ungrouped";
      stu.is_leader = Boolean(toGroup && toGroup.leader_id === stu.id);
      stu.in_project_group = Boolean(toGroup?.project_id);
      return ok({
        student_id: stu.id,
        from_group: fromGroup ? toPlazaGroup(guard.course, fromGroup, store) : null,
        to_group: toGroup ? toPlazaGroup(guard.course, toGroup, store) : null,
      });
    }
    const leaderMatch = sub.match(/^\/groups\/([^/]+)\/leader$/);
    if (leaderMatch && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "manage_groups");
      if (!guard.ok) return guard.res;
      const grp = guard.course.groups.find((g) => g.id === decodeURIComponent(leaderMatch[1]));
      if (!grp) return err(404, "GROUP_NOT_FOUND", "小组不存在");
      if (Number(body.expected_version) !== grp.lock_version) {
        return err(409, "VERSION_CONFLICT", "小组版本冲突", { current_version: grp.lock_version });
      }
      const userId = String(body.user_id ?? "");
      if (!grp.member_ids.includes(userId)) return err(422, "VALIDATION_ERROR", "该学生不在小组内");
      grp.leader_id = userId;
      grp.lock_version += 1;
      for (const s of guard.course.roster) {
        if (s.group_id === grp.id) s.is_leader = s.id === userId;
      }
      return ok(toPlazaGroup(guard.course, grp, store));
    }
    const grpDetail = sub.match(/^\/groups\/([^/]+)$/);
    if (grpDetail && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const grp = guard.course.groups.find((g) => g.id === decodeURIComponent(grpDetail[1]));
      if (!grp) return err(404, "GROUP_NOT_FOUND", "小组不存在");
      const project = grp.project_id ? store.projects.get(grp.project_id) : undefined;
      return ok({
        group: toPlazaGroup(guard.course, grp, store),
        members: grp.member_ids
          .map((uid) => guard.course.roster.find((s) => s.id === uid))
          .filter((s): s is NonNullable<typeof s> => Boolean(s))
          .map((s) => ({
            id: s.id,
            name: s.name,
            student_number: s.student_number,
            email: s.email,
            role: grp.leader_id === s.id ? "leader" : "member",
            joined_at: s.joined_at,
            open_task_count: project ? project.tasks.filter((t) => t.assignee_ids.includes(s.id) && t.status !== "done").length : 0,
          })),
        milestones: project ? project.milestones.map((ms) => toMilestoneDto(project, ms)) : [],
        member_changes_href: `/teacher/courses/${guard.course.id}/member-changes`,
      });
    }

    // Hub 3: Actions & Appeals under /teacher/classes/{id}
    if (sub === "/actions" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const typeParam = url.searchParams.get("type");
      const types = typeParam ? new Set(typeParam.split(",").filter(Boolean)) : null;
      const statusParam = url.searchParams.get("status") ?? "all";
      const priorityParam = url.searchParams.get("priority") ?? "all";
      const pageNum = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("page_size") ?? 20)));
      const all = guard.course.actions;
      const filtered = all.filter(
        (a) =>
          (!types || types.has(a.type)) &&
          (statusParam === "all" || a.status === statusParam) &&
          (priorityParam === "all" || a.priority === priorityParam),
      );
      const countsByType: Record<string, number> = {};
      for (const a of all) countsByType[a.type] = (countsByType[a.type] ?? 0) + 1;
      return ok({
        items: filtered.slice((pageNum - 1) * pageSize, pageNum * pageSize),
        total: filtered.length,
        pending_count: all.filter((a) => a.status === "pending").length,
        urgent_count: all.filter((a) => a.status === "pending" && a.priority === "urgent").length,
        counts_by_type: countsByType,
      });
    }
    if (sub === "/actions/batch" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const actionKey = String(body.action_key ?? "");
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      let handled = 0;
      const errors: { id: string; code: string; message: string }[] = [];
      for (const aid of ids) {
        const item = guard.course.actions.find((a) => a.id === aid);
        if (!item) {
          errors.push({ id: aid, code: "ACTION_NOT_FOUND", message: "事项不存在" });
          continue;
        }
        const r = applyActionDecision(guard.course, item, actionKey, reason, actor, guard.perms, store);
        if (r.status >= 400) {
          const e = (r.body as { error: { code: string; message: string } }).error;
          errors.push({ id: aid, code: e.code, message: e.message });
        } else {
          handled += 1;
        }
      }
      return ok({ handled, failed: errors.length, errors });
    }
    const actHandle = sub.match(/^\/actions\/([^/]+)\/(handle|remind)$/);
    if (actHandle && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const item = guard.course.actions.find((a) => a.id === decodeURIComponent(actHandle[1]));
      if (!item) return err(404, "ACTION_NOT_FOUND", "待办事项不存在");
      if (actHandle[2] === "remind") return ok({ notified_count: 1 });
      return applyActionDecision(
        guard.course,
        item,
        String(body.action_key ?? ""),
        typeof body.reason === "string" ? body.reason : undefined,
        actor,
        guard.perms,
        store,
      );
    }
    if (sub === "/appeals" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const statusFilter = url.searchParams.get("status") ?? "all";
      const all = guard.course.appeals;
      const items =
        statusFilter === "all"
          ? all
          : statusFilter === "pending"
            ? all.filter((a) => a.status === "pending" || a.status === "need_supplement")
            : statusFilter === "handled"
              ? all.filter((a) => a.status === "accepted" || a.status === "rejected")
              : all.filter((a) => a.status === statusFilter);
      const counts: Record<string, number> = {
        all: all.length,
        pending: 0,
        need_supplement: 0,
        handled: 0,
        accepted: 0,
        rejected: 0,
      };
      for (const a of all) {
        counts[a.status] = (counts[a.status] ?? 0) + 1;
        if (a.status === "accepted" || a.status === "rejected") {
          counts.handled += 1;
        }
      }
      return ok({ course_id: guard.course.id, can_handle: guard.perms.permissions.approve_changes, counts, items });
    }
    const appealHandle = sub.match(/^\/appeals\/([^/]+)(?:\/(handle))?$/);
    if (appealHandle) {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const appeal = guard.course.appeals.find((a) => a.id === decodeURIComponent(appealHandle[1]));
      if (!appeal) return err(404, "NOT_FOUND", "申诉不存在");
      const project = store.projects.get(appeal.project_id);
      const buildAppealDetail = () => ({
        appeal,
        can_handle: guard.perms.permissions.approve_changes,
        decisions: appeal.decisions,
        appellant_tasks: (project?.tasks ?? [])
          .filter((t) => t.assignee_ids.includes(appeal.appellant_id))
          .map((t) => ({ id: t.id, title: t.title, status: t.status, progress_percent: t.progress_percent })),
        github_commit_count: 14,
        snapshot: project?.contributionSnapshot ?? { snapshot_id: null, version_no: null, status: null, frozen_at: null, items: [] },
      });
      if (!appealHandle[2] && method === "GET") return ok(buildAppealDetail());
      if (appealHandle[2] === "handle" && method === "POST") {
        if (!guard.perms.permissions.approve_changes) return err(403, "PERMISSION_DENIED", "缺少申诉裁决权限");
        const action = String(body.action ?? "");
        const reason = String(body.reason ?? "").trim();
        if (!reason) return err(422, "REASON_REQUIRED", "请填写裁决说明");
        if (action === "reject") appeal.status = "rejected";
        else if (action === "request_supplement") appeal.status = "need_supplement";
        else if (action === "accept") appeal.status = "accepted";
        else return err(422, "INVALID_ACTION", "无效的申诉操作");
        appeal.resolved_by = actor.id;
        appeal.resolver_name = actor.name;
        appeal.resolved_at = now;
        appeal.updated_at = now;
        const adjustments = Array.isArray(body.contribution_adjustments)
          ? (body.contribution_adjustments as { user_id: string; share: number; note?: string }[])
          : null;
        if (action === "accept" && adjustments && project) {
          for (const adj of adjustments) {
            const member = project.contributionSnapshot.items.find((i) => i.user_id === adj.user_id);
            if (member) {
              member.share = adj.share;
              if (adj.note !== undefined) member.note = adj.note;
              member.status = "adjusted";
            }
          }
          project.contributionSnapshot.version_no += 1;
        }
        appeal.decisions.push({
          id: store.nextUuid("41000000"),
          actor_id: actor.id,
          actor_name: actor.name,
          action,
          reason,
          snapshot_id: project?.contributionSnapshot.snapshot_id ?? null,
          adjustments: adjustments ? (adjustments as unknown as Record<string, unknown>[]) : null,
          created_at: now,
        });
        return ok(buildAppealDetail());
      }
    }

    // Hub 4: Projects & Reports under /teacher/classes/{id}
    if (sub === "/projects" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const cards = guard.course.groups.map((g) => {
        const project = g.project_id ? store.projects.get(g.project_id) : undefined;
        const metrics = computeProjectMetrics(project);
        const leader = g.leader_id ? guard.course.roster.find((s) => s.id === g.leader_id) : undefined;
        return {
          group_id: g.id,
          group_name: g.name,
          member_count: g.member_ids.length,
          leader_name: leader?.name ?? null,
          has_project: Boolean(project),
          project_id: project?.id ?? null,
          project_name: project?.name ?? null,
          project_href: project ? `/projects/${project.id}` : null,
          plaza_href: `/teacher/courses/${guard.course.id}/groups`,
          ...metrics,
          risk_level: project?.risk_level ?? null,
          last_activity_at: project?.last_activity_at ?? null,
        };
      });
      return ok({
        course_id: guard.course.id,
        can_remind: guard.perms.can_manage,
        counts: {
          all: cards.length,
          initialized: cards.filter((c) => c.has_project).length,
          uninitialized: cards.filter((c) => !c.has_project).length,
          at_risk: cards.filter(
            (c) => c.risk_level === "high" || c.risk_level === "medium" || c.overdue_milestones > 0,
          ).length,
        },
        items: cards,
      });
    }
    const projDetail = sub.match(/^\/projects\/([^/]+)$/);
    if (projDetail && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const grp = guard.course.groups.find((g) => g.id === decodeURIComponent(projDetail[1]));
      if (!grp) return err(404, "GROUP_NOT_FOUND", "小组不存在");
      const project = grp.project_id ? store.projects.get(grp.project_id) : undefined;
      const metrics = computeProjectMetrics(project);
      const leader = grp.leader_id ? guard.course.roster.find((s) => s.id === grp.leader_id) : undefined;
      return ok({
        card: {
          group_id: grp.id,
          group_name: grp.name,
          member_count: grp.member_ids.length,
          leader_name: leader?.name ?? null,
          has_project: Boolean(project),
          project_id: project?.id ?? null,
          project_name: project?.name ?? null,
          project_href: project ? `/projects/${project.id}` : null,
          plaza_href: `/teacher/courses/${guard.course.id}/groups`,
          ...metrics,
          risk_level: project?.risk_level ?? null,
          last_activity_at: project?.last_activity_at ?? null,
        },
        members: grp.member_ids.map((uid) => guard.course.roster.find((s) => s.id === uid)?.name ?? uid),
        milestones: project ? project.milestones.map((ms) => toMilestoneDto(project, ms)) : [],
        recent_events: [],
      });
    }
    const projRemind = sub.match(/^\/projects\/([^/]+)\/remind$/);
    if (projRemind && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const groupId = decodeURIComponent(projRemind[1]);
      const grp = guard.course.groups.find((g) => g.id === groupId);
      if (!grp) return err(404, "GROUP_NOT_FOUND", "小组不存在");
      return ok({ group_id: grp.id, notified_count: Math.max(1, grp.member_ids.length) });
    }
    if (sub === "/reports/overview" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const risks = buildGroupRisks(guard.course, store);
      const groupProgress = guard.course.groups
        .map((g) => (g.project_id ? computeProjectMetrics(store.projects.get(g.project_id)).progress_percent : null))
        .filter((v): v is number => v !== null);
      return ok({
        course_id: guard.course.id,
        course_name: guard.course.name,
        student_count: guard.course.roster.filter((s) => s.status !== "left").length,
        group_count: guard.course.groups.length,
        project_count: guard.course.groups.filter((g) => Boolean(g.project_id)).length,
        ungrouped_count: guard.course.roster.filter((s) => s.status === "ungrouped").length,
        overall_progress: groupProgress.length
          ? Math.round(groupProgress.reduce((a, b) => a + b, 0) / groupProgress.length)
          : 0,
        high_risk_groups: risks.filter((r) => r.risk_level === "high").length,
        medium_risk_groups: risks.filter((r) => r.risk_level === "medium").length,
        overdue_milestones: risks.reduce((acc, r) => acc + r.overdue_milestones, 0),
        can_export: guard.perms.permissions.export_reports,
      });
    }
    if (sub === "/reports/progress" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      return ok({
        course_id: guard.course.id,
        items: guard.course.groups.map((g) => {
          const p = g.project_id ? store.projects.get(g.project_id) : undefined;
          const metrics = computeProjectMetrics(p);
          const tone = !p ? "gray" : metrics.overdue_milestones > 0 ? "yellow" : "green";
          return {
            group_id: g.id,
            group_name: g.name,
            has_project: Boolean(p),
            project_id: p?.id ?? null,
            project_name: p?.name ?? null,
            ...metrics,
            tone,
          };
        }),
      });
    }
    if (sub === "/reports/milestones" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      return ok({
        course_id: guard.course.id,
        rows: guard.course.groups.map((g) => {
          const p = g.project_id ? store.projects.get(g.project_id) : undefined;
          return {
            group_id: g.id,
            group_name: g.name,
            project_id: p?.id ?? null,
            project_name: p?.name ?? null,
            milestones: (p?.milestones ?? []).map((ms) => ({
              milestone_id: ms.id,
              title: ms.title,
              status: ms.status,
              overdue: ms.overdue,
              progress_percent: ms.progress_percent,
              deadline: ms.deadline,
              completed_task_count: ms.completed_task_count,
              task_count: ms.task_count,
            })),
          };
        }),
      });
    }
    if (sub === "/reports/risks" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      return guard.ok ? ok({ course_id: guard.course.id, items: buildGroupRisks(guard.course, store) }) : guard.res;
    }
    if (sub === "/reports/activity" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      return ok({
        course_id: guard.course.id,
        feishu_message_count: 18,
        total_github_events: 24,
        total_progress_events: 12,
        items: guard.course.roster
          .filter((s) => s.status !== "left")
          .map((s, idx) => ({
            user_id: s.id,
            name: s.name ?? "学生",
            student_number: s.student_number,
            group_name: guard.course.groups.find((g) => g.id === s.group_id)?.name ?? null,
            github_events: 10 - idx * 3,
            progress_events: 5 - idx,
            completed_tasks: idx === 0 ? 2 : 1,
            total_score: 90 - idx * 12,
            low_activity: idx >= 2,
          })),
      });
    }
    if (sub === "/reports/contribution" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const projects = guard.course.groups
        .map((g) => {
          const p = g.project_id ? store.projects.get(g.project_id) : undefined;
          if (!p) return null;
          return {
            project_id: p.id,
            project_name: p.name,
            group_id: g.id,
            group_name: g.name,
            ...p.contributionSnapshot,
          };
        })
        .filter((p): p is NonNullable<typeof p> => Boolean(p));
      return ok({ course_id: guard.course.id, projects });
    }
    if (sub === "/reports/export" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "export_reports");
      if (!guard.ok) return guard.res;
      const format = body.format === "markdown" || body.format === "json" ? body.format : "csv";
      const content =
        format === "json"
          ? JSON.stringify({ course_id: guard.course.id, name: guard.course.name, groups: guard.course.groups.length })
          : format === "markdown"
            ? `# ${guard.course.name} 课程报告\n- 学生数: ${guard.course.roster.length}\n`
            : `course_code,course_name,students,groups\n${guard.course.code},${guard.course.name},${guard.course.roster.length},${guard.course.groups.length}\n`;
      return ok({
        format,
        filename: `${guard.course.code}-report.${format === "markdown" ? "md" : format}`,
        mime_type: format === "json" ? "application/json" : format === "markdown" ? "text/markdown" : "text/csv",
        content,
        download_href: `/api/v1/teacher/classes/${guard.course.id}/reports/export/download?format=${format}`,
      });
    }
    if (sub === "/reports/export/download" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "export_reports");
      if (!guard.ok) return guard.res;
      const format = url.searchParams.get("format") ?? "csv";
      return {
        status: 200,
        contentType: format === "json" ? "application/json" : "text/csv; charset=utf-8",
        headers: { "Content-Disposition": `attachment; filename="${guard.course.code}-report.${format}"` },
        rawBody: `course_code,course_name\n${guard.course.code},${guard.course.name}\n`,
      };
    }

    // Hub 5: Rules, Files, Announcements, Staff
    if (sub === "/rules" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const effective = guard.course.publishedRuleVersion?.rules ?? guard.course.draftRuleVersion?.rules ?? {
        grouping_mode: "free",
        min_group_size: guard.course.min_group_size,
        max_group_size: guard.course.max_group_size,
        formation_deadline: guard.course.formation_deadline,
        post_deadline_policy: "teacher_approval",
        allow_cross_group_transfer: true,
        project_deadline: guard.course.project_deadline,
        milestone_template: [],
        require_baseline_review: true,
        require_plan_review: false,
        auto_contribution: true,
        contribution_weights: { task_weight: 50, verification_weight: 30, collaboration_weight: 20 },
        appeal_window_days: 7,
        required_deliverables: [],
        final_presentation: true,
      };
      return ok({
        course_id: guard.course.id,
        course_status: guard.course.status,
        can_edit: guard.perms.role === "teacher",
        current_published: guard.course.publishedRuleVersion,
        draft: guard.course.draftRuleVersion,
        effective_rules: effective,
        versions: guard.course.ruleVersions.map(({ rules: _r, ...brief }) => {
          void _r;
          return brief;
        }),
      });
    }
    if (sub === "/rules/milestone-template" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const ver = guard.course.publishedRuleVersion ?? guard.course.draftRuleVersion;
      return ok({ course_id: guard.course.id, items: ver?.rules.milestone_template ?? [], version_no: ver?.version_no ?? 1 });
    }
    if ((sub === "/rules/draft" && method === "PUT") || (sub === "/rules/publish" && method === "POST")) {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      if (guard.perms.role !== "teacher") {
        return err(403, "FORBIDDEN", "只有本课程老师可以修改或发布课程规则");
      }
      if (guard.course.status !== "active") {
        return err(409, "COURSE_NOT_ACTIVE", "课程已结课或归档，当前为只读状态");
      }
      const rules = (body.rules as CourseRulesData | undefined) ?? guard.course.draftRuleVersion?.rules ?? guard.course.publishedRuleVersion?.rules;
      if (!rules) return err(422, "VALIDATION_ERROR", "缺少规则配置");
      const w = rules.contribution_weights;
      if (w.task_weight + w.verification_weight + w.collaboration_weight !== 100) {
        return err(422, "VALIDATION_ERROR", "贡献度权重之和必须为 100");
      }
      if (rules.min_group_size > rules.max_group_size) {
        return err(422, "VALIDATION_ERROR", "最小人数不能大于最大人数");
      }
      if (sub === "/rules/publish" && !String(body.change_summary ?? "").trim()) {
        return err(422, "VALIDATION_ERROR", "发布规则时必须填写变更说明");
      }
      const summary = String(body.change_summary ?? "更新课程规则").trim() || "更新课程规则";
      if (sub === "/rules/draft") {
        const nextNo = (guard.course.publishedRuleVersion?.version_no ?? 0) + 1;
        guard.course.draftRuleVersion = {
          version_no: nextNo,
          status: "draft",
          change_summary: summary,
          published_by: null,
          published_at: null,
          created_at: now,
          rules,
        };
        return ok(guard.course.draftRuleVersion);
      }
      if (guard.course.publishedRuleVersion) {
        guard.course.publishedRuleVersion.status = "archived";
      }
      const nextVer = (guard.course.publishedRuleVersion?.version_no ?? 0) + 1;
      const published = {
        version_no: nextVer,
        status: "published" as const,
        change_summary: summary,
        published_by: actor.id,
        published_at: now,
        created_at: now,
        rules,
      };
      guard.course.publishedRuleVersion = published;
      guard.course.draftRuleVersion = null;
      guard.course.ruleVersions.unshift(published);
      guard.course.min_group_size = rules.min_group_size;
      guard.course.max_group_size = rules.max_group_size;
      if (rules.formation_deadline !== undefined) guard.course.formation_deadline = rules.formation_deadline ?? null;
      if (rules.project_deadline !== undefined) guard.course.project_deadline = rules.project_deadline ?? null;
      guard.course.lock_version += 1;
      return ok(published);
    }
    const ruleVerMatch = sub.match(/^\/rules\/(\d+)$/);
    if (ruleVerMatch && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const verNo = Number(ruleVerMatch[1]);
      const found = guard.course.ruleVersions.find((v) => v.version_no === verNo) ?? (guard.course.draftRuleVersion?.version_no === verNo ? guard.course.draftRuleVersion : undefined);
      return found ? ok(found) : err(404, "NOT_FOUND", "规则版本不存在");
    }

    if (sub === "/files" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const folderId = url.searchParams.get("folder_id") || null;
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const vis = url.searchParams.get("visibility") || "";
      const includeAll = url.searchParams.get("include_all") === "true";
      const breadcrumbs: { id: string; name: string; parent_id: string | null }[] = [];
      let curId = folderId;
      while (curId) {
        const f = guard.course.folders.find((x) => x.id === curId);
        if (!f) break;
        breadcrumbs.unshift({ id: f.id, name: f.name, parent_id: f.parent_id });
        curId = f.parent_id;
      }
      const folders = guard.course.folders
        .filter((f) => (includeAll ? true : f.parent_id === folderId))
        .map((f) => ({
          ...f,
          item_count: guard.course.materials.filter((mat) => mat.folder_id === f.id).length,
        }));
      const items = guard.course.materials
        .filter(
          (mat) =>
            (includeAll || q ? true : mat.folder_id === folderId) &&
            (!q || mat.name.toLowerCase().includes(q)) &&
            (!vis || mat.visibility === vis),
        )
        .map((mat) => toMaterialItem(guard.course, mat));
      return ok({ course_id: guard.course.id, can_manage: guard.perms.permissions.manage_files, current_folder_id: folderId, breadcrumbs, folders, items });
    }
    if (sub === "/files/folders" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "manage_files");
      if (!guard.ok) return guard.res;
      const fName = String(body.name ?? "").trim();
      const parentId = body.parent_id ? String(body.parent_id) : null;
      if (!fName) return err(422, "VALIDATION_ERROR", "文件夹名称不能为空");
      if (guard.course.folders.some((f) => f.name === fName && f.parent_id === parentId)) {
        return err(409, "FOLDER_NAME_DUPLICATE", "同名文件夹已存在");
      }
      const folder = { id: store.nextUuid("60000000"), course_id: guard.course.id, name: fName, parent_id: parentId, sort_order: Number(body.sort_order ?? 1), created_at: now };
      guard.course.folders.push(folder);
      return ok({ ...folder, item_count: 0 }, 201);
    }
    const folderPatchDel = sub.match(/^\/files\/folders\/([^/]+)$/);
    if (folderPatchDel) {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "manage_files");
      if (!guard.ok) return guard.res;
      const fid = decodeURIComponent(folderPatchDel[1]);
      const folder = guard.course.folders.find((f) => f.id === fid);
      if (!folder) return err(404, "NOT_FOUND", "文件夹不存在");
      if (method === "PATCH") {
        if (typeof body.name === "string" && body.name.trim()) folder.name = body.name.trim();
        if (body.move_to_root === true) folder.parent_id = null;
        else if (body.parent_id !== undefined) folder.parent_id = body.parent_id ? String(body.parent_id) : null;
        if (typeof body.sort_order === "number") folder.sort_order = body.sort_order;
        return ok({ ...folder, item_count: guard.course.materials.filter((mat) => mat.folder_id === folder.id).length });
      }
      if (method === "DELETE") {
        guard.course.folders = guard.course.folders.filter((f) => f.id !== fid);
        for (const mat of guard.course.materials) {
          if (mat.folder_id === fid) mat.folder_id = null;
        }
        return ok({ deleted: true, id: fid });
      }
    }
    if (sub === "/files/upload" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "manage_files");
      if (!guard.ok) return guard.res;
      const name = String(body.name ?? "").trim();
      if (!name) return err(422, "VALIDATION_ERROR", "文件名不能为空");
      const contentB64 = typeof body.content_base64 === "string" ? body.content_base64 : "";
      const decoded = contentB64 ? Buffer.from(contentB64, "base64").toString("utf8") : `Mock content for ${name}`;
      const sizeBytes = Number(body.size_bytes ?? Buffer.byteLength(decoded));
      if (sizeBytes > 52428800) return err(422, "FILE_TOO_LARGE", "文件超出大小限制");
      const mat: CourseMaterialRecord = {
        id: store.nextUuid("61000000"),
        course_id: guard.course.id,
        folder_id: body.folder_id ? String(body.folder_id) : null,
        name,
        visibility: body.visibility === "grouped" || body.visibility === "staff" ? body.visibility : "all",
        status: body.status === "draft" ? "draft" : "published",
        uploaded_by: actor.id,
        uploader_name: actor.name,
        created_at: now,
        updated_at: now,
        versions: [
          {
            id: store.nextUuid("62000000"),
            version_no: 1,
            original_name: name,
            mime_type: String(body.mime_type ?? "application/octet-stream"),
            size_bytes: sizeBytes,
            checksum: createHash("sha256").update(decoded).digest("hex").slice(0, 16),
            change_note: typeof body.change_note === "string" ? body.change_note : null,
            uploaded_by: actor.id,
            uploader_name: actor.name,
            created_at: now,
            has_content: true,
            content_text: decoded,
          },
        ],
      };
      guard.course.materials.push(mat);
      return ok({ item: toMaterialItem(guard.course, mat), versions: mat.versions }, 201);
    }
    if (sub === "/files/batch" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "manage_files");
      if (!guard.ok) return guard.res;
      const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      const action = String(body.action ?? "");
      let affected = 0;
      if (action === "delete") {
        const before = guard.course.materials.length;
        guard.course.materials = guard.course.materials.filter((mat) => !ids.has(mat.id));
        affected = before - guard.course.materials.length;
      } else {
        for (const mat of guard.course.materials) {
          if (!ids.has(mat.id)) continue;
          if (action === "move") mat.folder_id = body.folder_id ? String(body.folder_id) : null;
          if (action === "set_visibility" && (body.visibility === "all" || body.visibility === "grouped" || body.visibility === "staff")) {
            mat.visibility = body.visibility;
          }
          mat.updated_at = now;
          affected += 1;
        }
      }
      return ok({ affected, action });
    }
    const fileSub = sub.match(/^\/files\/([^/]+)(?:\/(versions|download))?$/);
    if (fileSub) {
      const mid = decodeURIComponent(fileSub[1]);
      const op = fileSub[2] ?? "";
      const needManage = op === "versions" ? method === "POST" : method === "PATCH" || method === "DELETE";
      const guard = ensureCourseStaff(course, actor, options.taPermissions, needManage ? "manage_files" : undefined);
      if (!guard.ok) return guard.res;
      const mat = guard.course.materials.find((x) => x.id === mid);
      if (!mat) return err(404, "NOT_FOUND", "资料不存在");
      if (op === "versions" && method === "GET") return ok({ item: toMaterialItem(guard.course, mat), versions: mat.versions });
      if (op === "versions" && method === "POST") {
        const verNo = mat.versions.length + 1;
        const ver = {
          id: store.nextUuid("62000000"),
          version_no: verNo,
          original_name: String(body.original_name ?? mat.name),
          mime_type: String(body.mime_type ?? mat.versions[mat.versions.length - 1]?.mime_type ?? "application/octet-stream"),
          size_bytes: Number(body.size_bytes ?? 1024),
          checksum: `mock-v${verNo}`,
          change_note: typeof body.change_note === "string" ? body.change_note : null,
          uploaded_by: actor.id,
          uploader_name: actor.name,
          created_at: now,
          has_content: true,
          content_text: `Mock v${verNo} for ${mat.name}`,
        };
        mat.versions.push(ver);
        mat.updated_at = now;
        return ok({ item: toMaterialItem(guard.course, mat), versions: mat.versions }, 201);
      }
      if (op === "download" && method === "GET") {
        const verNo = Number(url.searchParams.get("version_no") ?? 0);
        const ver = (verNo ? mat.versions.find((v) => v.version_no === verNo) : undefined) ?? mat.versions[mat.versions.length - 1];
        return {
          status: 200,
          contentType: ver?.mime_type ?? "application/octet-stream",
          headers: { "Content-Disposition": `attachment; filename="${encodeURIComponent(mat.name)}"` },
          rawBody: ver?.content_text ?? mat.name,
        };
      }
      if (op === "" && method === "PATCH") {
        if (typeof body.name === "string" && body.name.trim()) mat.name = body.name.trim();
        if (body.move_to_root === true) mat.folder_id = null;
        else if (body.folder_id !== undefined) mat.folder_id = body.folder_id ? String(body.folder_id) : null;
        if (body.visibility === "all" || body.visibility === "grouped" || body.visibility === "staff") mat.visibility = body.visibility;
        if (body.status === "draft" || body.status === "published") mat.status = body.status;
        mat.updated_at = now;
        return ok(toMaterialItem(guard.course, mat));
      }
      if (op === "" && method === "DELETE") {
        guard.course.materials = guard.course.materials.filter((x) => x.id !== mid);
        return ok({ deleted: true, id: mid });
      }
    }

    if (sub === "/announcements" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      return ok({
        course_id: guard.course.id,
        can_post: guard.perms.permissions.post_announcements,
        total_students: guard.course.roster.filter((s) => s.status !== "left").length,
        items: guard.course.announcements.map((a) => toAnnouncementItem(guard.course, a)),
      });
    }
    if (sub === "/announcements" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "post_announcements");
      if (!guard.ok) return guard.res;
      const title = String(body.title ?? "").trim();
      const content = String(body.content ?? "").trim();
      if (!title || !content) return err(422, "VALIDATION_ERROR", "公告标题和正文不能为空");
      const status = body.status === "draft" ? "draft" : "published";
      const ann: AnnouncementRecord = {
        id: store.nextUuid("50000000"),
        course_id: guard.course.id,
        title,
        content,
        priority: body.priority === "urgent" || body.priority === "important" ? body.priority : "normal",
        is_pinned: Boolean(body.is_pinned),
        status,
        published_by: actor.id,
        publisher_name: actor.name,
        published_at: status === "published" ? now : null,
        created_at: now,
        updated_at: now,
        read_by: {},
      };
      guard.course.announcements.unshift(ann);
      return ok(toAnnouncementItem(guard.course, ann), 201);
    }
    const annSub = sub.match(/^\/announcements\/([^/]+)(?:\/(reads|remind))?$/);
    if (annSub) {
      const aid = decodeURIComponent(annSub[1]);
      const op = annSub[2] ?? "";
      const needPost = op === "remind" || (op === "" && (method === "PATCH" || method === "DELETE"));
      const guard = ensureCourseStaff(course, actor, options.taPermissions, needPost ? "post_announcements" : undefined);
      if (!guard.ok) return guard.res;
      const ann = guard.course.announcements.find((a) => a.id === aid);
      if (!ann) return err(404, "NOT_FOUND", "公告不存在");
      if (op === "" && method === "PATCH") {
        if (typeof body.title === "string" && body.title.trim()) ann.title = body.title.trim();
        if (typeof body.content === "string" && body.content.trim()) ann.content = body.content.trim();
        if (body.priority === "normal" || body.priority === "important" || body.priority === "urgent") ann.priority = body.priority;
        if (typeof body.is_pinned === "boolean") ann.is_pinned = body.is_pinned;
        if (body.status === "draft" || body.status === "published") {
          ann.status = body.status;
          if (ann.status === "published" && !ann.published_at) ann.published_at = now;
        }
        ann.updated_at = now;
        return ok(toAnnouncementItem(guard.course, ann));
      }
      if (op === "" && method === "DELETE") {
        guard.course.announcements = guard.course.announcements.filter((a) => a.id !== aid);
        return ok({ deleted: true, id: aid });
      }
      if (op === "reads" && method === "GET") {
        const active = guard.course.roster.filter((s) => s.status !== "left");
        const readUsers = active
          .filter((s) => Boolean(ann.read_by[s.id]))
          .map((s) => ({ user_id: s.id, name: s.name ?? "学生", student_number: s.student_number, read_at: ann.read_by[s.id] }));
        const unreadUsers = active
          .filter((s) => !ann.read_by[s.id])
          .map((s) => ({ user_id: s.id, name: s.name ?? "学生", student_number: s.student_number, read_at: null }));
        return ok({
          announcement_id: ann.id,
          title: ann.title,
          total_students: active.length,
          read_count: readUsers.length,
          unread_count: unreadUsers.length,
          read_users: readUsers,
          unread_users: unreadUsers,
        });
      }
      if (op === "remind" && method === "POST") {
        const unreadCount = guard.course.roster.filter((s) => s.status !== "left" && !ann.read_by[s.id]).length;
        return ok({ announcement_id: ann.id, notified_count: unreadCount });
      }
    }

    if (sub === "/staff" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const items = guard.course.staff.map((s) =>
        s.role === "ta" && options.taPermissions ? { ...s, permissions: { ...s.permissions, ...options.taPermissions } } : s,
      );
      return ok({ items, total: items.length, can_manage_staff: guard.perms.is_owner });
    }
    if (sub === "/my-permissions" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      return guard.ok ? ok(guard.perms) : guard.res;
    }
    if (sub === "/staff/invite" && method === "POST") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      if (!guard.perms.is_owner) return err(403, "COURSE_OWNER_REQUIRED", "仅课程创建者可邀请助教或教师");
      const email = String(body.email ?? "").trim();
      if (!email) return err(422, "VALIDATION_ERROR", "邮箱不能为空");
      const role = body.role === "teacher" ? "teacher" : "ta";
      const member = {
        user_id: store.nextUuid("00000000"),
        name: email.split("@")[0] || "新助教",
        email,
        role: role as "teacher" | "ta",
        permissions: role === "teacher" ? fullStaffPermissions() : { ...fullStaffPermissions(), post_announcements: false },
        joined_at: now,
        is_owner: false,
      };
      guard.course.staff.push(member);
      return ok(member, 201);
    }
    const staffOp = sub.match(/^\/staff\/([^/]+)\/(permissions|remove)$/);
    if (staffOp) {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      if (!guard.perms.is_owner) return err(403, "COURSE_OWNER_REQUIRED", "仅课程创建者可管理教学团队");
      const uid = decodeURIComponent(staffOp[1]);
      const target = guard.course.staff.find((s) => s.user_id === uid);
      if (!target) return err(404, "NOT_FOUND", "团队成员不存在");
      if (staffOp[2] === "permissions" && method === "PATCH") {
        target.permissions = { ...target.permissions, ...(body as Partial<StaffPermissions>) };
        return ok(target);
      }
      if (staffOp[2] === "remove" && method === "POST") {
        if (!String(body.reason ?? "").trim()) return err(422, "REASON_REQUIRED", "请填写移出原因");
        guard.course.staff = guard.course.staff.filter((s) => s.user_id !== uid);
        return ok({ removed: true, user_id: uid });
      }
    }
  }

  // Hub 3 direct endpoints & Student -> Teacher flows
  if (method === "GET" && path === "/api/v1/me/notifications") {
    const state = url.searchParams.get("state") ?? "all";
    const category = url.searchParams.get("category") ?? "all";
    const pageNum = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const pageSize = Math.max(1, Math.min(50, Number(url.searchParams.get("page_size") ?? 20)));
    const filtered = store.notifications.filter(
      (n) =>
        (state === "all" || (state === "unread" ? n.read_at === null : n.read_at !== null)) &&
        (category === "all" || n.category === category),
    );
    return ok({
      inbox_version: store.inboxVersion,
      snapshot_id: store.inboxSnapshotId,
      page: pageNum,
      page_size: pageSize,
      total: filtered.length,
      total_all: store.notifications.length,
      unread_total: store.notifications.filter((n) => n.read_at === null).length,
      items: filtered.slice((pageNum - 1) * pageSize, pageNum * pageSize),
    });
  }
  if (method === "POST" && path === "/api/v1/me/notifications/read-all") {
    const expectedInboxVersion = body.expected_inbox_version;
    const snapshotId = typeof body.snapshot_id === "string" ? body.snapshot_id : "";
    if (
      typeof expectedInboxVersion !== "number" ||
      !Number.isInteger(expectedInboxVersion) ||
      expectedInboxVersion < 0 ||
      !UUID_RE.test(snapshotId)
    ) {
      return err(422, "VALIDATION_ERROR", "Request validation failed.");
    }
    if (expectedInboxVersion !== store.inboxVersion || snapshotId !== store.inboxSnapshotId) {
      return err(409, "VERSION_CONFLICT", "通知列表已有变化，请刷新后再试。", {
        current_inbox_version: store.inboxVersion,
        snapshot_id: store.inboxSnapshotId,
      });
    }
    const unreadBefore = store.notifications.filter((n) => n.read_at === null).length;
    let count = 0;
    for (const n of store.notifications) {
      if (n.read_at === null) {
        n.read_at = now >= n.created_at ? now : n.created_at;
        n.lock_version += 1;
        count += 1;
      }
    }
    if (count > 0) {
      store.inboxVersion += 1;
      store.inboxSnapshotId = store.nextUuid("90000000");
    }
    return ok({
      recipient_id: actor.id,
      operation: "all",
      notification_id: null,
      idempotency_key: request.headers()["idempotency-key"] ?? "",
      snapshot_id: snapshotId,
      expected_version: null,
      expected_inbox_version: expectedInboxVersion,
      resulting_version: null,
      resulting_inbox_version: expectedInboxVersion + (count > 0 ? 1 : 0),
      total_all: store.notifications.length,
      unread_before: unreadBefore,
      unread_after: unreadBefore - count,
      marked_count: count,
      read_at: now,
    });
  }
  const notifRead = path.match(/^\/api\/v1\/me\/notifications\/([^/]+)\/read$/);
  if (notifRead && method === "POST") {
    const nid = decodeURIComponent(notifRead[1]);
    const expectedVersion = body.expected_version;
    const expectedInboxVersion = body.expected_inbox_version;
    const snapshotId = typeof body.snapshot_id === "string" ? body.snapshot_id : "";
    if (
      typeof expectedVersion !== "number" ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 0 ||
      typeof expectedInboxVersion !== "number" ||
      !Number.isInteger(expectedInboxVersion) ||
      expectedInboxVersion < 0 ||
      !UUID_RE.test(snapshotId)
    ) {
      return err(422, "VALIDATION_ERROR", "Request validation failed.");
    }
    if (expectedInboxVersion !== store.inboxVersion || snapshotId !== store.inboxSnapshotId) {
      return err(409, "VERSION_CONFLICT", "通知列表已有变化，请刷新后再试。", {
        current_inbox_version: store.inboxVersion,
        snapshot_id: store.inboxSnapshotId,
      });
    }
    const item = store.notifications.find((n) => n.id === nid);
    if (!item) return err(404, "NOT_FOUND", "通知不存在");
    if (expectedVersion !== item.lock_version) {
      return err(409, "VERSION_CONFLICT", "通知已被修改，请刷新后再试。", {
        current_version: item.lock_version,
      });
    }
    const unreadBefore = store.notifications.filter((n) => n.read_at === null).length;
    let marked = 0;
    if (item.read_at === null) {
      item.read_at = now >= item.created_at ? now : item.created_at;
      item.lock_version += 1;
      marked = 1;
      store.inboxVersion += 1;
      store.inboxSnapshotId = store.nextUuid("90000000");
    }
    return ok({
      recipient_id: item.recipient_id,
      operation: "single",
      notification_id: nid,
      idempotency_key: request.headers()["idempotency-key"] ?? "",
      snapshot_id: snapshotId,
      expected_version: expectedVersion,
      expected_inbox_version: expectedInboxVersion,
      resulting_version: expectedVersion + marked,
      resulting_inbox_version: expectedInboxVersion + marked,
      total_all: store.notifications.length,
      unread_before: unreadBefore,
      unread_after: unreadBefore - marked,
      marked_count: marked,
      read_at: item.read_at,
    });
  }
  if (method === "GET" && path === "/api/v1/me/action-items") {
    const statusFilter = url.searchParams.get("status") ?? "pending";
    const categoryFilter = url.searchParams.get("category") ?? "all";
    const pageNum = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const pageSize = Math.max(1, Math.min(50, Number(url.searchParams.get("page_size") ?? 20)));
    const filtered = store.actionItems.filter(
      (a) =>
        (statusFilter === "all" || a.status === statusFilter) &&
        (categoryFilter === "all" || a.category === categoryFilter),
    );
    return ok({
      items: filtered.slice((pageNum - 1) * pageSize, pageNum * pageSize),
      page: pageNum,
      page_size: pageSize,
      total: filtered.length,
    });
  }
  if (method === "GET" && path === "/api/v1/me/announcements/unread") {
    const items: ReturnType<typeof toAnnouncementItem>[] = [];
    for (const c of store.courses.values()) {
      const inCourse = c.roster.some((s) => s.id === actor.id && s.status !== "left");
      if (!inCourse && actor.actor !== "teacher") continue;
      for (const ann of c.announcements) {
        if (ann.status === "published" && !ann.read_by[actor.id]) items.push(toAnnouncementItem(c, ann));
      }
    }
    return ok({ total: items.length, items });
  }
  if (method === "GET" && path === "/api/v1/home/summary") {
    const isStaffActor = actor.actor === "teacher" || actor.actor === "ta";
    const myCourses = Array.from(store.courses.values()).filter((c) => {
      if (isStaffActor) return true;
      return c.roster.some((s) => s.id === actor.id && s.status !== "left");
    });
    const myProjects = Array.from(store.projects.values()).filter((p) => {
      if (isStaffActor) return true;
      const c = store.courses.get(p.course_id);
      const grp = c?.groups.find((g) => g.id === p.group_id);
      return Boolean(grp?.member_ids.includes(actor.id));
    });
    const allTasks = myProjects.flatMap((p) =>
      p.tasks.filter((t) => isStaffActor || t.assignee_ids.includes(actor.id)),
    );
    const completed = allTasks.filter((t) => t.status === "done" || t.status === "completed").length;
    const inProgress = allTasks.filter((t) => t.status === "in_progress").length;
    const notStarted = allTasks.filter((t) => t.status === "todo" || t.status === "not_started").length;
    const pendingSubmission = allTasks.filter((t) => t.status === "pending_submission").length;
    const pendingVerification = allTasks.filter((t) => t.status === "pending_verification").length;

    return ok({
      scope: "personal",
      course_count: myCourses.length,
      courses: myCourses.slice(0, 10).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status === "archived" ? "ended" : c.status,
        href: isStaffActor ? `/teacher/courses/${c.id}` : `/courses/${c.id}`,
      })),
      project_count: myProjects.length,
      projects: myProjects.slice(0, 10).map((p) => {
        const metrics = computeProjectMetrics(p);
        return {
          id: p.id,
          name: p.name,
          lifecycle: p.lifecycle,
          progress: metrics.progress_percent,
          progress_status: metrics.total_tasks > 0 ? "available" : "no_weighted_tasks",
          href: `/projects/${p.id}`,
        };
      }),
      my_task_count: allTasks.length,
      my_completed_tasks: completed,
      task_counts: {
        not_started: notStarted,
        in_progress: inProgress,
        pending_submission: pendingSubmission,
        pending_verification: pendingVerification,
        completed,
      },
      unread_notifications: store.notifications.filter((n) => n.read_at === null).length,
      pending_action_items: store.actionItems.filter((a) => a.status === "pending").length,
      unavailable_sources: [],
    });
  }
  if (method === "GET" && (path === "/api/v1/me/courses" || path === "/api/v1/courses")) {
    const tab = url.searchParams.get("tab") ?? "all";
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const myCourses = Array.from(store.courses.values()).filter((c) => {
      if (actor.actor === "teacher" || actor.actor === "ta") return true;
      return c.roster.some((s) => s.id === actor.id && s.status !== "left");
    });
    const searched = q
      ? myCourses.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
      : myCourses;
    const filtered = tab === "all" ? searched : searched.filter((c) => c.status === tab);
    const items = filtered.map((c) => {
      const meRoster = c.roster.find((s) => s.id === actor.id);
      const grp = meRoster?.group_id ? c.groups.find((g) => g.id === meRoster.group_id) : undefined;
      const proj = grp?.project_id ? store.projects.get(grp.project_id) : undefined;
      const owner = c.staff.find((s) => s.is_owner);
      return {
        id: c.id,
        code: c.code,
        name: c.name,
        semester: c.semester,
        college: c.college,
        status: c.status === "archived" ? "ended" : c.status,
        role: actor.actor === "teacher" || actor.actor === "ta" ? actor.actor : "student",
        joined_at: meRoster?.joined_at ?? now,
        teacher: owner ? { id: owner.user_id, name: owner.name } : null,
        formation_deadline: c.formation_deadline,
        project_deadline: c.project_deadline,
        group: grp ? { id: grp.id, name: grp.name } : null,
        project: proj ? { id: proj.id, name: proj.name } : null,
        pending_count: c.announcements.filter((a) => a.status === "published" && !a.read_by[actor.id]).length,
      };
    });
    const pendingJoins = Array.from(store.courses.values()).flatMap((c) =>
      c.joinRequests
        .filter((j) => j.student.id === actor.id && j.status === "pending")
        .map((j) => ({ request_id: j.id, course_id: c.id, course_name: c.name, created_at: j.created_at })),
    );
    return ok({
      items,
      total: items.length,
      page: 1,
      page_size: 20,
      counts: {
        all: searched.length,
        active: searched.filter((c) => c.status === "active").length,
        ended: searched.filter((c) => c.status !== "active").length,
      },
      pending_joins: pendingJoins,
    });
  }

  // Course joins preview / join / decision
  if (method === "POST" && path === "/api/v1/course-joins/preview") {
    const code = String(body.invite_code ?? "").trim();
    const course = Array.from(store.courses.values()).find((c) => c.invite_code === code);
    if (!course) return err(404, "NOT_FOUND", "邀请码无效");
    const owner = course.staff.find((s) => s.is_owner);
    const pending = course.joinRequests.find((j) => j.student.id === actor.id && j.status === "pending");
    return ok({
      course_id: course.id,
      code: course.code,
      name: course.name,
      semester: course.semester,
      college: course.college,
      teacher: owner ? { id: owner.user_id, name: owner.name } : null,
      grouping_mode: course.publishedRuleVersion?.rules.grouping_mode ?? "free",
      min_group_size: course.min_group_size,
      max_group_size: course.max_group_size,
      formation_deadline: course.formation_deadline,
      project_deadline: course.project_deadline,
      join_mode: course.join_mode,
      already_member: course.roster.some((s) => s.id === actor.id && s.status !== "left"),
      pending_request_id: pending?.id ?? null,
    });
  }
  if (method === "POST" && path === "/api/v1/course-joins") {
    const code = String(body.invite_code ?? "").trim();
    const course = Array.from(store.courses.values()).find((c) => c.invite_code === code);
    if (!course) return err(404, "NOT_FOUND", "邀请码无效");
    if (course.status !== "active") return err(409, "COURSE_NOT_ACTIVE", "班级已结课");
    if (course.roster.some((s) => s.id === actor.id && s.status !== "left")) {
      return err(409, "ALREADY_MEMBER", "你已经是这门课程的成员。");
    }
    if (course.joinRequests.some((j) => j.student.id === actor.id && j.status === "pending")) {
      return err(409, "JOIN_REQUEST_PENDING", "你的加入申请正在等待老师审批。");
    }
    if (course.join_mode === "direct") {
      course.roster.push({
        id: actor.id,
        name: actor.name,
        student_number: actor.studentId,
        email: actor.email,
        initial: actor.name.slice(0, 1) || "学",
        joined_at: now,
        status: "ungrouped",
        group_id: null,
        is_leader: false,
        in_project_group: false,
      });
      return ok({ status: "joined", course_id: course.id, request_id: null }, 201);
    }
    const jrId = store.nextUuid("70000000");
    course.joinRequests.unshift({
      id: jrId,
      course_id: course.id,
      student: { id: actor.id, name: actor.name },
      student_email: actor.email,
      student_number: actor.studentId,
      status: "pending",
      message: typeof body.message === "string" ? body.message : null,
      created_at: now,
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      lock_version: 1,
    });
    course.actions.unshift({
      id: `join:${jrId}`,
      source_id: jrId,
      type: "join_request",
      priority: "urgent",
      status: "pending",
      title: `${actor.name}申请加入${course.name}`,
      description: `学号 ${actor.studentId ?? "-"} 请求加入班级`,
      course_id: course.id,
      group_id: null,
      project_id: null,
      subject_user_id: actor.id,
      href: `/teacher/courses/${course.id}/actions`,
      available_actions: [
        { key: "approve", label: "同意加入", requires_reason: false, confirm_text: null, style: "primary" },
        { key: "reject", label: "拒绝", requires_reason: true, confirm_text: null, style: "danger" },
      ],
      created_at: now,
      handled_at: null,
      handled_by: null,
      decision: null,
      decision_reason: null,
    });
    return ok({ status: "pending", course_id: course.id, request_id: jrId }, 201);
  }
  const joinDecision = path.match(/^\/api\/v1\/course-joins\/([^/]+)\/decision$/);
  if (joinDecision && method === "POST") {
    const reqIdParam = decodeURIComponent(joinDecision[1]);
    for (const c of store.courses.values()) {
      const jr = c.joinRequests.find((j) => j.id === reqIdParam);
      if (!jr) continue;
      const guard = ensureCourseStaff(c, actor, options.taPermissions, "approve_joins");
      if (!guard.ok) return guard.res;
      if (Number(body.expected_version) !== jr.lock_version) {
        return err(409, "VERSION_CONFLICT", "申请版本冲突", { current_version: jr.lock_version });
      }
      if (jr.status !== "pending") return err(409, "JOIN_REQUEST_DECIDED", "申请已处理");
      const act = c.actions.find((a) => a.source_id === jr.id);
      if (act) {
        const res = applyActionDecision(c, act, body.decision === "approve" ? "approve" : "reject", typeof body.reason === "string" ? body.reason : undefined, actor, guard.perms, store);
        if (res.status >= 400) return res;
      } else {
        jr.status = body.decision === "approve" ? "approved" : "rejected";
        jr.decided_by = actor.id;
        jr.decided_at = now;
        jr.decision_reason = typeof body.reason === "string" ? body.reason : null;
        jr.lock_version += 1;
      }
      return ok(jr);
    }
    return err(404, "NOT_FOUND", "入班申请不存在");
  }
  const invDecision = path.match(/^\/api\/v1\/group-invitations\/([^/]+)\/decision$/);
  if (invDecision && method === "POST") {
    const invId = decodeURIComponent(invDecision[1]);
    for (const c of store.courses.values()) {
      const inv = c.groupInvitations.find((i) => i.id === invId);
      if (!inv) continue;
      const guard = ensureCourseStaff(c, actor, options.taPermissions, "manage_groups");
      if (!guard.ok) return guard.res;
      if (Number(body.expected_version) !== inv.lock_version) {
        return err(409, "VERSION_CONFLICT", "邀请版本冲突", { current_version: inv.lock_version });
      }
      const act = c.actions.find((a) => a.source_id === inv.id);
      if (act) {
        const res = applyActionDecision(c, act, body.decision === "approve" ? "approve" : "reject", typeof body.reason === "string" ? body.reason : undefined, actor, guard.perms, store);
        if (res.status >= 400) return res;
      } else {
        inv.status = body.decision === "approve" ? "approved" : "rejected";
        inv.decided_at = now;
        inv.lock_version += 1;
      }
      return ok(inv);
    }
    return err(404, "NOT_FOUND", "邀请不存在");
  }
  const mcDecide = path.match(/^\/api\/v1\/membership-changes\/([^/]+)\/decide$/);
  if (mcDecide && method === "POST") {
    const mcId = decodeURIComponent(mcDecide[1]);
    for (const c of store.courses.values()) {
      const mc = c.membershipChanges.find((x) => x.id === mcId);
      if (!mc) continue;
      const guard = ensureCourseStaff(c, actor, options.taPermissions, "approve_changes");
      if (!guard.ok) return guard.res;
      if (Number(body.expected_version) !== mc.lock_version) {
        return err(409, "VERSION_CONFLICT", "成员变更版本冲突", { current_version: mc.lock_version });
      }
      const decision = String(body.decision ?? "");
      if (decision === "needs_info") {
        mc.status = "needs_info";
        mc.teacher_comment = typeof body.comment === "string" ? body.comment : null;
        mc.lock_version += 1;
        return ok(mc);
      }
      const act = c.actions.find((a) => a.source_id === mc.id);
      if (act) {
        const res = applyActionDecision(c, act, decision === "approve" ? "approve" : "reject", typeof body.comment === "string" ? body.comment : undefined, actor, guard.perms, store);
        if (res.status >= 400) return res;
      }
      return ok(mc);
    }
    return err(404, "NOT_FOUND", "成员变更不存在");
  }

  // /api/v1/courses/{id}/* routes
  m = path.match(/^\/api\/v1\/courses\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const cid = decodeURIComponent(m[1]);
    const sub = m[2] ? `/${m[2]}` : "";
    const course = store.courses.get(cid);
    if (!course) return err(404, "COURSE_NOT_FOUND", "班级不存在");

    if (sub === "/join-requests" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const st = url.searchParams.get("status") ?? "pending";
      const items = st === "all" ? course.joinRequests : course.joinRequests.filter((j) => j.status === st);
      return ok({ items, total: items.length, page: 1, page_size: 20 });
    }
    if (sub === "/join-policy" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      return guard.ok ? ok({ course_id: course.id, mode: course.join_mode, lock_version: course.lock_version }) : guard.res;
    }
    if (sub === "/join-policy" && method === "PUT") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions, "approve_joins");
      if (!guard.ok) return guard.res;
      if (Number(body.expected_version) !== course.lock_version) {
        return err(409, "VERSION_CONFLICT", "版本冲突", { current_version: course.lock_version });
      }
      course.join_mode = body.mode === "approval" ? "approval" : "direct";
      course.lock_version += 1;
      return ok({ course_id: course.id, mode: course.join_mode, lock_version: course.lock_version });
    }
    if (sub === "/group-invitations" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      return guard.ok ? ok(course.groupInvitations.filter((i) => i.status === "awaiting_teacher")) : guard.res;
    }
    if (sub === "/membership-changes" && method === "GET") {
      const guard = ensureCourseStaff(course, actor, options.taPermissions);
      if (!guard.ok) return guard.res;
      const st = url.searchParams.get("status") || "";
      return ok(st ? course.membershipChanges.filter((x) => x.status === st) : course.membershipChanges);
    }
    if (sub === "/groups" && method === "GET") {
      const myGroup = course.groups.find((g) => g.member_ids.includes(actor.id));
      return ok({
        items: course.groups.map((g) => {
          const leader = g.leader_id ? course.roster.find((s) => s.id === g.leader_id) : undefined;
          return {
            id: g.id,
            course_id: course.id,
            name: g.name,
            direction: g.direction,
            leader: leader ? { id: leader.id, name: leader.name } : null,
            member_count: g.member_ids.length,
            max_group_size: g.max_group_size,
            is_mine: g.member_ids.includes(actor.id),
            full: g.member_ids.length >= g.max_group_size,
            lock_version: g.lock_version,
          };
        }),
        my_group_id: myGroup?.id ?? null,
        formation_open: course.status === "active",
        formation_deadline: course.formation_deadline,
      });
    }
    if (sub === "/groups" && method === "POST") {
      const gName = String(body.name ?? "").trim();
      if (!gName) return err(422, "VALIDATION_ERROR", "小组名称不能为空");
      const newGrp: GroupRecord = {
        id: store.nextUuid("20000000"),
        course_id: course.id,
        name: gName,
        direction: typeof body.direction === "string" ? body.direction : null,
        leader_id: actor.id,
        member_ids: [actor.id],
        max_group_size: course.max_group_size,
        roster_frozen: false,
        project_id: null,
        lock_version: 1,
        locked_reason: null,
      };
      course.groups.push(newGrp);
      const stu = course.roster.find((s) => s.id === actor.id);
      if (stu) {
        stu.group_id = newGrp.id;
        stu.status = "grouped";
        stu.is_leader = true;
      }
      return ok({
        id: newGrp.id,
        course_id: course.id,
        name: newGrp.name,
        direction: newGrp.direction,
        leader: { id: actor.id, name: actor.name },
        member_count: 1,
        max_group_size: newGrp.max_group_size,
        is_mine: true,
        full: false,
        lock_version: newGrp.lock_version,
        members: [{ id: actor.id, name: actor.name, role: "leader", joined_at: now }],
        invitations: [],
        leader_change: null,
        formation_open: true,
        project_id: null,
      }, 201);
    }
    if (sub === "/materials" && method === "GET") {
      const stu = course.roster.find((s) => s.id === actor.id && s.status !== "left");
      const isGrouped = Boolean(stu?.group_id);
      const visible = course.materials.filter(
        (mat) => mat.status === "published" && mat.visibility !== "staff" && (mat.visibility !== "grouped" || isGrouped),
      );
      return ok({ course_id: course.id, is_grouped: isGrouped, items: visible.map((mat) => toMaterialItem(course, mat)) });
    }
    const stuMatDl = sub.match(/^\/materials\/([^/]+)\/download$/);
    if (stuMatDl && method === "GET") {
      const mat = course.materials.find((x) => x.id === decodeURIComponent(stuMatDl[1]) && x.status === "published" && x.visibility !== "staff");
      if (!mat) return err(404, "NOT_FOUND", "资料不存在或无权下载");
      const latest = mat.versions[mat.versions.length - 1];
      return {
        status: 200,
        contentType: latest?.mime_type ?? "application/octet-stream",
        headers: { "Content-Disposition": `attachment; filename="${encodeURIComponent(mat.name)}"` },
        rawBody: latest?.content_text ?? mat.name,
      };
    }
    const annRead = sub.match(/^\/announcements\/([^/]+)\/read$/);
    if (annRead && method === "POST") {
      const ann = course.announcements.find((a) => a.id === decodeURIComponent(annRead[1]));
      if (!ann) return err(404, "NOT_FOUND", "公告不存在");
      ann.read_by[actor.id] = now;
      return ok({ announcement_id: ann.id, read: true, read_at: now });
    }
    if (sub === "/appeals" && method === "POST") {
      if (course.status !== "active") {
        return err(409, "COURSE_NOT_ACTIVE", "课程已结课或未激活，当前为只读状态。");
      }
      const inCourse = course.roster.some((s) => s.id === actor.id && s.status !== "left");
      if (!inCourse) {
        return err(403, "COURSE_MEMBER_REQUIRED", "仅本班在籍学生可以发起申诉。");
      }
      const grp = course.groups.find((g) => g.member_ids.includes(actor.id));
      let project: ProjectRecord | undefined;
      if (typeof body.project_id === "string" && body.project_id.trim()) {
        const requestedPid = body.project_id.trim();
        const found = store.projects.get(requestedPid);
        if (!found || found.course_id !== course.id) {
          return err(404, "PROJECT_NOT_FOUND", "项目不存在或不属于本班级。");
        }
        const pGrp = course.groups.find((g) => g.id === found.group_id);
        if (!pGrp || !pGrp.member_ids.includes(actor.id)) {
          return err(403, "PROJECT_MEMBER_REQUIRED", "只能针对自己参与的项目发起申诉。");
        }
        project = found;
      } else {
        project = grp?.project_id ? store.projects.get(grp.project_id) : undefined;
        if (!project) {
          return err(409, "PROJECT_NOT_FOUND", "当前未加入本班已立项项目，无法发起申诉。");
        }
      }
      const title = String(body.title ?? "").trim();
      const content = String(body.content ?? "").trim();
      if (!title || !content) {
        return err(422, "VALIDATION_ERROR", "申诉标题和正文不能为空");
      }
      const appeal = {
        id: store.nextUuid("40000000"),
        course_id: course.id,
        project_id: project.id,
        project_name: project.name,
        group_name: grp?.name ?? null,
        appellant_id: actor.id,
        appellant_name: actor.name,
        student_number: actor.studentId,
        appeal_type: (body.appeal_type === "task" || body.appeal_type === "score" || body.appeal_type === "other" ? body.appeal_type : "contribution") as "contribution" | "task" | "score" | "other",
        title,
        content,
        supplement_text: null,
        evidence: Array.isArray(body.evidence) ? body.evidence.map(String) : [],
        status: "pending" as const,
        resolved_by: null,
        resolver_name: null,
        resolved_at: null,
        created_at: now,
        updated_at: now,
        decisions: [],
      };
      course.appeals.unshift(appeal);
      return ok(appeal, 201);
    }
    if (sub === "/appeals/mine" && method === "GET") {
      return ok(course.appeals.filter((a) => a.appellant_id === actor.id));
    }
  }

  // Storage 3-step upload & Projects baseline / student->teacher flows
  if (method === "POST" && path === "/api/v1/storage/uploads") {
    const scope = body.scope === "course" ? "course" : body.scope === "project" ? "project" : null;
    const scopeId = typeof body.scope_id === "string" ? body.scope_id.trim() : "";
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    const mimeType = typeof body.mime_type === "string" ? body.mime_type.trim() : "";
    const sizeBytes = Number(body.size_bytes ?? 0);
    if (!scope || !UUID_RE.test(scopeId) || !filename || !mimeType || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return err(422, "VALIDATION_ERROR", "上传参数无效");
    }
    const receiptId = store.nextUuid("91000000");
    const normalizedScopeId = scopeId.toLowerCase();
    const uploadUrl = `https://fixture.invalid/storage/v1/object/upload/sign/project-files/${scope}/${normalizedScopeId}/${receiptId}/${encodeURIComponent(filename)}?token=mock-token`;
    const expiresAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    store.storageUploads.set(receiptId, {
      receipt_id: receiptId,
      scope,
      scope_id: normalizedScopeId,
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      status: "pending",
      content_hash: null,
      rejection_reason: null,
      upload_url: uploadUrl,
      uploaded_bytes: 0,
      completed: false,
      expires_at: expiresAt,
    });
    return ok({ receipt_id: receiptId, upload_url: uploadUrl, method: "PUT", expires_at: expiresAt }, 201);
  }
  const uploadComplete = path.match(/^\/api\/v1\/storage\/uploads\/([^/]+)\/complete$/);
  if (uploadComplete && method === "POST") {
    const receipt = store.storageUploads.get(decodeURIComponent(uploadComplete[1]));
    if (!receipt) return err(404, "UPLOAD_NOT_FOUND", "上传凭据不存在");
    if (!receipt.content_hash) {
      return err(409, "UPLOAD_NOT_RECEIVED", "还没有收到文件，请先完成上传。");
    }
    receipt.completed = true;
    receipt.status = "completed";
    receipt.rejection_reason = null;
    return ok({
      receipt_id: receipt.receipt_id,
      scope: receipt.scope,
      scope_id: receipt.scope_id,
      filename: receipt.filename,
      status: receipt.status,
      content_hash: receipt.content_hash,
      size_bytes: receipt.uploaded_bytes || receipt.size_bytes,
      mime_type: receipt.mime_type,
      rejection_reason: receipt.rejection_reason,
    });
  }

  const integrationMatch = path.match(/^\/api\/v1\/a\/projects\/([^/]+)\/(github\/repos|feishu\/chats)$/);
  if (integrationMatch) {
    const pid = decodeURIComponent(integrationMatch[1]);
    const resource = integrationMatch[2];
    const project = store.projects.get(pid);
    if (!project) return err(404, "PROJECT_NOT_FOUND", "项目不存在");
    if (method === "GET") {
      if (resource === "github/repos") return ok(project.githubRepos ?? []);
      return ok(project.feishuChats ?? []);
    }
  }

  if (method === "GET" && path === "/api/v1/projects") {
    const items = Array.from(store.projects.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      course_id: p.course_id,
      group_id: p.group_id,
      lifecycle: p.lifecycle,
      setup_status: p.setup_status,
      lock_version: p.lock_version,
    }));
    return ok({ items, total: items.length });
  }
  m = path.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const pid = decodeURIComponent(m[1]);
    const sub = m[2] ? `/${m[2]}` : "";
    const project = store.projects.get(pid);
    if (!project) return err(404, "PROJECT_NOT_FOUND", "项目不存在");
    const course = store.courses.get(project.course_id);
    const group = course?.groups.find((g) => g.id === project.group_id);
    const members = (group?.member_ids ?? [])
      .map((uid) => course?.roster.find((s) => s.id === uid))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => ({ id: s.id, name: s.name }));
    const metrics = computeProjectMetrics(project);

    if ((sub === "" || sub === "/overview") && method === "GET") {
      return ok({
        id: project.id,
        name: project.name,
        description: project.description,
        course_id: project.course_id,
        group_id: project.group_id,
        setup_status: project.setup_status,
        setup_step: project.setup_step,
        lifecycle: project.lifecycle,
        entry: project.setup_status === "frozen" ? "baseline" : "setup",
        can_edit: true,
        is_leader: group?.leader_id === actor.id,
        final_deadline: course?.project_deadline ?? null,
        stats: {
          task_count: metrics.total_tasks,
          completed_count: metrics.completed_tasks,
          progress: metrics.progress_percent,
          progress_status: "available",
          member_count: members.length,
          milestone_count: metrics.milestones_total,
        },
        next_milestone: project.milestones[0] ?? null,
        members,
        lock_version: project.lock_version,
      });
    }
    if (sub === "/setup" && method === "GET") {
      return ok({
        project_id: project.id,
        name: project.name,
        project_type: project.project_type,
        description: project.description,
        start_date: project.start_date,
        end_date: project.end_date,
        course_deadline: toIsoDateOnly(course?.project_deadline),
        setup_status: project.setup_status,
        setup_step: project.setup_step,
        can_edit: true,
        materials: project.materials,
        lock_version: project.lock_version,
      });
    }
    if (sub === "/setup/basic" && method === "PATCH") {
      if (Number(body.expected_version) !== project.lock_version) {
        return err(409, "VERSION_CONFLICT", "项目版本冲突", { current_version: project.lock_version });
      }
      if (typeof body.name === "string" && body.name.trim()) project.name = body.name.trim();
      if (typeof body.project_type === "string") project.project_type = body.project_type;
      if (typeof body.description === "string") project.description = body.description;
      if (typeof body.start_date === "string") project.start_date = body.start_date;
      if (typeof body.end_date === "string") project.end_date = body.end_date;
      project.lock_version += 1;
      return ok({
        project_id: project.id,
        name: project.name,
        project_type: project.project_type,
        description: project.description,
        start_date: project.start_date,
        end_date: project.end_date,
        course_deadline: toIsoDateOnly(course?.project_deadline),
        setup_status: project.setup_status,
        setup_step: project.setup_step,
        can_edit: true,
        materials: project.materials,
        lock_version: project.lock_version,
      });
    }
    if (sub === "/materials" && method === "GET") return ok(project.materials);
    if (sub === "/materials" && method === "POST") {
      const kind = body.kind === "file" ? "file" : "text";
      const receipt = kind === "file" && typeof body.receipt_id === "string" ? store.storageUploads.get(body.receipt_id) : undefined;
      const title = kind === "file" ? receipt?.filename ?? "上传附件" : String(body.title ?? "补充说明");
      const text = kind === "text" ? String(body.text ?? "") : `Extracted text from ${title}`;
      const mat = {
        id: store.nextUuid("33000000"),
        kind: kind as "text" | "file",
        title,
        extract_status: "ready" as const,
        extract_reason: null,
        text_length: text.length,
        text,
        created_by: { id: actor.id, name: actor.name },
        created_at: now,
      };
      project.materials.push(mat);
      project.last_activity_at = now;
      return ok(mat, 201);
    }
    const projMatOne = sub.match(/^\/materials\/([^/]+)$/);
    if (projMatOne && method === "GET") {
      const mat = project.materials.find((x) => x.id === decodeURIComponent(projMatOne[1]));
      return mat ? ok(mat) : err(404, "NOT_FOUND", "项目资料不存在");
    }
    if (sub === "/c-context" && method === "GET") {
      const isMember = Boolean(group?.member_ids.includes(actor.id));
      const isTeacher = actor.actor === "teacher" || actor.actor === "ta" || course?.owner_id === actor.id;
      if (!isMember && !isTeacher) return err(403, "FORBIDDEN", "没有访问该项目的权限");
      const writable = project.lifecycle === "active" && (!course || course.status === "active");
      const selectorMembers = members.map((mb) => ({ id: mb.id, title: mb.name ?? "成员" }));
      return ok({
        actor: {
          id: actor.id,
          is_leader: group?.leader_id === actor.id,
          is_member: isMember,
          is_teacher: isTeacher,
        },
        project: {
          id: project.id,
          name: project.name,
          lifecycle: project.lifecycle,
          setup_status: project.setup_status,
        },
        permissions: {
          can_capture_evidence: writable && isMember,
          can_discuss: isMember || isTeacher,
          can_manage_activity: writable && (isMember || isTeacher),
          can_manage_files: writable && (isMember || isTeacher),
        },
        members: selectorMembers,
        modules: [{ id: "36000000-0000-0000-0000-000000000001", title: "核心模块" }],
        milestones: project.milestones.map((ms) => ({ id: ms.id, title: ms.title })),
        requirements: [{ id: "37000000-0000-0000-0000-000000000001", title: "支持小组任务拆解与进度同步" }],
        tasks: project.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          description: null,
          can_associate: writable && isMember,
          can_capture_evidence: writable && isMember,
          criteria: [
            {
              id: deterministicUuid(`c-criterion:${project.id}:${t.id}:0`),
              text: "完成接口与单测验收",
            },
          ],
        })),
        evidence_authors: selectorMembers,
        mention_targets: selectorMembers,
      });
    }
    if (sub === "/setup/requirements" && method === "GET") {
      const modId = "36000000-0000-0000-0000-000000000001";
      const reqIdVal = "37000000-0000-0000-0000-000000000001";
      return ok({
        project_id: project.id,
        setup_status: project.setup_status,
        setup_step: project.setup_step,
        editable: project.setup_status !== "frozen",
        latest_run: null,
        modules: [
          {
            id: modId,
            name: "核心模块",
            description: "工作台核心业务模块",
            owner: members[0] ?? null,
            origin: "manual",
            requirement_count: 1,
            lock_version: 1,
          },
        ],
        requirements: [
          {
            id: reqIdVal,
            code: null,
            module_id: modId,
            title: "支持小组任务拆解与进度同步",
            description: "支持按里程碑关联任务并计算加权进度。",
            priority: "high",
            status: "confirmed",
            origin: "manual",
            edited_by_human: true,
            excluded: false,
            sources: [],
            lock_version: 1,
          },
        ],
        conflicts: [],
        open_conflicts: 0,
      });
    }
    if (sub === "/plan" && method === "GET") {
      const modId = "36000000-0000-0000-0000-000000000001";
      const reqIdVal = "37000000-0000-0000-0000-000000000001";
      const planId = "39000000-0000-0000-0000-000000000001";
      const myTaskVersions: Record<string, number> = {};
      for (const t of project.tasks) {
        if (t.assignee_ids.includes(actor.id)) myTaskVersions[t.id] = 1;
      }
      return ok({
        project_id: project.id,
        id: planId,
        version_no: 1,
        status: project.setup_status === "frozen" ? "frozen" : "draft",
        lock_version: project.lock_version,
        baseline_required: Boolean(course),
        baseline_frozen: project.setup_status === "frozen",
        baseline_version_no: 1,
        frozen_at: project.last_activity_at,
        tasks: project.tasks.map((t) => ({
          id: t.id,
          code: t.code,
          title: t.title,
          description: t.title,
          module_id: modId,
          parent_task_id: null,
          requirement_ids: [reqIdVal],
          assignees: members.filter((mb) => t.assignee_ids.includes(mb.id)),
          dependency_ids: [],
          milestone_ids: t.milestone_id ? [t.milestone_id] : [],
          priority: "medium",
          weight: t.weight,
          criteria: [
            {
              id: "38000000-0000-0000-0000-000000000001",
              key: "AC-1",
              text: "完成接口与单测验收",
              needs_recheck: false,
            },
          ],
          status: t.status === "done" ? "completed" : t.status,
          progress_percent: t.progress_percent,
          content_version: 1,
          origin: "manual",
          href: `/projects/${project.id}/tasks/${t.id}`,
        })),
        issues: [],
        confirmations: members.map((mb) => ({
          user: mb,
          state: "confirmed",
          confirmed_at: project.last_activity_at,
          task_count: project.tasks.filter((t) => t.assignee_ids.includes(mb.id)).length,
        })),
        my_task_versions: myTaskVersions,
        my_state: "confirmed",
        can_edit: project.setup_status !== "frozen",
        can_lead: group?.leader_id === actor.id,
        root_weight_total: project.tasks.reduce((acc, t) => acc + t.weight, 0),
        modules: [{ id: modId, name: "核心模块" }],
        requirements: [
          {
            id: reqIdVal,
            name: "支持小组任务拆解与进度同步",
            code: "REQ-01",
            module_id: modId,
          },
        ],
        milestones: project.milestones.map((ms) => ({ id: ms.id, name: ms.title })),
        members,
        history: [
          {
            id: planId,
            version_no: 1,
            status: project.setup_status === "frozen" ? "frozen" : "draft",
            frozen_at: project.last_activity_at,
            created_at: project.last_activity_at ?? now,
          },
        ],
      });
    }
    if (sub === "/plan/suggestions" && method === "GET") {
      return ok([]);
    }
    if (sub === "/requirements" && method === "GET") {
      const modId = "36000000-0000-0000-0000-000000000001";
      const reqIdVal = "37000000-0000-0000-0000-000000000001";
      return ok({
        items: [
          {
            id: reqIdVal,
            code: "REQ-01",
            title: "支持小组任务拆解与进度同步",
            module: { id: modId, name: "核心模块" },
            origin: "manual",
            status: "confirmed",
            priority: "high",
            excluded: false,
            version_no: 1,
            task_count: project.tasks.length,
            updated_at: project.last_activity_at ?? now,
          },
        ],
        total: 1,
        page: 1,
        page_size: 20,
        modules: [{ id: modId, name: "核心模块" }],
      });
    }
    if (sub === "/files" && method === "GET") {
      const cat = url.searchParams.get("category") ?? "all";
      const statusParam = url.searchParams.get("status") ?? "";
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const fileType = (url.searchParams.get("file_type") ?? "").trim().toLowerCase();
      const sort = url.searchParams.get("sort") ?? "updated_desc";
      const pageNum = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("page_size") ?? 10)));
      const uploaderId = group?.leader_id ?? members[0]?.id ?? actor.id;
      const mapped = project.logicalFiles.map((lf) => {
        const ext = lf.filename.includes(".") ? lf.filename.split(".").pop()!.toLowerCase() : "";
        const normCategory =
          lf.category === "documents" || lf.category === "images" || lf.category === "exports"
            ? lf.category
            : "documents";
        const normStatus = lf.status === "published" ? "current" : lf.status;
        return {
          id: lf.id,
          file_id: lf.id,
          project_id: project.id,
          name: lf.filename,
          original_name: lf.filename,
          extension: ext,
          content_hash: lf.content_hash ?? deterministicSha256(lf.id),
          mime_type: lf.mime_type ?? "application/pdf",
          size_bytes: lf.size_bytes ?? 24576,
          version_no: lf.version,
          lock_version: 1,
          status: normStatus,
          category: normCategory,
          uploaded_by: uploaderId,
          created_at: lf.created_at,
        };
      });
      const filtered = mapped.filter(
        (item) =>
          (cat === "all" || (cat === "archived" ? item.status === "superseded" : item.category === cat)) &&
          (!statusParam || item.status === statusParam) &&
          (!q || item.name.toLowerCase().includes(q) || item.original_name.toLowerCase().includes(q)) &&
          (!fileType || item.extension === fileType),
      );
      if (sort === "name_asc") filtered.sort((a, b) => a.name.localeCompare(b.name));
      else if (sort === "size_desc") filtered.sort((a, b) => b.size_bytes - a.size_bytes);
      else if (sort === "updated_asc") filtered.sort((a, b) => a.created_at.localeCompare(b.created_at));
      else filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return ok({
        items: filtered.slice((pageNum - 1) * pageSize, pageNum * pageSize),
        total: filtered.length,
        page: pageNum,
        page_size: pageSize,
      });
    }
    if (sub === "/files" && method === "POST") {
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) {
        return err(422, "VALIDATION_ERROR", "Request validation failed.", {
          fields: [{ field: "body.reason", message: "Field required", type: "missing" }],
        });
      }
      const receiptId = typeof body.receipt_id === "string" ? body.receipt_id : "";
      const receipt = receiptId ? store.storageUploads.get(receiptId) : undefined;
      if (
        !receipt ||
        !receipt.completed ||
        receipt.status !== "completed" ||
        receipt.scope !== "project" ||
        receipt.scope_id !== project.id.toLowerCase()
      ) {
        return err(409, "UPLOAD_RECEIPT_INVALID", "上传凭证无效或尚未完成。");
      }
      if (project.logicalFiles.some((f) => f.filename.toLowerCase() === receipt.filename.toLowerCase())) {
        return err(409, "FILE_NAME_EXISTS", "Append a version to the existing logical file.");
      }
      const rawCategory = body.category === undefined ? "documents" : String(body.category);
      if (rawCategory !== "documents" && rawCategory !== "images" && rawCategory !== "exports") {
        return err(422, "VALIDATION_ERROR", "Request validation failed.", {
          fields: [{ field: "body.category", message: "Input should be 'documents', 'images' or 'exports'", type: "literal_error" }],
        });
      }
      const lf: ProjectRecord["logicalFiles"][number] = {
        id: store.nextUuid("34000000"),
        filename: receipt.filename,
        category: rawCategory,
        version: 1,
        status: "draft",
        size_bytes: receipt.uploaded_bytes || receipt.size_bytes || 1024,
        mime_type: receipt.mime_type,
        content_hash: receipt.content_hash ?? deterministicSha256(receipt.receipt_id),
        uploaded_by: actor.id,
        reason,
        created_at: now,
      };
      project.logicalFiles.push(lf);
      project.last_activity_at = now;
      return ok(toFileDetailDto(project, lf, actor.id), 201);
    }
    const projFileOne = sub.match(/^\/files\/([^/]+)$/);
    if (projFileOne && method === "GET") {
      const lf = project.logicalFiles.find((x) => x.id === decodeURIComponent(projFileOne[1]));
      if (!lf) return err(404, "NOT_FOUND", "文件不存在");
      const uploaderId = group?.leader_id ?? members[0]?.id ?? actor.id;
      return ok(toFileDetailDto(project, lf, uploaderId));
    }
    if (sub === "/evidence" && method === "GET") {
      return ok({
        items: [],
        page: 1,
        page_size: 20,
        total: 0,
      });
    }
    if (sub === "/tasks" && method === "GET") {
      const view = (url.searchParams.get("view") ?? "list") as "tree" | "board" | "list";
      const items = project.tasks.map((t) => ({
        id: t.id,
        code: t.code,
        title: t.title,
        module: { id: "mod-1", name: "核心模块" },
        parent_task_id: null,
        assignees: members.filter((mb) => t.assignee_ids.includes(mb.id)),
        priority: "medium",
        weight: t.weight,
        status: t.status,
        progress_percent: t.progress_percent,
        milestone_ids: t.milestone_id ? [t.milestone_id] : [],
        dependency_ids: [],
        dependencies_done: true,
        content_version: 1,
        lock_version: t.lock_version,
        updated_at: now,
        links: {
          detail: `/projects/${project.id}/tasks/${t.id}`,
          submit: `/projects/${project.id}/tasks/${t.id}`,
          evidence: `/projects/${project.id}/tasks/${t.id}`,
          verification: `/projects/${project.id}/tasks/${t.id}`,
        },
        transitions: [],
        blocked_reason: null,
        matched: true,
      }));
      return ok({
        view,
        items,
        total: items.length,
        page: 1,
        page_size: 20,
        lock_version: project.lock_version,
        plan_status: "frozen",
        integrity_issues: [],
        columns: [
          { status: "todo", label: "待开始", count: items.filter((i) => i.status === "todo").length },
          { status: "in_progress", label: "进行中", count: items.filter((i) => i.status === "in_progress").length },
          { status: "done", label: "已完成", count: items.filter((i) => i.status === "done").length },
        ],
        modules: [{ id: "mod-1", name: "核心模块" }],
        members,
        milestones: project.milestones.map((ms) => ({ id: ms.id, name: ms.title })),
      });
    }
  }
  return err(404, "NOT_FOUND", `Unhandled mock API route: ${method} ${path}`);
}

export async function installTeacherWorkbenchMocks(
  page: Page,
  store: TeacherWorkbenchStore = createTeacherWorkbenchStore(),
  options: InstallTeacherWorkbenchMocksOptions = {},
): Promise<TeacherWorkbenchStore> {
  const defaultActor: MockActor = options.actor ?? "teacher";

  await page.route("https://fixture.invalid/**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
      return;
    }
    const url = new URL(req.url());
    const parts = url.pathname.split("/").filter(Boolean);
    const maybeReceiptAtNeg2 = parts.length >= 2 ? parts[parts.length - 2] : "";
    const maybeReceiptAtNeg1 = parts.length >= 1 ? parts[parts.length - 1] : "";
    const receiptId = UUID_RE.test(maybeReceiptAtNeg2) ? maybeReceiptAtNeg2 : maybeReceiptAtNeg1;
    const receipt = store.storageUploads.get(receiptId);
    const rawBuf = req.postDataBuffer();
    const buf = rawBuf ?? Buffer.from(req.postData() ?? "", "utf8");
    if (receipt) {
      receipt.uploaded_bytes = buf.byteLength;
      receipt.content_hash = createHash("sha256").update(buf).digest("hex");
    }
    await route.fulfill({
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        ETag: `"mock-etag-${receiptId}"`,
      },
      body: "",
    });
  });

  await page.route("**/api/v1/**", async (route: Route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const url = new URL(req.url());

    if (options.latencyMs && options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    }

    const override = findMatchingOverride(method, url.pathname, options.errorOverrides);
    if (override) {
      const res = err(override.status, override.code, override.message ?? override.code, override.details ?? null);
      await route.fulfill({
        status: res.status,
        contentType: "application/json; charset=utf-8",
        headers: { "Cache-Control": "private, no-store" },
        body: JSON.stringify(res.body),
      });
      return;
    }

    const actor = await resolveActor(page, req, store, defaultActor);
    const headers = req.headers();
    const isAuthExempt = url.pathname === "/api/v1/auth/password/login";
    const isNoIdem =
      url.pathname === "/api/v1/auth/password/login" ||
      url.pathname === "/api/v1/auth/logout" ||
      url.pathname === "/api/v1/auth/session/refresh" ||
      url.pathname === "/api/v1/storage/uploads" ||
      /^\/api\/v1\/storage\/uploads\/[^/]+\/complete$/.test(url.pathname);

    let idemStorageKey: string | null = null;
    let payloadHash = "";

    if (WRITE_METHODS.has(method) && !isAuthExempt) {
      if (!actor.authenticated) {
        const res = err(401, "UNAUTHENTICATED", "未登录或会话已失效");
        await route.fulfill({ status: res.status, contentType: "application/json", body: JSON.stringify(res.body) });
        return;
      }
      const csrf = headers["x-csrf-token"];
      if (!csrf || csrf !== actor.csrfToken) {
        const res = err(403, "FORBIDDEN", "You do not have permission for this action.", {
          params: { reason: "csrf" },
        });
        await route.fulfill({ status: res.status, contentType: "application/json", body: JSON.stringify(res.body) });
        return;
      }
      if (!isNoIdem) {
        const idemKey = headers["idempotency-key"];
        if (!idemKey || idemKey.length < 1 || idemKey.length > 128) {
          const res = err(422, "VALIDATION_ERROR", "Request validation failed.", {
            fields: [{ field: "header.Idempotency-Key", message: "Field required", type: "missing" }],
          });
          await route.fulfill({ status: res.status, contentType: "application/json", body: JSON.stringify(res.body) });
          return;
        }
        payloadHash = createHash("sha256")
          .update(req.postData() ?? "")
          .digest("hex");
        idemStorageKey = `${actor.id}:${method}:${url.pathname}:${idemKey}`;
        const cached = store.idempotency.get(idemStorageKey);
        if (cached) {
          if (cached.payloadHash !== payloadHash) {
            const conflict = err(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 与先前请求载荷不一致");
            await route.fulfill({
              status: conflict.status,
              contentType: "application/json",
              body: JSON.stringify(conflict.body),
            });
            return;
          }
          await route.fulfill({
            status: cached.status,
            contentType: "application/json; charset=utf-8",
            headers: { "Cache-Control": "private, no-store" },
            body: JSON.stringify(cached.body),
          });
          return;
        }
      }
    }

    const res = await handleApiRoute(method, url, req, actor, store, options);
    if (idemStorageKey && res.body !== undefined && res.status < 500) {
      store.idempotency.set(idemStorageKey, { payloadHash, status: res.status, body: res.body });
    }

    if (res.rawBody !== undefined) {
      await route.fulfill({
        status: res.status,
        contentType: res.contentType ?? "application/octet-stream",
        headers: { "Cache-Control": "private, no-store", ...(res.headers ?? {}) },
        body: res.rawBody,
      });
      return;
    }

    await route.fulfill({
      status: res.status,
      contentType: res.status === 204 ? undefined : "application/json; charset=utf-8",
      headers: { "Cache-Control": "private, no-store", ...(res.headers ?? {}) },
      body: res.status === 204 ? "" : JSON.stringify(res.body ?? {}),
    });
  });

  return store;
}

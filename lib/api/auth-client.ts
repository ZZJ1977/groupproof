/**
 * 有类型的身份接口客户端（浏览器 → 同源 /api/v1/* → FastAPI）。
 * 所有写操作携带会话绑定的 CSRF token；错误按稳定 code 处理，不匹配后端文案。
 */

export type AccountState =
  | "anonymous"
  | "disabled"
  | "profile_required"
  | "email_required"
  | "review_required"
  | "review_pending"
  | "review_rejected"
  | "active";

export interface SessionDTO {
  authenticated: boolean;
  sessionScope?: "onboarding" | "full" | "status_only";
  authMethod?: "password" | "google" | null;
  user?: { id: string; name: string | null; preferredLocale: string };
  accountState?: AccountState;
  loginEmailVerified?: boolean;
  identityConfirmed?: boolean;
  securityComplete?: boolean;
  requiredCompletedCount?: number;
  canEnterWorkspace?: boolean;
  nextAction?: { type: string; href: string };
  csrfToken?: string;
}

export interface ProfileFieldErrors {
  [field: string]: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  fieldErrors: ProfileFieldErrors;
  params: Record<string, unknown>;
  /** 服务端关联标识：展示给用户便于排错（不含敏感信息） */
  requestId: string | null;
  /** 限流倒计时（秒），由服务端时间推导 */
  retryAfterSeconds: number | null;

  constructor(status: number, payload: { code?: string; fieldErrors?: ProfileFieldErrors; params?: Record<string, unknown>; requestId?: string; retryAfterSeconds?: number }) {
    super(payload.code ?? "SERVICE_UNAVAILABLE");
    this.code = payload.code ?? "SERVICE_UNAVAILABLE";
    this.status = status;
    this.fieldErrors = payload.fieldErrors ?? {};
    this.params = payload.params ?? {};
    this.requestId = payload.requestId ?? null;
    this.retryAfterSeconds = payload.retryAfterSeconds ?? null;
  }
}

export interface CapabilitiesDTO {
  google: { enabled: boolean; available: boolean };
  password: { enabled: boolean; available: boolean };
  emailSignup: { enabled: boolean; available: boolean };
  passwordReset: { enabled: boolean; available: boolean };
  schoolEmailVerification: { enabled: boolean; available: boolean };
  /** 验收临时密令（仅非 real）：注册直达资料页 / 验证码直通 */
  acceptanceTest: { enabled: boolean };
}

export interface RegistrationTxDTO {
  id: string;
  email: string;
  status: "pending" | "accepted" | "failed" | "unknown";
  expiresAt: string;
  resendAvailableAt: string | null;
}

/** 验收临时密令（仅非 real）：直接开通测试账户，形状同会话 DTO */
export interface TestEntryDTO extends SessionDTO {
  testEntry: true;
}

async function request<T>(path: string, options: { method?: string; body?: unknown; csrf?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers: {
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    // 网络/代理不可达：与服务端错误区分显示，保留非敏感输入
    throw new ApiError(0, { code: "NETWORK_ERROR" });
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null; // 非 JSON（如代理错误页）→ 通用安全提示
  }
  if (!response.ok) {
    throw new ApiError(response.status, (payload ?? { code: "SERVICE_UNAVAILABLE" }) as { code?: string; requestId?: string; retryAfterSeconds?: number });
  }
  return payload as T;
}

export interface MeDTO {
  user: {
    id: string;
    name: string | null;
    username: string | null;
    studentId?: string | null;
    college?: string | null;
    requestedIdentity?: string | null;
    roles: string[];
    preferredLocale: string;
    version: number;
    googleEmailBound?: boolean;
    passwordLoginEnabled?: boolean;
  };
  schoolEmail: {
    verifiedEmail: string | null;
    verifiedAt: string | null;
    pendingEmail: string | null;
    verified: boolean;
  };
  registration: {
    profileComplete: boolean;
    profileFieldErrors: ProfileFieldErrors;
    schoolEmailVerified: boolean;
    /** 身份确认（学生/教师）：学生=后端准入条件满足；教师=有效审核批准 */
    identityConfirmed: boolean;
    /** 账号安全（可选）：密码凭据+登录邮箱已验证，或纯 Google 可信认证事实 */
    securityComplete: boolean;
    /** 前三项必填进度（0–3）；可选项不计入 */
    requiredCompletedCount: number;
    /** 当前会话能否取得 full 业务范围（与服务端门禁同口径） */
    canEnterWorkspace: boolean;
    loginEmailVerified?: boolean;
    teacherReviewStatus: string | null;
    academicIdentityStatus: "unverified" | "verified" | "rejected" | "stale";
    verificationBasis: { kind: string; at?: string | null; method?: string | null; schoolEmailDomain?: string }[];
    accountState: AccountState;
    nextAction: { type: string; href: string };
  };
  teacherApplication: {
    id: string;
    status: "pending" | "approved" | "rejected";
    applicationVersion: number;
    reviewedAt: string | null;
    reason: string | null;
  } | null;
  studentIdRule: { pattern: string; emailPrefixRule: string; confirmedBySchool: boolean };
}

export interface ChallengeDTO {
  challengeId: string;
  email: string;
  expiresAt: string;
  resendAvailableAt: string;
  sendStatus: "accepted" | "failed";
}

export const authClient = {
  session: () => request<SessionDTO>("/api/v1/auth/session"),
  logout: (csrf?: string) => request<void>("/api/v1/auth/logout", { method: "POST", csrf }),
  refresh: (csrf?: string) => request<SessionDTO>("/api/v1/auth/session/refresh", { method: "POST", csrf }),
  googleStartUrl: (returnTo?: string) => `/api/v1/auth/google/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
  passwordLogin: (identifier: string, password: string) =>
    request<SessionDTO>("/api/v1/auth/password/login", { method: "POST", body: { identifier, password } }),
  capabilities: () => request<CapabilitiesDTO>("/api/v1/auth/capabilities"),
  startEmailRegistration: (email: string, locale?: string) =>
    request<RegistrationTxDTO | TestEntryDTO>("/api/v1/auth/email/registrations", { method: "POST", body: { email, locale } }),
  resendEmailRegistration: (txId: string, locale?: string) =>
    request<RegistrationTxDTO>(`/api/v1/auth/email/registrations/${txId}/resend`, { method: "POST", body: { email: "", locale } }),
  verifyEmailRegistration: (txId: string, code: string) =>
    request<{ verified: boolean; email: string; creationGrantExpiresAt: string }>(`/api/v1/auth/email/registrations/${txId}/verify`, { method: "POST", body: { code } }),
  completeEmailRegistration: (txId: string, username: string, password: string) =>
    request<SessionDTO | { status: "already_completed" }>(`/api/v1/auth/email/registrations/${txId}/complete`, { method: "POST", body: { username, password } }),
  forgotPassword: (email: string, locale?: string) =>
    request<{ status: string }>("/api/v1/auth/password/forgot", { method: "POST", body: { email, locale } }),
  resetPassword: (token: string, newPassword: string) =>
    request<{ status: string }>("/api/v1/auth/password/reset", { method: "POST", body: { token, newPassword } }),
  loginEmailChallenge: (csrf: string) =>
    request<ChallengeDTO | { verified: true }>("/api/v1/me/login-email/challenges", { method: "POST", body: {}, csrf }),
  loginEmailVerify: (csrf: string, challengeId: string, code: string) =>
    request<MeDTO | { verified: true }>(`/api/v1/me/login-email/verify`, { method: "POST", body: { challengeId, code }, csrf }),
  changePassword: (csrf: string, currentPassword: string, newPassword: string) =>
    request<{ changed: boolean }>("/api/v1/me/password", { method: "POST", body: { currentPassword, newPassword }, csrf }),
  me: () => request<MeDTO>("/api/v1/me"),
  updateProfile: (csrf: string, body: Record<string, unknown>) =>
    request<MeDTO>("/api/v1/me/profile", { method: "PATCH", body, csrf }),
  preferences: (csrf: string, preferredLocale: string) =>
    request<{ preferredLocale: string }>("/api/v1/me/preferences", { method: "PATCH", body: { preferredLocale }, csrf }),
  createChallenge: (csrf: string) => request<ChallengeDTO>("/api/v1/me/school-email/challenges", { method: "POST", body: {}, csrf }),
  verifyChallenge: (csrf: string, challengeId: string, code: string) =>
    request<MeDTO>("/api/v1/me/school-email/verify", { method: "POST", body: { challengeId, code }, csrf }),
  requestEmailChange: (csrf: string, schoolEmail: string, expectedVersion: number) =>
    request<MeDTO>("/api/v1/me/school-email/change", { method: "POST", body: { schoolEmail, expectedVersion }, csrf }),
  submitTeacherApplication: (csrf: string, expectedVersion: number) =>
    request<MeDTO>("/api/v1/me/teacher-application", { method: "POST", body: { expectedVersion }, csrf }),
};

/** 统一错误 → 词条 key（errors.* 或 account.*.errors.*） */
export function errorKey(error: unknown, namespace: "errors" | "account.profile.errors" | "account.email.errors" = "errors"): string {
  if (error instanceof ApiError) {
    if (namespace !== "errors" && Object.keys(error.fieldErrors).length) {
      const first = Object.values(error.fieldErrors)[0];
      return `${namespace}.${first}`;
    }
    return `${namespace}.${error.code}`;
  }
  return `${namespace}.SERVICE_UNAVAILABLE`;
}

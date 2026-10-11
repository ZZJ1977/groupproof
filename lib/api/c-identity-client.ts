import { ApiError, authClient } from "./auth-client";

export interface IdentityAdminUser {
  id: string; name: string; studentId: string | null; college: string; roles: string[];
  status: "enabled" | "disabled"; version: number; schoolEmail: string | null;
  schoolEmailVerified: boolean; canDisable: boolean;
}
export interface IdentityTeacherApplication {
  id: string; userId: string; name: string; college: string; applicationVersion: number;
  status: "pending"; createdAt: string; emailVerified: boolean; emailDomain: string;
}
export interface IdentityAdminPage<T> { items: T[]; total: number; page: number; pageSize: number }

/** Identity IDs stay in the identity service. No canonical UUID guessing. */
async function request<T>(path: string, body?: unknown, actorId?: string): Promise<T> {
  const session = body === undefined ? null : await authClient.session();
  if (session && (!session.authenticated || !session.csrfToken || !actorId || session.user?.id !== actorId)) throw new ApiError(401, { code: "UNAUTHENTICATED" });
  const response = await fetch(`/api/v1/c-admin${path}`, {
    credentials: "same-origin", cache: "no-store", method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-CSRF-Token": session!.csrfToken! },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new ApiError(response.status, payload ?? { code: "SERVICE_UNAVAILABLE" });
  return payload as T;
}

export const cIdentityClient = {
  users: (query: URLSearchParams) => request<IdentityAdminPage<IdentityAdminUser>>(`/users?${query}`),
  disable: (user: IdentityAdminUser, reason: string, actorId: string) => request(`/users/${encodeURIComponent(user.id)}/disable`, { expectedVersion: user.version, reason }, actorId),
  applications: (page: number) => request<IdentityAdminPage<IdentityTeacherApplication>>(`/teacher-applications?page=${page}`),
  review: (row: IdentityTeacherApplication, decision: "approve" | "reject", reason: string, actorId: string) => request(`/teacher-applications/${encodeURIComponent(row.id)}/review`, {
    expectedVersion: row.applicationVersion, decision, reason,
  }, actorId),
};

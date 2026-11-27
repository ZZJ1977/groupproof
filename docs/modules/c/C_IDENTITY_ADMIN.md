# C7-01/02/03 identity administration

C owns the account directory and review UI. Since merged PR #14 this uses A's
unified identity services in `services/api/app/auth`, with canonical UUID users
and migration 0013. `server/` is historical reference.

## Interface and permission

Pages 51 and 52 live at `admin/pages/IdentityAdminApiPages.tsx` (using
`admin/api/c-identity-client.ts`) and run against real APIs by default. Requests
go to the same-origin `/api/v1/c-admin` routes (`services/api/app/auth/routers/c_admin.py`)
behind the identity proxy. All routes require A's current authenticated Admin
guard. Mutations additionally require A's CSRF check. No client-supplied role or
user override is accepted.

- `GET /users`: literal name, school-email or student-ID search; exact role,
  account status and college filters; ten rows per page. Only directory fields
  are returned, never credentials, recovery fields or provider tokens.
- `POST /users`: admin-created student or teacher account (`identity`, `name`,
  `username`, `schoolEmail`, optional `studentId`/`college`/`submitForReview`).
  No password is generated or returned; the user sets their own password via
  password recovery, and creation is audited (`user.created_by_admin`).
- `POST /users/{id}/disable`: nonblank reason and current `expectedVersion`;
  account versions start at zero, whereas teacher application versions start at one;
  reject self-disable. Lock the target row, then call A's `accounts.disable_user`
  for session revocation, status/version change and audit. Already-disabled or
  conflicting requests cannot create a second mutation.
  When A4-01 is installed, the same transaction writes a system notification with
  the reason to the target account's inbox. The response reports `inboxNotified`.
  Missing A4-01 leaves suspension available. A failure writing an installed inbox
  rolls back the suspension, revocation and audit so an administrator can retry.
- `POST /users/{id}/enable`: restore a disabled account with nonblank `reason`
  and `expectedVersion`, clearing disabled state, incrementing authority version
  and notifying the user.
- `GET /teacher-applications`: status-filtered applications (`pending`, `approved`,
  `rejected`, or `all`; default `pending`), with ten-row SQL pagination. The saved
  application basis/version and decision time/reason are distinct from the current
  profile and school-email verification state. Only pending rows allow a decision.
- `POST /teacher-applications/{id}/review`: reason, decision and current version;
  lock the application, user and email binding. Approval requires a currently
  verified email. Delegate final identity-basis validation and role assignment to
  A's `accounts.review_teacher_application`; do not write roles in the C wrapper.

Responses disable caching. Page queries use the actual identity-service user ID
as their cache scope. Refresh failures hide previously fetched personal data.
Version conflicts retain the typed reason and require refreshing and checking
the current record before another decision. Writes do not optimistically change
the directory or review list.

## Operational notes and boundaries

The C7-03 review list reuses A's `TeacherApplication` history for approved and
rejected views without creating a second store. URL status/page filters and
read-only history keep processed decisions inspectable after the pending list
refreshes.

Account creation (`POST /api/v1/c-admin/users`) and restoration
(`POST /api/v1/c-admin/users/{id}/enable`) are implemented in `app/auth/routers/c_admin.py`
and wired to A's account services; C never bypasses A to mutate roles or sessions
directly. A suspended account cannot log in to read its inbox, and the email
worker skips disabled accounts by design. Teacher review notifications are emitted
by A's account service.

The directory here and the read-only canonical Admin directory now use the same
UUID users. Their response and mutation contracts remain separate. School-email
verification reads A's current binding, not the legacy users timestamp. Enabled
status filters map to non-disabled canonical statuses; disabled maps to disabled.

## Verification

Historical validation: `server/tests/test_c_admin.py` used isolated PostgreSQL migrations, A's
test OIDC provider, real cookies, CSRF and account services. Six new cases passed:
anonymous/non-Admin denial, minimal projection and literal search, reason and
self-disable checks, immediate session revocation and duplicate rejection,
approve/reject reasons and current-role result, and unverified-email refusal.

`e2e/c-identity-api.spec.ts` exercises the API page with intercepted fixtures. It
covers query persistence, reason/version/CSRF submission, permission loss, and
conflict refresh while preserving the reason. Browser fixtures verify UI contracts
and are not production identity integration acceptance.

Current regression: `services/api/tests/test_c_auth_verification_integration.py`
uses SQLite, A's actual email-binding and session functions, Cookie/CSRF HTTP
requests and canonical C services. It covers status filters, version-zero disable,
session revocation, teacher-version rejection, current email proof and no legacy
fallback. Run with the canonical API's pinned dependencies. Full PostgreSQL and
frontend results belong in `C_DELIVERY.md`.

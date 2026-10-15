# C7-01/02/03 identity administration

C owns the account directory and review UI. Since merged PR #14 this uses A's
unified identity services in `services/api/app/auth`, with canonical UUID users
and migration 0013. `server/` is historical reference.

## Interface and permission

Enable `NEXT_PUBLIC_API_FEATURES=cidentity=real` to use pages 51 and 52. Requests
go to the same-origin `/api/v1/c-admin` routes behind the existing identity proxy.
All routes require A's current authenticated Admin guard. Mutations additionally
require A's CSRF check. No client-supplied role or user override is accepted.

- `GET /users`: literal name, school-email or student-ID search; exact role,
  account status and college filters; ten rows per page. Only directory fields
  are returned, never credentials, recovery fields or provider tokens.
- `POST /users/{id}/disable`: nonblank reason and current `expectedVersion`;
  account versions start at zero, whereas teacher application versions start at one;
  reject self-disable. Lock the target row, then call A's `accounts.disable_user`
  for session revocation, status/version change and audit. Already-disabled or
  conflicting requests cannot create a second mutation.
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

## Explicit remaining dependencies

The C7-03 follow-up reuses A's existing `TeacherApplication` history for the
approved/rejected views. It does not create a second review store or rewrite A's
decisions. URL status/page filters and read-only history keep processed decisions
inspectable after the pending list refreshes. See `C_DELIVERY.md` for validation.

Account restoration and account creation are unavailable because A does not yet
provide matching identity lifecycle functions. C does not bypass A by inserting
accounts, assigning roles, or reactivating sessions itself. Notification delivery
after disable and review still requires A4-01. This partial implementation does
not close the whole C7-02 task.

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

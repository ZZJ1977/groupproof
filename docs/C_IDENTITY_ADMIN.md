# C7-01/02/03 identity administration

C owns the account directory and review UI. This slice uses A's existing identity
services in `server/`; it does not invent a mapping to canonical UUID users in
`services/api`. The two migration histories remain independent.

## Interface and permission

Enable `NEXT_PUBLIC_API_FEATURES=cidentity=real` to use pages 51 and 52. Requests
go to the same-origin `/api/v1/c-admin` routes behind the existing identity proxy.
All routes require A's current authenticated Admin guard. Mutations additionally
require A's CSRF check. No client-supplied role or user override is accepted.

- `GET /users`: literal name, school-email or student-ID search; exact role,
  account status and college filters; ten rows per page. Only directory fields
  are returned, never credentials, recovery fields or provider tokens.
- `POST /users/{id}/disable`: nonblank reason and current `expectedVersion`;
  reject self-disable. Lock the target row, then call A's `accounts.disable_user`
  for session revocation, status/version change and audit. Already-disabled or
  conflicting requests cannot create a second mutation.
- `GET /teacher-applications`: pending applications with minimum review context,
  current email verification state and application version.
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

Account restoration and account creation are unavailable because A does not yet
provide matching identity lifecycle functions. C does not bypass A by inserting
accounts, assigning roles, or reactivating sessions itself. Notification delivery
after disable and review still requires A4-01. This partial implementation does
not close the whole C7-02 task.

The directory here is the authoritative identity directory. The independent
canonical Admin directory remains useful for canonical project/course selectors;
its IDs must not be interchanged with these identity IDs.

## Verification

`server/tests/test_c_admin.py` uses actual isolated PostgreSQL migrations, A's
test OIDC provider, real cookies, CSRF and account services. Six new cases passed:
anonymous/non-Admin denial, minimal projection and literal search, reason and
self-disable checks, immediate session revocation and duplicate rejection,
approve/reject reasons and current-role result, and unverified-email refusal.

`e2e/c-identity-api.spec.ts` exercises the API page with intercepted fixtures. It
covers query persistence, reason/version/CSRF submission, permission loss, and
conflict refresh while preserving the reason. Browser fixtures verify UI contracts
and are not production identity integration acceptance.

Windows local test configuration uses the isolated loopback database only:
`PGHOSTADDR=127.0.0.1`, `PGCONNECT_TIMEOUT=5`, `GROUPPROOF_ENV_FILE=NUL`.
Run with the identity service's pinned dependencies, not the canonical API venv.

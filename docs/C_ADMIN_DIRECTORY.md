# C7-01 administrator directory contract

This read-only directory belongs to C in `services/api`. It uses the existing
canonical `User` table and needs no migration. It does not change A's sessions,
roles, teacher-review state or disabled-account behavior.

## Endpoints

- `GET /api/v1/admin/users`: `q`, `name`, `email`, `student_id`, `role`, `status`,
  `college`, `page` and `page_size=10`. All supplied filters combine with AND;
  `q` searches name/username/email/student ID. Search is literal substring matching,
  including `%` and `_`; college/role/status are exact filters.
- `GET /api/v1/admin/users/{user_id}`: minimal account detail by canonical UUID.

Only the currently authenticated, active platform administrator may use either
endpoint. Student, teacher, TA, pending and disabled accounts receive 403;
unmapped production identity receives 401. Project-leader status is a relationship,
not an invented canonical global role. Supported platform-role filters are
`student`, `teacher`, `ta`, `admin`.

Lists are ordered by creation time descending and UUID ascending as the stable
tie-breaker. Pagination always contains at most 10 items and returns its page,
page size and total. Invalid/extra query fields are rejected. No writes are exposed.

List fields: `id`, `name`, `username`, `email`, `student_id`, `college`,
`global_role`, `status`, `email_verified`. Detail additionally includes creation/
update timestamps and lock version. ORM queries explicitly project these fields;
OAuth records, sessions, verification codes and credentials are never loaded into
the response. Responses use the canonical envelope and `Cache-Control: private,
no-store`.

## Frontend integration

`createCClient().adminUsers(query)` and `.adminUser(id)` use generated OpenAPI types.
With `NEXT_PUBLIC_API_FEATURES=admin=real`, `/admin/users` renders the canonical
read-only directory. It preserves filters/page in the URL, scopes query caches to
the signed-in user, hides old rows during loading/errors, and provides retry.
It never combines real responses with `MockData.users` or sends a demo identity
header. The local browser tests intercept these responses with explicit fixtures.

Production enablement still requires A's canonical identity transport and genuine
role propagation through the existing workspace/router gate. The present app's
real login and canonical business identity have separate schemas. Enabling the
feature flag alone does not bridge them. Do not grant access by changing a mock
role to make a failed real request succeed.

C7-02 account mutations and C7-03 teacher reviews remain separate: the existing
identity service has some real operations, but this directory cannot safely invoke
them with canonical UUIDs until the identity contract is reconciled.

## Validation

31 database/HTTP cases cover success, role/status rejection, combined and literal
search, fixed page size, stable ordering, minimal response fields, unknown IDs,
invalid input, development gating and production refusal. They passed both SQLite
and PostgreSQL; the full canonical PG suite passed 302 tests with zero skips.
The frontend client checks and browser directory/403 cases passed separately.

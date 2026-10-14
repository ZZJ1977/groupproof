# C1-02 / C1-03 notification and action-item API boundary

The C inbox is a typed consumer of A4 facts. A's real notification query, delivery,
read mutation and action-item services are not connected: all four default port
methods return explicit 503 errors. C does not insert notification rows, deliver
messages, mutate A tables or mark an action item complete. The existing home
summary still reports notification/action-item counts as unavailable (`null`);
these are not zero counts. The existing `daily_*` implementation is unchanged.

## Routes and ownership

Mount `app.modules.c.inbox_router.router` under `/api/v1`:

- `GET /me/notifications`: combined category/state filters, 10-item default
  pagination, filtered total, whole-inbox total and unread total, snapshot ID and
  inbox version.
- `POST /me/notifications/{notification_id}/read`: notification version, inbox
  version, snapshot ID and `Idempotency-Key` are required.
- `POST /me/notifications/read-all`: inbox version, snapshot ID and key are
  required. This covers the entire snapshot, including other pages/categories.
- `GET /me/action-items`: combined status/type filters and pagination. There is
  deliberately no completion or approval mutation here.

Every request reloads the canonical actor; absent, inactive or unverified users
are denied before calling A. Writes hold the actor row lock. The public request
has no recipient override. Production authentication remains the canonical
A-owned dependency and does not accept demo identities in production.

## A4 integration contract

`get_inbox_port()` defaults to `UnavailableInboxPort`. A provides `notifications`,
`action_items`, `mark_read` and `mark_all_read`. Queries must authorize the current
recipient, apply all filters before pagination and return newest-first/id-stable
ordering and exact totals. Notification counts and inbox version describe one
atomic snapshot, including currently inaccessible content rules owned by A.

C validates page and item recipient IDs, item schema, stable ordering, unique IDs,
page length, filter compliance, snapshot UUID and nonnegative strict counts.
Filtered unread/read totals cannot exceed corresponding whole-inbox counts;
unfiltered totals must equal them. Count truth outside the returned page remains
A's authoritative responsibility; C does not pretend a partial page can compute
the entire inbox.

Read mutations must participate in the supplied SQLAlchemy transaction. A must
lock the recipient inbox, check the snapshot/inbox version and item version,
retain its own audit/replay records and enforce identical-key replay/changed-key
payload conflicts. New deliveries/read changes must reject a stale snapshot with
409. C validates the exact recipient, command key, snapshot, object, operation,
versions, change count and before/after unread count in the receipt before the
shared transaction commits. Invalid receipts and failures roll back the mutation
and its replay record together. A must not commit internally or make irreversible
remote side effects; a remote A service needs a durable coordination protocol.

An unchanged retry may return the original command receipt, but C's page always
queries fresh list/count state after success. A receipt is not a current inbox
snapshot. C creates no production inbox tables or migrations.

## Processing targets

Notifications/actions supply `InboxTarget`, not an arbitrary URL. UUIDs, scope
fields and kinds are validated. Course-scoped targets cannot carry project scope;
project targets cannot carry course scope. Project/baseline/plan targets identify
their own project, and course targets identify their own course. C builds only:

| Target | Route |
| --- | --- |
| Project / task | `/projects/{project}` or `/projects/{project}/tasks/{id}` |
| Verification | `/projects/{project}/tasks/{id}/verification` |
| Evidence / discussion | Project collection with structured selected-object query |
| Baseline / plan | `/projects/{project}/setup` or `/planning` |
| Course / rule change | `/courses/{course}/rules` or `/rule-changes?change={id}` |
| Member change | `/teacher/courses/{course}/member-changes?request={id}` |
| Appeal | `/teacher/courses/{course}/appeals?appeal={id}` |

Action categories have an explicit allowed target-kind mapping; an appeal cannot
point to generic course rules. The destination service must recheck current
resource access when opened. Notification visibility is not permission to its
destination resource. Plaintext titles/descriptions render as React text.

## Real-page entry and validation

`features/c/InboxApiPages.tsx` exports `NotificationsApiPage` and
`ActionItemsApiPage`, consumed through the `inbox=real` feature flag at existing
pages 05/06. `lib/api/c-inbox-client.ts` uses generated OpenAPI types and the
canonical cookie transport. It never sends local workspace actor IDs and rebuilds
navigation from structured targets, ignoring arbitrary returned `href` values.

Filters and pagination persist in URLs. Failed reads do not optimistically mark
notifications read; the same payload preserves its key, and double clicks send
one request. All-read requires confirmation. A 409 disables stale commands until
explicit refresh; 401/403 hides old data/actions. Identity changes remount the
page. No raw snapshot ID or UUID input is exposed to users.

Local validation: **75 SQLite/HTTP tests passed**; scoped Ruff, frontend ESLint
and the full TypeScript check passed. Tests use explicitly named relational
fixture tables representing A's contract. They verify real rollback/replay
persistence but do not claim A delivery, production adapter integration or
PostgreSQL locking coverage. The eight browser contract cases in
`e2e/c-inbox-api.spec.ts` passed **8/8** on the final rerun, included in the current
new API suite's **45/45 passed** result. Filtering-control locator corrections
use observed accessible combobox roles; product assertions remain unchanged.
The inbox fixture explicitly uses SQLite even when another suite is configured
for PostgreSQL; no PostgreSQL result is claimed. The current-batch production
build and daily **4/4** rerun passed. Implementation and handoff are published in
[merged PR #11](https://github.com/ZZJ1977/groupproof/pull/11), with latest CI/review tracked
in [the delivery record](C_DELIVERY.md). C1 acceptance still requires A's actual
notification/action providers and staging validation of the delivered unified identity.

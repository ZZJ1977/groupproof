# C delivery and integration record

Owner: C (杨凯景). Working branch: `C_task`; pull request target: `develop`.

## Sources checked on 2026-10-11

The following Feishu documents were opened directly in the authorized browser.
The assignment and technical specification were read through the document copy
function, rather than relying on their partial anonymous HTML previews.

- [Detailed assignment](https://tcnulppfrs5x.feishu.cn/wiki/RQb3wHm45i3UpXk9iOtcDxmjn7d): modified 2026-10-10 20:03. C1–C7 and the personal-branch section were checked against the supplied assignment.
- [Technical and submission specification v1.0](https://tcnulppfrs5x.feishu.cn/wiki/GkCkwEEpfijf4okZsVQcnUH7nSc): modified 2026-10-09 11:46. Full text read, including API, tests, commits, review and Definition of Done.
- [Database and ER draft](https://tcnulppfrs5x.feishu.cn/wiki/HYWxwo4PgiaQ8ZkuBWRcM4v1n0c): modified 2026-10-10 12:33. Explanatory text read and diagram overview displayed. Individual diagram labels could not all be resolved in the narrow browser preview; detailed schema work uses the repository's `docs/ERD.md`, the source model referred to by this document.

### Conflicts and implementation decisions

- The updated assignment explicitly keeps one branch per member (`C_task`),
  superseding its older footer and the older technical specification's
  one-feature-branch rule. Task IDs remain in English commit subjects and PRs.
- The detailed assignment governs ownership: B owns task planning; C owns task
  execution, evidence and Admin; D owns verification and contribution. The older
  specification's broader C task-CRUD and D audit ownership is not used to expand
  this change's scope.
- The assignment heading says 34 tasks, but C1–C7 enumerate **35** task IDs.
- The technical specification says UTC; the newer ER text and current database
  session use `Asia/Shanghai`. Preserve timezone-aware database columns and
  explicit ISO 8601 offsets; do not introduce naive timestamps or change the
  shared connection policy in a C feature. A should unify the written convention.
- New C business routes use `/api/v1` and the existing canonical success/error
  envelope. Existing readiness endpoints are not renamed.

## Definition of Done and current boundaries

A task is complete only after its UI, API, migration, authorization, error paths,
idempotency, concurrency, tests, documentation, review, CI and staging acceptance
are verified. An API implementation, a mock demonstration or a passing unit test
alone does not satisfy that definition.

Repository baseline: `d68c6156bd89e439ea6176d2deb36f07d1b2a174`.
Baseline frontend typecheck/lint and API Ruff passed. API pytest: 21 passed,
3 PostgreSQL tests skipped without a database URL. This is a baseline result,
not acceptance evidence for new C functionality.

`services/api` is the canonical SQLAlchemy/Alembic business API. `server` is an
independent identity service with an incompatible user/session schema; see
`.env.example`. Do not mix their migration histories or invent a mapping between
mock string IDs and UUID business IDs. The canonical current-user dependency is
still a gated development/test identity adapter; production stays closed until
A delivers real identity integration.

The project owner confirmed on 2026-10-11 that the required A/D interfaces have
not yet been delivered elsewhere. Their absence is a real integration dependency,
not a missing public vendor documentation link.

## Task acceptance ledger

All rows below remain open until the complete Definition of Done is met. Tests
and partial deliverables must be recorded separately from team acceptance.

| ID | C deliverable | Required integration / acceptance |
| --- | --- | --- |
| C1-01 | User-specific home counts and destinations | Real user, project/course reads; counts change after task changes |
| C1-02 | Notification query, pagination, read actions | A4-01; correct unread total; failed writes preserve state |
| C1-03 | Assigned action items and processing links | A4-03; no arbitrary mark-complete button |
| C1-04 | Personal activity filters and original records | Every event resolves to a real accessible object |
| C2-01 | Shared task transitions for B/D | Only sequential transitions; D authority required for completion |
| C2-02 | URL task detail tabs | Refresh, Back and shared links; D result query remains a dependency |
| C2-03 | Assignee-only start and dependency check | Repeated start is idempotent; no cross-project dependencies |
| C2-04 | Progress with reason and weighted rollups | Audit before/after; 100 percent never completes a task |
| C2-05 | One task implementation note with versions | Persistent singleton, immutable version history |
| C2-06 | Evidence source selector and reset | A4-04/A5-07/A6-04; changing source clears prior selections |
| C2-07 | Candidate evidence and criterion links | Immutable source snapshot, correct task ownership, idempotency |
| C2-08 | Persist draft and prepare submission | Transition to pending_submission; hand off to D page 16 |
| C3-01 | URL evidence filters and source links | Task/source/author/criterion/status/search combinations |
| C3-02 | Reasoned candidate adoption | Author/project leader/course teacher; reliable D invalidation |
| C3-03 | Reasoned withdrawal with history | Excluded from verification/contribution/report through D contract |
| C3-04 | Source-changed evidence marker | Trusted A source change notification; history retained |
| C3-05 | Effective formal evidence query for D | Exclude withdrawn, void and changed/unavailable sources |
| C4-01 | GitHub activity query and safe links | A5-07; person/time/task pagination; GitHub-only external links |
| C4-02 | Manual and task-number activity links | A source IDs and B task identifiers; no external OAuth work |
| C4-03 | Feishu group/status queries | A6-04 and actual connection status |
| C4-04 | Adopt/ignore/restore Feishu records | Reasoned, idempotent candidate creation |
| C5-01 | File filters and pagination | Membership enforced; filters survive refresh |
| C5-02 | Upload/preview/download | A4-04 signed URLs and real object bytes; no metadata-only success |
| C5-03 | File versions and official designation | Old versions retained, reason and member notification |
| C5-04 | Teacher course-file publication/replacement | A storage; B frozen-project version pinning |
| C6-01 | Linked discussions | Idempotent creation, member notification, discard confirmation |
| C6-02 | Concurrent replies and mentions | Correct thread; both replies persist; A4-01 notification |
| C6-03 | Important discussion marks | Persist and expose as evidence source |
| C7-01 | Minimal Admin user search | All required filters; page size 10; Admin authorization |
| C7-02 | Disable/restore/create users | A identity invalidation; reason; no self-disable; notification |
| C7-03 | Teacher application review | A3-03 verified identity; reason on rejection |
| C7-04 | Course draft/publish/end | Unique code, sequential status, invite on publication |
| C7-05 | Read-only audit search and detail | A4-02; before/after/reason; no edit or delete route |
| C7-06 | AI usage aggregation | A7-02; real 7/30/90-day records, no fabricated trends |
| C7-07 | Scoped expiring access decisions | A authorization enforcement; reason; idempotency; expiry |

## Handoff dependencies

| Provider | Contract needed by C | Behavior before delivery |
| --- | --- | --- |
| A3 | Verified session -> canonical UUID user; membership helpers | No production demo-header fallback |
| B | Real task/criterion IDs, definition versions and project context | Do not translate `task-1` into invented UUIDs |
| A4-01/02/03 | Notifications, append-only audit, assigned action items | No synthetic notifications/audit presented as production |
| A4-04 | Validated upload/download URLs and stored-file receipts | Explicit unavailable; no fake successful upload |
| A5-07/A6-04 | Authorized source queries and stable original snapshots | Explicit unavailable; no direct vendor credentials in C |
| D | Verification queries, authoritative completion decision | Completion fails closed without D approval |
| D | Evidence-changed event consumer | Durable pending event; do not claim downstream invalidation delivered |

Official integration documentation is useful to A but does not provide these
GroupProof-specific functions: [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps),
[Feishu message history](https://open.feishu.cn/document/server-docs/im-v1/message/list),
[Supabase Storage](https://supabase.com/docs/guides/storage).

## Validation and review record

Append verified commands and their results here as each C slice is delivered.
Do not mark the ledger complete on the basis of generated code alone.

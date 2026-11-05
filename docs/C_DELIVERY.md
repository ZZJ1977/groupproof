# C delivery and integration record

Owner: C (杨凯景). Working branch: `C_task`; pull request target: `develop`.

Current follow-up (2026-11-01): PR #17 is merged. `C_task` has been fast-forwarded
to `develop` `302bf4e`, including Google linking and D/OAuth migrations 0014/0015.
The current batch adds Google-to-C HTTP and real-browser integration coverage,
data-preserving migration regressions, and repairs the missing CSRF check on
canonical business writes. Scope and reproducible commands are recorded below;
the current PR checks are the authority for executed PostgreSQL/browser results.

Previous snapshot (2026-10-15): PRs #9–#12 and #16 are merged. Team PR #14 unified
authentication into the canonical API. This follow-up starts at `22c0d1a` and
reuses A's existing persisted authentication events and teacher applications for
C7-05/C7-03. The preceding [C functional audit](reviews/2026-10-14-c-function-audit.md)
was delivered in PR #16; its final CI passed 869 backend tests, 121 C browser cases,
733 C script assertions, frontend quality/build and Docker smoke checks.
There is partial code/contract coverage for **35/35 C task IDs, not 35 accepted
tasks**. Historical commit/test counts below describe their original batches.
All complete team acceptance rows remain open until staging verification.

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

`services/api` now owns both canonical business data and authentication through
`app/auth` and migration 0013. `server/` is historical reference, not C's runtime
identity provider. C uses actual session UUIDs and the current verified
`SchoolEmailBinding`; legacy `users.email_verified_at` is not a fallback proof.
No mock-to-UUID mapping or production demo-header bypass is introduced.

The project owner's 2026-10-11 dependency report is historical: A has since
delivered unified identity. External source/storage/inbox/audit/usage/access
providers and D's acceptance consumers remain integration dependencies, not
missing public vendor documentation links.

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
| A3 | Unified session and current school-email proof are implemented; staging validation remains | No production demo-header fallback; verification revocation denies writes |
| B | Real task/criterion IDs, definition versions and project context; invitation/join and course lifecycle coordination | No invented UUIDs; C invitation resolution does not create enrollment or finish B lifecycle integration |
| A4-01/02/03 | Notifications, append-only audit, assigned action items | No synthetic notifications/audit presented as production |
| A4/A7 | Transactional notification read receipts and actual timestamped usage source | Unconnected providers return 503; missing counters/costs are not zero or estimates |
| A4-04 | Validated upload/download URLs and stored-file receipts | Explicit unavailable; no fake successful upload |
| A5-07/A6-04 | Authorized source queries and stable original snapshots | Explicit unavailable; no direct vendor credentials in C |
| A | Scoped access activation receipt and expiry/revocation enforcement | C approval history is not a substitute for actual A authorization |
| D | Verification queries, authoritative completion decision | Completion fails closed without D approval |
| D | Evidence-changed event consumer | Durable pending event; do not claim downstream invalidation delivered |

Official integration documentation is useful to A but does not provide these
GroupProof-specific functions: [GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps),
[Feishu message history](https://open.feishu.cn/document/server-docs/im-v1/message/list),
[Supabase Storage](https://supabase.com/docs/guides/storage).

## Validation and review record

### First implementation slice (2026-10-11)

- C2-01/03/04: canonical execution service, assignee-only idempotent start,
  dependency checks, frozen-plan membership, versioned progress with reason,
  weighted rollups and transaction rollback. Completion remains gated by a
  trusted D adapter. See [execution contract](C_TASK_EXECUTION.md).
- C2-05/07 and C3-01–05: PostgreSQL evidence and note models, migration 0007,
  immutable snapshots and note versions, candidate/adopt/withdraw/source-change
  commands, effective-evidence queries, project permissions, optimistic versions,
  idempotency and transactional pending events. See [evidence contract](C_EVIDENCE.md).
- C2-02/06 and C3-01 UI: URL-backed tabs and combined evidence filters; safe
  original-source links; resetting all source-specific fields; candidate creation
  preserves task status. File upload is explicitly unavailable until storage exists.
- Generated OpenAPI types and `lib/api/c-client.ts` expose the canonical routes.
  This client is not enabled in mock-ID workspace pages. A must connect verified
  identity and B must deliver canonical project/task/criterion IDs first.
- Added isolated browser fixtures and CI steps for the C tests. The existing
  anonymous login suite keeps its separate identity fixture. CI database variables
  enable the seven C PostgreSQL-only tests rather than silently skipping them.

Verified frontend checks: full lint, typecheck, production build, 56 route mappings,
43 URL/filter assertions, 51 source-flow assertions, 18 API-client contract
assertions, 53 existing permission assertions and 40 existing workflow assertions.
Six Playwright cases passed across the URL and source-flow suites. These exercise
explicit mock workspace data, not real third-party integration or production login.

The first real PostgreSQL run passed 175 tests with zero skips. Empty-database
migration 0001→0007, `alembic check`, and 0007→0006→0007 rollback/reapply passed.
Ruff check and format checks passed. An independent review then identified and
prompted regression fixes for adoption after plan unlock, adapter-provided unsafe
URLs, and malformed HTTP-200 client envelopes; final rerun results are recorded below.

After those fixes, the full API suite on real PostgreSQL passed **201 tests with
zero skips** (26.12 seconds); the 81 evidence/note/HTTP/concurrency cases also
passed separately. The new regression cases cover rejected adapter URLs and
adoption after plan unlock; withdrawing existing evidence remains permitted.

### Outstanding scope at the first-slice checkpoint

This delivery is **not completion of all C tasks**. C1 and C4/C5/C7 remain in the open
ledger. The existing mock
implementation-note UI still represents the note as manual evidence because D's
mock completeness/verification screens depend on that representation; it has not
been switched to the new versioned note API. Task detail verification still awaits
D's real query. The source adapters return explicit 503 until A implements them;
pending outbox records are durable but have no delivery worker or D consumer yet.
Production identity, file bytes, real synchronization, downstream invalidation,
team review and staging acceptance have not been verified.

All 35 task rows therefore remain open; the code and tests above are inspectable
partial deliverables, not fabricated completion or contribution scores.

### Submission, discussions and daily entries (2026-10-11)

- C2-08 now exposes `POST /api/v1/tasks/{id}/prepare-submission`: optional note
  draft, task state, audit and idempotent response save in one transaction. Empty
  evidence/notes may proceed to D's completeness check; this does not approve them.
  Task and note version conflicts roll back everything. Its 32 tests passed on
  PostgreSQL, including competing and repeated submissions.
- C6-01/02/03 adds persistent linked discussions, independent replies, mentions,
  important decisions with reasons and immutable sources. A reply or importance
  change immediately marks linked C evidence as source-changed in the same
  transaction. A notifications and D downstream processing remain pending events.
  See [discussion handoff](C_DISCUSSIONS.md).
- Migration 0008 creates discussion tables and permits the discussion source type.
  Upgrade, schema check and empty-table downgrade/reapply passed. A PG test verifies
  that downgrade refuses to delete existing discussions even without linked evidence.
- C6 UI supports four same-project references, guarded duplicate actions, per-thread
  reply drafts, discard confirmation, reasons for importance, failed-save recovery
  and immutable candidate snapshots. 76 command assertions and four browser cases
  passed. Candidate creation does not modify D verification records.
- C1 UI removes arbitrary action-item completion and fabricated weekly growth;
  notifications/actions/activity tabs persist in URLs. Two browser cases passed.
  The real A notification/action services and server-side home statistics remain pending.
- Canonical client contracts now include submission and discussion routes; 25 client
  assertions passed. All 271 API tests passed on real PostgreSQL with zero skips;
  Ruff checked and formatted all 73 Python files. Revision is 0008.

The browser checks above use the explicitly isolated mock fixture. Production
identity mapping, canonical workspace loading, signed file storage, GitHub/Feishu
adapters and notification/D event delivery have not become available as a result
of these tests. C6's frontend command queue protects the local demo process;
actual concurrent multi-user persistence is verified separately in PostgreSQL.

### Evidence decisions, activity links and final local checks (2026-10-11)

- C3-02/03 UI now requires a reason and checks author/leader/course-teacher
  eligibility, active membership, baseline/plan state and current evidence version.
  Repeated requests save one decision; failed persistence keeps the reason and
  original state. Decision history and source snapshots remain available after
  withdrawal. Source-changed candidates cannot be adopted. The local command does
  not update D verification/contribution records or claim notification delivery.
- Independent review found no blocking C3 UI issue. All 103 command assertions
  and four browser scenarios passed, including forbidden actors and failed-save
  recovery. The assertions are now required by CI.
- C4-01 activity links accept only HTTPS on the GitHub origin; malformed and
  lookalike-domain links render as unavailable. Its browser regression passed.
  This change does not implement A's repository connection or synchronization.
- Final local frontend lint, typecheck, production build and 56-route mapping
  checks passed. Across the six C browser files, all 17 cases passed in their
  respective runs. These are mock-workspace browser checks, not production E2E.
- Independent integration review confirmed that runtime OpenAPI, its checked-in
  snapshot and regenerated TypeScript agree. The 25 client assertions passed.
  CI includes all five C command/client scripts and all six C browser files.
- The first two batches were submitted through [PR #9](https://github.com/ZZJ1977/groupproof/pull/9)
  from `C_task` to `develop`. Commits identify their task IDs and contain actual
  implementation, regression tests or handoff documentation; no empty activity
  commits are used. PR #9 was subsequently merged on 2026-10-12 (Asia/Shanghai)
  as `01c2bb43903c11655663ddc83e3569235b5c3ce4`. That merge alone does not prove
  production integration or clean-database staging acceptance.

### Follow-up audit and implementation (2026-10-12)

The earlier batch ended after its checks; that was not evidence that all remaining
C work was blocked. [Remaining-work audit](C_REMAINING_WORK.md) separates independent
implementation from actual A/B/D integration dependencies. Existing `server/`
account disable and teacher-review capabilities are team baseline, not new C work.

- C1-02: atomic local single/all-read operations, ten-item pagination, correct
  unread totals, timestamp ordering across offsets, and failed-save recovery.
  C1 real workspace mode explicitly reports unavailable instead of presenting
  fallback seed records as real data. Canonical notification persistence is pending.
- C4-01–04: URL filters/pagination; authorized GitHub task-number suggestions and
  manual associations; reasoned Feishu adopt/ignore/restore. Adoption creates one
  candidate with a source snapshot in one local save. A's connection/sync area is
  retained; live ingestion and canonical association persistence are not implemented.
- C5-01/03: scoped project-file filters, sorting and pagination; official-version
  designation requires a reason, current project version and idempotency key. Old
  versions and frozen references remain. Save failure preserves the input.
- C5-04: precise course access, assigned-TA read-only behavior and teacher-only
  reasoned draft/replacement/publication commands. Publication saves history and
  local audit atomically, keeps old versions and leaves B's frozen references intact.
  The page explicitly saves demo metadata, not file bytes or delivered notifications.
- C7-01: canonical Admin-only paginated user list/detail endpoints, literal search
  and minimal DTO projection; typed client and real-mode read-only UI. API errors
  never merge mock users. Production session/role mapping is still A's dependency.
  See [Admin directory contract](C_ADMIN_DIRECTORY.md).
- C7-06: removed invented window totals, trends and health assertions. Missing
  timestamped usage remains unavailable; this is not a completed usage API.

Verification: full PostgreSQL **302 passed, zero skipped**, including 31 new Admin
directory cases; Ruff lint and format checks passed for all 77 Python files.
Frontend lint, typecheck, production build and 56 route mappings passed.
Ten C scripts verify 43 URL + 51 source + 31 client + 76 discussion + 103 evidence
+ 25 notification + 69 file-filter + 78 file-decision + 127 activity-record
+ 83 course-file assertions (686 total). All 36 browser scenarios passed across
the full run and a targeted rerun after correcting ambiguous test locators; no
product behavior was weakened for those assertions. Final remote CI is recorded
in PR #9. Test fixtures and intercepted directory responses do not prove
production login, real storage, external synchronization or staging acceptance.

At the end of PR #9, all 35 complete task acceptance rows remained open. The
next batch below implements the independent canonical C1/C4/C5 work identified
in that audit; C7 course lifecycle and access approvals can also continue.

### Canonical daily reads, source decisions and project files (2026-10-12)

This batch starts from merged `origin/develop` at `01c2bb4` on the existing
`C_task` branch. It does not modify `main` or merge its own PR.

- C1-01/04: current-user home counts, canonical weighted task-tree progress and
  a paginated union of actual progress, note, evidence and discussion history.
  Current membership and source-object existence control every read; Admin does
  not inherit access to all projects. Notifications, actions and external feeds
  remain explicitly unavailable. Independent `daily=real` pages use server DTOs,
  retain URL filters and hide old data after permission/errors or while refetching.
  See [daily read contract](C_DAILY_READS.md).
- C4-01–04: authorized A source-query protocol, combined filters before pagination,
  persistent task links and Feishu ignore/restore/adopt decisions. Adoption saves
  one C3 candidate, source snapshot, decisions and pending events atomically.
  Version checks and idempotency prevent competing or repeated writes. Migration
  `0009` adds only C-owned tables. Source-change display and task-code suggestions
  do not claim D invalidation or automatic A ingestion. The page still uses its
  explicit mock adapter. See [activity contract](C_ACTIVITY_RECORDS.md).
- C5-01/02/03: logical project files, retained immutable versions, verified storage
  receipt registration, authorized signed-link contracts, combination queries and
  reasoned official-version designation. Appending a differently named version
  retains the logical file name and the old official version. Migration `0010`
  protects stored provenance from destructive downgrade. Storage receipts and
  links must come from A's trusted adapter; default 503 does not simulate file
  bytes, upload progress or delivered notifications. Course-file publication is
  still local. See [file contract](C_PROJECT_FILES.md).
- All new routes are mounted in the canonical API, exported to OpenAPI and
  generated TypeScript, and wrapped in the typed C client. Existing schemas and
  paths retain their exact contracts. Browser requests do not send a development
  identity override. Daily browser contracts are now included in CI.

The [remaining-work audit](C_REMAINING_WORK.md) now records substantive partial
coverage of 30/35 IDs, including the receipt/download contract part of C5-02.
None of those numbers is a task completion percentage. A's canonical production
identity, source/storage adapters and event delivery, B's route context, D's
verification integration and clean-database staging acceptance remain necessary.

Validation for this batch:

- PostgreSQL migration `0008 -> 0009 -> 0010` and `alembic check` passed. Both
  new migrations have empty rollback/reapply and populated-history protection
  tests; file migration tests separately protect pending outbox and replay rows.
- The initial full canonical run had 532 passes and one stale assertion expecting
  migration `0008`. Updating that expected head to `0010` passed all 3 database
  tests. A further 4 file-migration and 4 daily PostgreSQL regressions passed;
  **541 distinct backend cases** passed across the full run and targeted reruns,
  with zero database skips. This is not a claim that every case uses PostgreSQL:
  relational/HTTP fixture tests also use SQLite; PG-specific tests used isolated
  schemas in the disposable local database.
- Ruff lint/format, frontend lint/typecheck, production build and 56 route
  mappings passed. Ten C command/client scripts passed **705 assertions**.
  Existing C browser cases passed **36/36**, and daily API page contracts passed
  **4/4**. These test responses are not real vendor or production identity evidence.
- Independent read-only reviews of daily access/UI, C4 transactions and C5
  storage/version authorization found no remaining blocking issue. Runtime
  OpenAPI adds 12 paths/33 schemas while preserving every pre-existing path/schema.

### Course files, governance, real API pages and inbox (2026-10-12; PR #11 snapshot)

The preceding batch was merged through [PR #10](https://github.com/ZZJ1977/groupproof/pull/10)
at `22b99ac`. Its **30/35 partial-coverage count remains a historical result**.
This new batch extends partial code or typed contract coverage to **35/35 IDs**;
it does not close any of the 35 complete acceptance rows. C7-02, for example,
implements secure disable integration while restore/create remain unavailable.

The following eight substantive backend/test commits are recorded on `C_task`:

| Commit | Delivered change |
| --- | --- |
| `00a5f9c` | C5-04 course logical files, immutable versions and reasoned publication |
| `e1a9581` | C5-04 isolation, PostgreSQL publication races and migration retention |
| `13c316a` | C2-02/04 authorized canonical selectors and persistent execution history |
| `13a0014` | C7-01/02/03 Admin wrappers over A identity services |
| `203c449` | C7-04/07 course lifecycle and scoped access decision persistence |
| `3a60ddf` | C7-04/07 replay/expiry/rollback and concurrent approval regression coverage |
| `05403fc` | C7-05/06 audit metadata validation and actual AI usage aggregation |
| `f42282d` | C1-02/03 inbox snapshots, read-receipt contracts and assigned action queries |

Nine subsequent integration/UI/test commits are also recorded:

| Commit | Delivered change |
| --- | --- |
| `11e4601` | Register canonical endpoints/migrations and generated contracts |
| `0bf334f` | Shared scoped API queries, safe destinations and command handling |
| `ecc3995` | Execution, evidence and discussion API pages |
| `bd6ac11` | Activity association and immutable project-file decision pages |
| `9baf042` | Course publication/history and signed file-link page |
| `432255a` | Identity Admin pages with CSRF and conflict recovery |
| `9a22f91` | Course, audit, usage and scoped-access governance pages |
| `55bc5f0` | Snapshot-aware notification and assigned-action pages |
| `90311d2` | Isolated API entry routing and contract browser CI configuration |

The 17 implementation/test commits above plus delivery commit `8809269` were
pushed ahead of merged `develop` `22b99ac` in
[PR #11](https://github.com/ZZJ1977/groupproof/pull/11), subsequently merged into
`develop` at `481f35b`. Its [remote checks](https://github.com/ZZJ1977/groupproof/pull/11/checks)
passed. Merge and CI do not establish whole-system staging acceptance.

Implemented scope and provider boundaries:

- C2/C3/C4/C5/C6 API pages now call canonical execution, evidence, source-record,
  project/course-file and discussion APIs, using current selectors, versions,
  reasons, stable retry keys and failure recovery. Production still requires A's
  real session-to-UUID identity and canonical entry data. Intercepted browser
  responses do not establish that integration, and mock string IDs are rejected.
- C5-04 adds course-owned tables and migration `0011`, teacher-owner writes,
  enrolled-student published-only reads/downloads and staff/TA read-only history.
  Replacement retains the prior publication and B's frozen references. Actual
  byte upload/progress, validated course receipts, signing, previews/downloads
  and notifications require A. The real page explicitly leaves upload/replacement
  unavailable. See [course files](C_COURSE_FILES.md).
- C7 identity pages reuse existing `server/` sessions, Admin/CSRF checks, account
  disable/session revocation and teacher review services. New wrappers add required
  reasons, self-disable protection, current review-basis checks and versioned
  failure recovery. Baseline A services are not counted as newly implemented C
  identity infrastructure. Restore/create are unavailable; the identity-service
  IDs remain separate from canonical business UUIDs.
- C7 governance adds migration `0012`, reasoned course draft/publish/end history,
  code claims and invitation issue/revocation. Historical B course rows are not
  rewritten. B must consume the invitation resolver in its enrollment transaction
  and verify course lifecycle effects on its workflows; C does not create B
  memberships. Scoped, expiring access approval requires A's exact transactional
  grant receipt. Default activation/visibility ports return 503, and A remains
  responsible for enforcement and revocation on every content access.
- C7 audit is read-only and accepts only approved scalar change metadata. Usage
  aggregation uses complete timestamped snapshots, explicit 7/30/90-day windows
  and separate currency totals. A audit/usage providers remain unavailable; no
  raw protected source rows, fabricated zero usage, health scores or trends are
  substituted. Admin governance metadata does not grant project content access.
- C1-02/03 adds recipient-bound notification/action contracts, exact page/count
  validation, snapshot/version read commands and transactional receipt checking.
  Structured, scope-checked targets lead to the appropriate task, verification,
  appeal, member-change, baseline, plan or course-rule workflow. There is no
  arbitrary action-item completion endpoint. Default A providers return 503;
  home notification/action counters remain `null`. See [inbox contract](C_INBOX.md).
- D retains verification, authoritative task completion, contribution/report
  inclusion and downstream evidence invalidation. C's pending outbox rows do not
  prove delivery or D consumption. A/B/D integration and staging acceptance
  cannot be completed independently by C or by reading public vendor documentation.

Completed verification for this snapshot:

| Check | Actual result |
| --- | --- |
| Full canonical backend suite | **813 passed, zero skipped** |
| Separate identity-service suite | **128 passed** |
| Database | Migration head **0012** and `alembic check` passed |
| Python quality | Ruff passed, including the reported **137-file** check |
| Frontend static checks | Full lint and typecheck passed |
| Production build | Passed compilation, types, static generation and trace collection |
| Command/client scripts | **710 assertions passed** |
| Existing C browser suite | **36 passed** |
| New API browser suite | **45/45 passed**, including corrected filtering-control locators and inbox **8/8** rerun |
| Daily API browser suite | **4/4 passed** in the current batch |
| Total C browser coverage | **85 passed** across existing, new API and daily cases |

The canonical total includes SQLite/HTTP fixture tests as well as enabled
PostgreSQL tests. It must not be described as 813 PostgreSQL tests. In particular,
the 75 inbox contract cases explicitly use SQLite to test relational read/replay
rollback; they do not validate a production A adapter or PostgreSQL locking.
Course-file coverage separately includes 96 SQLite/HTTP and 7 PostgreSQL cases.

The browser reruns above follow corrections to test locators using observed
accessible combobox/alert roles; they do not weaken product permissions or
business assertions. All code and handoff records were pushed to `C_task` and
merged through PR #11; staging acceptance remains separate. Remote CI is tracked by
the live PR checks above. The production build and daily results above were
rerun for this batch. No whole-system or 35-task acceptance is claimed.

### Follow-up after PR #11: counters, evidence and safe Admin decisions (2026-10-12)

`C_task` was first fast-forwarded to merged `develop` `481f35b`. This batch fixes
independent C behavior found by reading the current implementations and exercising
the API pages. It introduces no migration, third-party SDK, temporary production
identity, B membership mutation or D verification result.

| Commit | C task scope and verified change |
| --- | --- |
| `4dfbc67` | C1-01/02 home unread/pending totals use the existing recipient-, snapshot- and count-validated inbox services. One unavailable provider degrades only its own count; verified empty totals are zero and 401/403 denies the entire read. DTO/OpenAPI types accept nonnegative counts. |
| `bc58dc5` | C4-01/03 group and activity-kind URL filters, legacy group compatibility, empty-result retention and removal of options on lost permission. Options represent only the current authorized page, with an explicit UI limitation. |
| `342271f` | C2-05/06 and C3-01 source selectors share current note history and preserve drafts through source conflicts; immutable nested snapshots display original text/replies. C2/C3/C6 success resets the command key while uncertain failures retain it, allowing later intentional identical submissions. |
| `152c317` | C7-01/02/03 details use current rows but require explicit acknowledgement of a changed version. Lost permission clears drafts; write 404 closes the deleted target and refreshes; 409/503 preserves recoverable input. |
| `532ce17` | C7-04 course action/version stays bound to the user's confirmation. Background updates cannot transform publish into end; a new end confirmation clears the old publish reason. C7-07 pending requests expire while open and still allow reasoned rejection. |

Local verification performed for the changed scope:

| Check | Observed result |
| --- | --- |
| Daily service and inbox HTTP regressions | **64 passed** (46 daily, 18 inbox HTTP), including **10 new tests** |
| Generated C client script | **55 assertions passed** |
| Changed browser files | **53 passed**: daily 5, source activities/files 10, execution/evidence/discussion 13, identity Admin 9, governance 16 |
| New browser coverage | **20 new cases** across those files |
| Python lint/format | **137 files** formatted; Ruff lint passed |
| Frontend checks | Full lint and typecheck passed; **56 route mappings** passed |
| Production build | Passed compilation, types, static generation and trace collection |

An initial combined browser run timed out at the initial loading screen in the
disappeared-directory-selection case. The complete identity file was rerun and
passed **9/9**, including that unchanged case and both new 404 cases. Assertions
were not weakened. The subsequent governance run passed **16/16** after the
independent review found and the implementation fixed the publish/end risk.

These backend tests use relational/HTTP fixtures and the browser tests intercept
explicit API responses. They establish these contracts and interactions, not A's
production adapters or team acceptance. Full backend, identity, browser, script,
build and Docker checks also run in the new PR's CI; its live checks are the
authority for remote results. The prior **813/128** suite totals above describe
PR #11, not an unexecuted full local run of this follow-up.

Still required: A's real identity bridge and entry context, storage/source/inbox/
audit/usage/access adapters and delivery; B's stable task codes, canonical entry
data and invitation integration; D's verification queries and event consumers;
Admin restore/create against an agreed identity service; clean-database staging
acceptance. Source selectors and typed unavailable ports do not complete these
dependencies. C task acceptance remains separate from partial code coverage.

### Unified-auth integration and functional audit follow-up (2026-10-14)

Base: merged `develop` `4143991` (including PRs #12 and #14). This entry supersedes
the earlier identity-bridge dependency. The original findings and remaining
provider gaps are preserved in [the audit](reviews/2026-10-14-c-function-audit.md).

| Commit | Delivered change |
| --- | --- |
| `64d8877` | C2/C3 command headers survive the actual Next proxy; browser API defaults and example/Compose settings use the same origin. HTTP regression preserves receipt retries, conflicts, authentication headers and multiple cookies. |
| `22a3760` | C1/C2/C3/C6/C7 use current school-email proof, correct directory SQL and version-zero disable; task descriptions, historical evidence authors and current mention recipients are projected separately. Authorized history focus uses one SQL snapshot, with PostgreSQL UUID-ordering and access-revocation coverage. |
| `ecb726d` | C1-04/C2-02/C6-02 task history and new replies locate the actual record; links survive pagination, refresh and concurrent ordering changes. |
| `350ad22` | C3-04/C4-01 explicit source checking uses original source ID, current version, reason and stable retry key. External 503 retains input. Activities link to the exact evidence or clearly scoped search; page reads never invalidate evidence implicitly. |
| `e655d39` | C1-01/02 real shell has no seed fallback; real/mixed-feature routes retain UUID navigation, actual session display name and notification totals. Denied writes clear the badge. Global search remains disabled where no authorized provider exists. |
| `b8ecf04` | C7-05/06 independent actor/date-window navigation no longer erases unsubmitted filter fields; both submitted and unsubmitted reset flows are covered. |

Local verification:

- Migration **0013** and `alembic check` passed on the task's isolated PostgreSQL.
- Full unified API run: **865 passed, 1 failed**. The failure was a new test's
  incorrect whole-table event count: another task's seed history already existed.
  The repaired test scopes events to its project/task, explicitly seeds unrelated
  history, and verifies unchanged event IDs after duplicate start and revocation.
  Final affected-suite rerun: **33 passed**, including 17 unified-auth cases,
  two new PostgreSQL focus cases, and discussion/progress HTTP regressions.
  This is not described as an unexecuted all-green full local run; the PR runs
  the complete final backend suite.
- C browser coverage comprises **121 distinct cases**: mock 36, daily 5,
  canonical API 76, fully real shell 4. Initial API run was 75/76; the real
  audit-filter draft bug was repaired and the full governance/inbox files passed
  **24/24**. The analogous usage draft was fixed in that rerun. After mixed-mode
  navigation assertions were added, 9/10 project cases passed; the cold-start
  first case stopped on the loading placeholder, then passed unchanged on its
  isolated rerun. No assertions were weakened or sleeps added.
- C command/client scripts: **733 assertions**. Frontend lint, typecheck and
  all **56 route mappings** passed. Python Ruff lint and formatting passed for
  **174 files**. Production build and final remote CI status are checked on the PR.

The proxy tests use a real HTTP hop to an isolated transport fixture; they do not
claim live external providers. Backend auth tests use A's actual binding/session
functions and C's SQL/HTTP flow, not a demo identity override. The task's own
PostgreSQL tests cover locks, transactions and UUID/window ordering separately.

Remaining C acceptance work still depends on A storage/source/inbox/audit/usage/
access providers and durable delivery, B stable task codes and frozen references,
D verification/invalidation consumers, account restore/create contracts, and
clean-database staging acceptance. Current source-check UI is useful with an
available provider; it is not automatic external-source event delivery.

### Reuse A's persisted authentication records (2026-10-15)

Base: merged `develop` `22c0d1a` (PR #16). The available A code already persists
teacher applications and authentication audit events. This batch reads those
records through C-owned projections instead of waiting for a new provider or
introducing a second identity database. No schema migration or deployment is
included.

- **C7-03:** teacher-review queries support pending/approved/rejected/all,
  fixed ten-row pagination and read-only history. Submitted name, identity and
  email domain are distinguished from the current account; reviewer name is
  explicitly current. Missing historical facts remain empty. History does not
  offer another decision, and lost permission removes protected details.
- **C7-05:** two read-only API routes expose A's `AuthAuditEvent` using the real
  current Admin/session checks. Filters cover action, result, actor, target user
  and timezone-aware dates. One SQL statement produces the filtered count and
  stable page. The response only exposes allowlisted metadata; it does not
  invent historical roles, reasons or before/after values.
- **C7-05 UI:** `/admin/logs?source=auth` has URL filters, pagination and event
  detail. Authentication and all-site business audit remain explicit separate
  sources. Revoked access clears list, directory and detail data; unavailable
  reads do not keep displaying stale results. Generated client types, browser
  contracts and a new client-check script are included in CI.

Local verification for this batch:

| Check | Observed result |
| --- | --- |
| PostgreSQL API/auth regressions | **61 passed**, zero skipped: audit 34, teacher history 10, existing unified-auth integration 17 |
| Changed browser files | **35 distinct cases passed** across the initial run and unchanged audit-suite rerun; **10 new cases** |
| New authentication-audit client script | **19 assertions passed** |
| Existing generated C client script | **55 assertions passed** |
| Python lint/format | Ruff passed; **179 files** passed the format check |
| Frontend and routes | Full lint, typecheck and **56 route mappings** passed |
| Production build | Compilation, type checking, static generation and trace collection passed |

The first combined browser run passed 34/35. The remaining case timed out at
its first `page.goto` during local cold compilation, before business assertions.
The complete new audit suite then passed **8/8** with unchanged assertions and
timeouts. Both the failure log/trace and rerun log are retained locally under
`test-results`; this is not represented as a single all-green first run.

The backend tests use A's actual session, account-disable, teacher-review and
audit persistence paths with the isolated PostgreSQL database. Browser tests
intercept API responses to verify UI behavior; they do not establish deployed
integration. Final full-suite results belong to this batch's PR checks.

Authentication audit is a working subset of C7-05, not full all-site business
audit. A's storage, GitHub/Feishu, inbox, AI usage, access-grant and durable event
delivery providers remain separate dependencies, along with B's canonical task
references, D's verification consumers and clean-database staging acceptance.

### Google identity and 0013-to-0015 compatibility (2026-11-01)

The requested scope is the previous review's items 2 and 3: new authentication
integration and migration compatibility. The four newly introduced Google audit
event labels remain a separate C7-05 follow-up.

The integration review found that canonical business writes authenticated the
Cookie but did not call A's CSRF guard. `get_current_user` now reuses that guard
after checking current account/registration facts. The generated API transport
reads the current session before a write and attaches its token, retaining the
original body and idempotency key. It does not cache tokens across account or
session changes or automatically retry a write. Failed session lookups do not
send the command. Read requests and the explicitly enabled development demo
identity keep their existing behavior.

New regression coverage:

- `test_c_google_auth_integration.py`: actual Google callback/session routes,
  school-code consumption and cookie rotation, linked/unlinked canonical UUIDs,
  task/note ownership, cross-project denial, Admin disable/revocation, OAuth
  replay, mailbox conflict and revoked school proof. Missing/incorrect CSRF and
  foreign Origin cases assert rejected execution/note commands leave data intact.
- `test_c_auth_migration_compatibility.py`: two isolated PostgreSQL databases
  exercise an empty rebuild and an upgrade with persisted C data. Task progress,
  note versions, evidence/decisions/snapshots, file versions, discussions,
  teacher reviews, audit, idempotency and outbox rows are compared column by
  column across 0014 and 0015. D constraints, OAuth backfill/FK behavior, one head
  and `alembic check` are verified. Each test drops only its UUID-named database;
  the supplied maintenance database is not modified. A test role needs CREATEDB.
- `playwright.c-integration.config.ts`: a separate real Next/FastAPI/PostgreSQL
  suite, with no product response interception or injected login Cookie. It
  follows the OIDC browser round trip, exercises task/progress/notes/evidence,
  refresh persistence, foreign-member denial, Admin disable and CSRF rejection,
  then independently reads committed PostgreSQL rows.
- `check-c-session-client.mjs`: fresh tokens after rotation, preserved commands
  and idempotency keys, no write on invalid/unavailable sessions.

The browser harness is a separate test-only process, guarded by explicit test
flags, a random control token and a loopback database. It creates one random
schema from ORM metadata and removes only that schema, including startup-error
cleanup. Migration correctness is tested by the independent Alembic tests.
Only the external OIDC issuer and prerequisite users/plans are fixtures; real
Google accounts, production email, B planning and third-party providers are not
claimed as tested. File migration fixtures use explicit storage receipts, not
uploaded object bytes. No A/D migration or external deployment is changed.

Reproduction with a disposable PostgreSQL database:

1. Set `GROUPPROOF_ENV_FILE` to `NUL` (Windows) or `/dev/null` (Linux), `APP_ENV=test`,
   `APP_MODE=dev`, `MAIL_MODE=capture` and a test-only `EMAIL_CHALLENGE_HMAC_KEY`.
2. Set `DATABASE_URL`, `C_TEST_DATABASE_URL`, `C_EXECUTION_TEST_DATABASE_URL` to
   the isolated database. From `services/api`, run `python -m alembic upgrade head`
   and `python -m pytest tests/test_c_google_auth_integration.py tests/test_c_auth_migration_compatibility.py -q`.
3. Set `C_BROWSER_DATABASE_URL` to a loopback PostgreSQL test database. From the
   repository root run `npx playwright test --config playwright.c-integration.config.ts`.
   Python defaults to the local Windows API venv or `python`; override with
   `C_BROWSER_PYTHON` if needed. Ports 13007 and 18007 must be free.

The new browser job is included in the deployment dependency list so a failed
integration check cannot be ignored by a later deployment. Local Docker did not
start because its `dockerInference` socket failed; local static/client checks
are recorded separately from the actual PostgreSQL and browser CI executions.
The Railway backup-plan restriction remains A's deployment dependency; this
batch neither bypasses it nor claims staging acceptance.

The first [PR #26 CI run](https://github.com/ZZJ1977/groupproof/actions/runs/41287908296)
passed the full backend suite (**973 passed, zero skipped**, including the 17 new
identity/CSRF cases and two migration cases), all **four real browser cases**,
lint/typecheck/build/route checks and the Docker image smoke test. The existing
C API browser suite passed 85/86: its reply test counted the still-open editor
as a saved reply before the new session preflight finished. The assertion now
waits for that editor to close and counts only saved reply articles; the three
request/two record and retry/new-command key assertions are unchanged.

The local targeted browser rerun did not start because SWC rejected its Windows
native-module cache permissions. An extra local SQLite identity run was stopped
after stalling at its first HTTP fixture; neither local run is counted as passed.
The completed CI backend suite includes that identity regression file. Final
post-fix results are recorded in [PR #26](https://github.com/ZZJ1977/groupproof/pull/26)
and its checks, separately from this first-run record.

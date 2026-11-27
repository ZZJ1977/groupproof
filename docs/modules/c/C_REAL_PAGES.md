# C real API page handoff

> **当前状态（2026-11-27）**：前端已重构为按角色分域目录，C 真实页面现位于 `shared/daily-inbox/`（04–06、30）、`student/execution/`（14–15、20–24、50）与 `admin/pages/`（51–56、62）。工作区默认全量启用真实 API（`NEXT_PUBLIC_ENABLE_MOCKS=false`），A/B/C/D 后端端口均已接入并在 Staging / Production 上线，最新交付边界见 [README.md](../../../README.md) 与 [FRONTEND_STATUS.md](../../../FRONTEND_STATUS.md)。

The C pages preserve the existing page map and shared layout. A's authenticated page
gate runs before workspace routes, and each backend request independently checks
current authority. The real page components never translate `project-1`, `course-1`
or other legacy seed identifiers into database UUIDs and never fall back to local
sample data.

## Features and routes

| Flag | Screens | Frontend location & interface |
| --- | --- | --- |
| `daily=real` | 04, 30 | `shared/daily-inbox/DailyApiPages.tsx` — Canonical home summary and personal activity |
| `inbox=real` | 05, 06 | `shared/daily-inbox/InboxApiPages.tsx` — A4 `DatabaseInboxPort` notifications and action items |
| `cworkspace=real` | 14, 15, 20–24 | `student/execution/` — Canonical task execution, evidence, activity, files and discussions |
| `coursefiles=real` | 50 | `student/execution/CourseFilesApiPage.tsx`（学生端另由 `student/courses/StudentCourseFilesApiPage.tsx` 聚合 B/C 课程资料） |
| `cidentity=real` | 51, 52 | `admin/pages/IdentityAdminApiPages.tsx` — Unified identity directory, disable/enable/create and teacher review |
| `governance=real` | 53–56 | `admin/pages/GovernanceApiPages.tsx` — Course lifecycle, auth/shared audit, AI usage and access decisions |

With mocks globally disabled (`NEXT_PUBLIC_ENABLE_MOCKS=false`, enforced in Staging
and Production), every feature defaults to real against `services/api`, using A's
unified cookie session and CSRF transport. The browser defaults to same-origin
`/api/v1`, and Next forwards `Idempotency-Key` with cookies and CSRF headers.
`server/` is historical. The shell contains no seed objects, uses valid route UUIDs
for navigation, actual inbox totals for its badge, and authorized global search
(`GET /api/v1/search`, strictly scoped by current account permissions).

## Page and interaction structure

- Task detail separates overview, acceptance criteria, evidence, verification,
  linked discussions and execution history. Tabs live in the URL. Progress and
  implementation-note forms retain input on failures; refreshing after a version
  conflict requires the user to check the current saved state. Progress at 100%
  cannot complete a task. The verification tab queries D's real acceptance history
  and links to completeness check / human confirmation (degrading explicitly only
  if the service is unavailable).
- Submission saves the note draft and pending-submission state together. A
  source selector shows actual authorized records; switching source clears its
  selection. Manual descriptions, existing task notes, important discussions,
  stored files and synced GitHub/Feishu activities can become candidate evidence
  through A's wired `SourcePort` adapters. Successful preparation displays the
  actual receipt and hands off to D's real completeness check on screen 16.
- Evidence has URL filters, criterion choices from the current task context,
  source snapshots, decision history and explicit reasoned adoption/withdrawal
  (triggering in-transaction D verification invalidation).
- GitHub and Feishu display authorized provider query results, current connection
  state, direct in-page sync triggers and association/decision controls. Original
  GitHub links require the exact GitHub HTTPS host.
- Project and course files have URL filters, version history, reasoned official
  designation/publication, verified byte upload (via A4-04 Supabase Storage or
  inline PG LOB fallback where applicable) and short-lived signed preview/download
  links (returning explicit 503 only when storage is unconfigured).
- Discussions support task/requirement/module/milestone references, mentions,
  concurrent replies, important marks and explicit confirmation before discarding
  edits. Task detail uses the same discussion component with its task scope.
- Governance pages use real lists and detail records with reason/version-aware
  decisions against A's `AuthAuditEvent`, A4 shared audit, A7 `DatabaseUsagePort`
  and `DatabaseAuthorizationPort`. Unavailable sources yield an explicit error,
  never synthetic trends.
- Inbox pages expose read-state controls and processing links backed by A4
  `DatabaseInboxPort`. There is no C endpoint or button to arbitrarily complete an
  assigned action item.

## Common behavior and data boundaries

Queries are scoped by actual session user and route identifiers. Loading or
denied refreshes do not retain visible stale personal data. Current server
permissions determine which controls appear; they do not replace backend checks.
Forms use labels, native keyboard controls, wrapping action groups and scrollable
tables. Pagination and filters stay in the URL where specified.

Writes use a synchronous pending guard to stop double-clicks and reuse an
idempotency key for the same uncertain command. A network failure is not described
as proof that the server performed no work. Version conflicts retain input for
review, rather than silently overwriting a changed record.

`GET /api/v1/projects/{id}/c-context` supplies bounded, authorized names and IDs
for selectors. It reads B-owned entities and makes no planning mutation. It fails
explicitly if its 1,000-row bound is exceeded. The progress-history endpoint reads
actual C progress events and applies the same project/task access checks.

Task selectors include the saved description. `evidence_authors` includes only
authors of evidence already in this authorized project; `mention_targets` contains
current readers, including eligible teachers/TAs. Neither grants membership.
Reply `focus_reply_id` and progress `focus_event_id` locate an authorized record's
current page using stable server ordering. Personal activity links point directly
to the corresponding evidence, note version or progress event.

Evidence source checks require the original snapshot's source ID, current version,
reason and idempotency key. A successful change preserves snapshots and excludes
the evidence from effective queries. An unavailable provider retains the form;
opening an activity page never writes or implicitly invalidates evidence.

See [course files](C_COURSE_FILES.md), [identity Admin](C_IDENTITY_ADMIN.md),
[governance](C_GOVERNANCE.md), and the [acceptance ledger](C_DELIVERY.md) for the
contracts and remaining A/B/D dependencies. C outbox records are pending work,
not proof of notification delivery or D invalidation.

## Verification boundaries

`playwright.c-api.config.ts` tests these API page branches using explicit HTTP
fixtures. Run it serially with `playwright.c.config.ts` and
`playwright.c-daily.config.ts` and `playwright.c-shell.config.ts`; their loopback
ports are shared. Proxy tests make actual HTTP requests through Next to an isolated
transport fixture. Canonical backend tests cover PostgreSQL concurrency/migrations
and separate SQLite HTTP integration with real unified cookies and CSRF.
None of these substitutes for the team's clean-database staging acceptance with
mocks off and real external integrations.

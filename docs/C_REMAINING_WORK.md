# C implementation status and remaining work

This is a code audit, not team acceptance. The assignment enumerates 35 C tasks.
Passing tests or touching a task ID does not mean that task has passed the Feishu
Definition of Done. The 17-commit first delivery implemented parts of 21 task IDs;
it did not complete 21 tasks. Existing baseline work is identified separately.

PR #9 contained 27 commits covering parts of 29 task IDs and was merged into
`develop` on 2026-10-12 (Asia/Shanghai). The following C1/C4/C5 batch reached
**30 of 35 task IDs** with partial implementation, including the C5-02 verified
receipt/download contract. That is the historical PR #10 result, not a current
task-completion percentage. PR #10 is now merged (`22b99ac`).

The current batch, recorded through commit `90311d2`, has partial code or
typed contract coverage for **35 of 35 task IDs**. **None of the 35 complete task
acceptance rows is closed by this coverage count.** Account restore/create,
actual uploaded bytes, production authorization, external adapters and D
acceptance are not complete. **17 substantive implementation/test commits** and
delivery commit `8809269` have been pushed in
[draft PR #11](https://github.com/ZZJ1977/groupproof/pull/11). This documentation
follow-up records the publication; remote CI is tracked in the live PR checks.
See `C_DELIVERY.md` for exact commits, completed checks and pending delivery.

## What is implemented

| Area | Implemented C work | Still missing for complete acceptance |
| --- | --- | --- |
| C1 (4 tasks) | Canonical membership-scoped home/progress/activity reads; A inbox/action ports with recipient/count/snapshot validation and transactional read receipts; real API pages | A notification/action adapters and delivery, production UUID identity and external feeds; home inbox counts remain unavailable |
| C2 (8 tasks) | Execution transitions, assignee/dependency checks, progress/rollups/history, notes, candidate capture and atomic prepare-submission; canonical selectors and real task API pages | A production session/UUID entry context and source/storage providers; D verification query, acceptance and authoritative completion |
| C3 (5 tasks) | Persistent snapshots/decisions/effective queries, reasoned adopt/withdraw/source-change rules and real evidence API page | A source events, reliable outbox delivery, D invalidation/verification/contribution/report consumers and staging acceptance |
| C4 (4 tasks) | Canonical association/triage, immutable decisions, source-query contracts, atomic candidate adoption and real GitHub/Feishu API pages | A authorized query/sync adapters, stable B task codes and automatic association consumer, source-change delivery and live external verification |
| C5 (4 tasks) | Project/course logical files, immutable versions, receipts, official designation/publication, authorized link contracts, retained history and real API pages | A actual byte upload/progress, validated project/course receipts, signing and preview/download adapters; notification delivery and B frozen-reference acceptance |
| C6 (3 tasks) | Canonical discussions, concurrent replies, mentions, important snapshots and linked-evidence source changes; real discussion API page | Production UUID identity, A notification delivery, D event consumption and multi-member staging acceptance |
| C7 (7 tasks) | Admin directory; C wrappers reuse A disable/session revocation and teacher review; course lifecycle/invites, expiring approval records, audit/actual-usage contracts and real pages | User restore/create, A canonical identity/audit/usage/access-enforcement providers, B invitation/join and lifecycle coordination, team acceptance |

## Existing team code that must be reused

- `server/` already implements teacher application persistence/review and account
  disable with session revocation. Those services remain A's baseline. New C
  routes/pages delegate to them with Admin/CSRF checks, nonblank reasons,
  self-disable prevention, current review basis and version conflicts. They do
  not translate identity-service string IDs into canonical business UUIDs.
  Restore/create users and the production identity bridge remain unfinished.
- `lib/commands/files.ts` already validates local file metadata, manages version
  history and preserves baseline source references. It does not upload bytes.
- `services/api` has canonical UUID User/Course/project models. Its development
  identity header is explicitly unavailable in production. The `server/` user
  IDs, roles and session schema cannot be imported as canonical IDs.

## Work that can continue without third-party credentials

The prior six independently implementable areas now have code/contracts. Browser
locator repairs, API/daily reruns and the production build have passed. Remaining
delivery work has been pushed to PR #11; remote CI, review and integration
acceptance are tracked there. Local results do not substitute for remote checks
or staging.

Further C work includes user restore/create flows against an agreed A identity
service contract, and complete UI/API/error/permission acceptance after providers
are connected. An unavailable typed port does not implement its provider. Do not
invent UUID mappings or write A/B/D-owned data to make a demonstration look complete.

## Dependencies that cannot be supplied by vendor documentation

| Owner | Concrete delivery needed | Effect while absent |
| --- | --- | --- |
| A | Verified session and real role -> canonical UUID current user | Production business APIs remain closed; no demo-header bypass |
| A/B | Canonical workspace/project/task/criterion loading and route context | Mock string IDs must not be translated into fabricated UUIDs |
| A | A4 notification/action queries, transactional read mutations, audit source and A7 timestamped usage | Default ports return 503; no fake rows, zero counts or estimated usage; home inbox counters stay null |
| A | Validated project/course upload receipts, actual byte storage and signed preview/download URLs | No real upload/progress or storage success from metadata-only commands |
| A | Authorized GitHub/Feishu query and stable source snapshots | C cannot prove that local source lists equal external services |
| A | Transactional, scoped and expiring access activation/enforcement | Approval cannot become a real grant without the exact A receipt; enforcement remains A-owned |
| B | Invitation consumption, enrollment/join rules and course lifecycle coordination | C invite resolver does not create membership; publishing/ending needs B integration acceptance |
| D | Verification query, authoritative completion and evidence-change/contribution/report consumers | No C bypass of acceptance; pending events do not mean delivered invalidation |
| A/team | PR review and staging acceptance using a clean database | No task is marked finally accepted solely because CI passed |

## Verification and scope

Current batch snapshot (2026-10-12; prior batch results below remain historical):

- Full canonical backend: **813 passed, zero skipped**. PG-specific checks ran
  against the disposable database; this total also includes SQLite/HTTP fixtures
  and must not be called 813 PostgreSQL tests. Identity service: **128 passed**.
- Migration head **0012** and `alembic check` passed. Ruff passed, including the
  reported 137-file check. Frontend lint/typecheck and **710 script assertions** passed.
- Existing C browser suite: **36/36 passed**. New API browser suite: **45/45
  passed**, including the locator corrections and inbox **8/8** rerun. Daily API
  cases passed **4/4** in this batch: **85 C browser cases** in total. The production
  build passed compilation, type checking, static generation and trace collection.
- Implementation/test and documentation commits are published in draft PR #11.
  [Remote checks](https://github.com/ZZJ1977/groupproof/pull/11/checks) provide the
  current CI result; review and team/staging acceptance remain open.

- The first 17 commits passed GitHub CI at `341c646`.
- With the Admin directory addition, the canonical PostgreSQL suite passed
  **302 tests, zero skipped**. C7-01 adds 31 cases; no new migration is needed.
- The post-merge C1/C4/C5 batch adds 239 cases: **541 distinct backend cases**
  passed across a full run and targeted reruns (including the corrected schema
  head expectation and 8 added PostgreSQL cases). Database-dependent tests were
  enabled with zero skips. See the exact run breakdown in `C_DELIVERY.md`.
- C browser tests deliberately distinguish local workspace behavior from intercepted
  canonical API responses. They do not assert live OAuth/storage/vendor acceptance.
- Contracts include `C_DAILY_READS.md`, `C_INBOX.md`, `C_ACTIVITY_RECORDS.md`,
  `C_PROJECT_FILES.md` and `C_COURSE_FILES.md`. Provider-dependent coverage is not
  production integration or acceptance.
- Per-feature tests, later commits and final CI are recorded in `C_DELIVERY.md`
  and the linked PRs. Every remaining task still requires the relevant API/UI/error/permission
  checks and actual team acceptance; a single percentage would conceal those gaps.

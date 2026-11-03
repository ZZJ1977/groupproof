# C implementation status and remaining work

## Current correction — 2026-10-14

2026-11-01 follow-up: PR #17 is merged and C is synchronized with `develop`
`302bf4e`. Google linking/unlinking and D history tables now exist. New C tests
exercise their integration and migrations 0013–0015; a discovered missing CSRF
check on business writes is repaired with A's existing guard and current-session
client tokens. See `C_DELIVERY.md` and the current PR's executed checks. D's new
tables still have no verification query/decision/event consumer; B's latest
branch sync did not add planning or invitation-consumption APIs. The four new
Google audit action labels remain separate from this selected verification batch.

2026-10-15 follow-up: PR #16 is merged (`22c0d1a`). C7-05 now adds a separate
authentication-log view over A's actual `AuthAuditEvent`, while the whole-system
audit adapter remains unavailable. C7-03 also reads approved/rejected applications
from A's existing history, separately displaying the saved review basis and the
current account facts. No new A service or duplicate persistence is required for
these reads. This narrows the remaining audit dependency; it does not supply
storage, external activities, inbox delivery, AI usage or access grants.

PR #12 and unified-auth PR #14 are merged. Authentication and canonical UUID
identity are no longer missing providers. C now reads A's current school-email
binding, fixes enabled/disabled directory filtering and permits account version
zero in disable commands. Historical batch counts below are retained as history.

The current follow-up also forwards command idempotency through the same-origin
proxy, removes the real shell's demo fallback, uses route UUID navigation and
actual unread counts, displays task descriptions, separates historical evidence
authors from mention recipients, locates exact replies/history from receipts and
activity links, and exposes reasoned source checking. Global search remains
unavailable without an authorized search provider; external source checks still
require A's source port. The [audit](reviews/2026-10-14-c-function-audit.md)
records the original reproductions and the delivery record records validation.

This is a code audit, not team acceptance. The assignment enumerates 35 C tasks.
Passing tests or touching a task ID does not mean that task has passed the Feishu
Definition of Done. The 17-commit first delivery implemented parts of 21 task IDs;
it did not complete 21 tasks. Existing baseline work is identified separately.

PR #9 contained 27 commits covering parts of 29 task IDs and was merged into
`develop` on 2026-10-12 (Asia/Shanghai). The following C1/C4/C5 batch reached
**30 of 35 task IDs** with partial implementation, including the C5-02 verified
receipt/download contract. That is the historical PR #10 result, not a current
task-completion percentage. PR #10 is now merged (`22b99ac`).

The PR #11 batch, recorded through commit `90311d2`, has partial code or
typed contract coverage for **35 of 35 task IDs**. **None of the 35 complete task
acceptance rows is closed by this coverage count.** Account restore/create,
actual uploaded bytes, production authorization, external adapters and D
acceptance are not complete. **17 substantive implementation/test commits** and
delivery commit `8809269` have been pushed in
[PR #11](https://github.com/ZZJ1977/groupproof/pull/11), now merged into `develop`
at `481f35b`. Its remote CI passed. The follow-up below fixes additional C
behavior without claiming new complete task acceptance. See `C_DELIVERY.md`
for exact changes, completed checks and current delivery.

## What is implemented

| Area | Implemented C work | Still missing for complete acceptance |
| --- | --- | --- |
| C1 (4 tasks) | Canonical membership-scoped home/progress/activity reads; home inbox totals reuse validated recipient queries; A inbox/action contracts and transactional read receipts; real API pages | A notification/action adapters and delivery, external feeds and authorized global search; unavailable providers keep their own home counts null |
| C2 (8 tasks) | Execution transitions, assignee/dependency checks, progress/rollups/history, notes, candidate capture and atomic prepare-submission; canonical selectors and real task API pages | A source/storage providers; D verification query, acceptance and authoritative completion |
| C3 (5 tasks) | Persistent snapshots/decisions/effective queries, reasoned adopt/withdraw/source-change rules and real evidence API page | A source events, reliable outbox delivery, D invalidation/verification/contribution/report consumers and staging acceptance |
| C4 (4 tasks) | Canonical association/triage, immutable decisions, source-query contracts, atomic candidate adoption and real GitHub/Feishu API pages | A authorized query/sync adapters, stable B task codes and automatic association consumer, source-change delivery and live external verification |
| C5 (4 tasks) | Project/course logical files, immutable versions, receipts, official designation/publication, authorized link contracts, retained history and real API pages | A actual byte upload/progress, validated project/course receipts, signing and preview/download adapters; notification delivery and B frozen-reference acceptance |
| C6 (3 tasks) | Canonical discussions, concurrent replies, mentions, important snapshots and linked-evidence source changes; real discussion API page | A notification delivery, D event consumption and multi-member staging acceptance |
| C7 (7 tasks) | Admin directory; C wrappers reuse A disable/session revocation and teacher review; course lifecycle/invites, expiring approval records, audit/actual-usage contracts and real pages | User restore/create, A audit/usage/access-enforcement providers, B invitation/join and lifecycle coordination, team acceptance |

## Existing team code that must be reused

- `services/api/app/auth` implements teacher application persistence/review and
  account disable/session revocation. C routes delegate with Admin/CSRF checks,
  nonblank reasons, self-disable prevention, current review basis and version
  conflicts. Restore/create users remain unfinished.
- `lib/commands/files.ts` already validates local file metadata, manages version
  history and preserves baseline source references. It does not upload bytes.
- `services/api` has canonical UUID User/Course/project models and real cookie
  sessions. Its development identity header remains unavailable in production.
  `server/` and earlier identity test counts are retained as historical reference.

## Work that can continue without third-party credentials

The prior six independently implementable areas now have code/contracts in merged
PR #11. Follow-up inspection found and fixed additional independent work:

- C1 home totals now use validated unread/pending queries; provider failure is
  unavailable, a verified empty result is zero, and access failure denies the read.
- C2/C3 current note versions and evidence selectors share a query; source conflict
  recovery retains the candidate draft. Snapshot previews read the immutable
  nested source, including note versions and discussion replies.
- C2/C3/C6 command keys persist for uncertain retries and reset on confirmed writes,
  so a later intentional identical reply/candidate creates a distinct command.
- C4 group and kind filters persist in URLs. Options use only the current authorized
  page, with an explicit limitation; unknown selected groups survive empty results.
- C7 pending requests expire while the form is open; reasoned rejection remains
  available. Directory/review details use current rows, require acknowledgement of
  changed versions, close vanished selections (including write 404) and clear
  drafts on access loss. A pending publish can never become end after a background
  refresh; ending requires a separate confirmation with a new reason.

These changes continue on `C_task`; local tests and remote CI are recorded in
`C_DELIVERY.md`. Neither is a substitute for connected staging acceptance.

Further C work includes user restore/create flows against an agreed A identity
service contract, and complete UI/API/error/permission acceptance after providers
are connected. An unavailable typed port does not implement its provider. Do not
invent UUID mappings or write A/B/D-owned data to make a demonstration look complete.

## Dependencies that cannot be supplied by vendor documentation

| Owner | Concrete delivery needed | Effect while absent |
| --- | --- | --- |
| A/team | Validate the delivered unified session and role integration in staging | No demo-header bypass; isolated integration tests are not staging acceptance |
| A/B | Canonical workspace/project/task/criterion loading and route context | Mock string IDs must not be translated into fabricated UUIDs |
| A | A4 notification/action queries, transactional read mutations, audit source and A7 timestamped usage | Default ports return 503; no fake rows, zero counts or estimated usage; home counters use validated totals once each adapter is connected |
| A | Validated project/course upload receipts, actual byte storage and signed preview/download URLs | No real upload/progress or storage success from metadata-only commands |
| A | Authorized GitHub/Feishu query and stable source snapshots | C cannot prove that local source lists equal external services |
| A | Transactional, scoped and expiring access activation/enforcement | Approval cannot become a real grant without the exact A receipt; enforcement remains A-owned |
| B | Invitation consumption, enrollment/join rules and course lifecycle coordination | C invite resolver does not create membership; publishing/ending needs B integration acceptance |
| D | Verification query, authoritative completion and evidence-change/contribution/report consumers | No C bypass of acceptance; pending events do not mean delivered invalidation |
| A/team | PR review and staging acceptance using a clean database | No task is marked finally accepted solely because CI passed |

## Verification and scope

PR #11 snapshot (2026-10-12; current follow-up results are in `C_DELIVERY.md`):

- Full canonical backend: **813 passed, zero skipped**. PG-specific checks ran
  against the disposable database; this total also includes SQLite/HTTP fixtures
  and must not be called 813 PostgreSQL tests. Identity service: **128 passed**.
- Migration head **0012** and `alembic check` passed. Ruff passed, including the
  reported 137-file check. Frontend lint/typecheck and **710 script assertions** passed.
- Existing C browser suite: **36/36 passed**. New API browser suite: **45/45
  passed**, including the locator corrections and inbox **8/8** rerun. Daily API
  cases passed **4/4** in this batch: **85 C browser cases** in total. The production
  build passed compilation, type checking, static generation and trace collection.
- Implementation/test and documentation commits are published in merged PR #11.
  [Remote checks](https://github.com/ZZJ1977/groupproof/pull/11/checks) provide the
  passing CI result; team/staging acceptance remains separate.

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

# C implementation status and remaining work

This is a code audit, not team acceptance. The assignment enumerates 35 C tasks.
Passing tests or touching a task ID does not mean that task has passed the Feishu
Definition of Done. The 17-commit first delivery implemented parts of 21 task IDs;
it did not complete 21 tasks. Existing baseline work is identified separately.

PR #9 contained 27 commits covering parts of 29 task IDs and was merged into
`develop` on 2026-10-12 (Asia/Shanghai). The next batch adds canonical C1 read
models/pages, C4 persistence and C5 file/version persistence. Verified receipt
registration and authorized download-link contracts now provide a substantive
partial C5-02 deliverable, bringing coverage to **30 of 35 task IDs**. This is
implementation coverage, not a completion percentage: uploading actual bytes,
upload progress and A's signing adapter remain unfinished. The five IDs without
a new main business deliverable are C7-02/03/04/05/07.

## What is implemented

| Area | Implemented C work | Still missing for complete acceptance |
| --- | --- | --- |
| C1 (4 tasks) | Canonical membership-scoped home aggregation, weighted task-tree progress and personal activity queries; independent real-mode pages, URL filters and error recovery; local notification read commands | Persistent A notifications/actions, production identity, canonical destination pages and external activity ingestion |
| C2 (8 tasks) | Canonical execution state machine, assignee/dependency checks, reasoned progress and rollups, versioned notes, candidate capture, atomic prepare-submission; typed client and UI source/tab rules | Production identity and canonical workspace IDs; connect pages to these APIs; A source/storage providers and D verification query/completion authority |
| C3 (5 tasks) | Persistent snapshots/decisions/effective queries; adopt/withdraw/source-change rules, reasons, versions, idempotency; local UI filters/history/permissions | Real A source change events; reliable outbox delivery and D invalidation consumption; real UI integration |
| C4 (4 tasks) | Canonical association/triage records, immutable decisions, provider query contracts with filters before pagination, reasoned candidate adoption in one transaction; local UI filtering and task-number suggestions | Real UI adapter, A source query/sync providers, stable B task codes and automatic association consumer, A/D source-change delivery and production end-to-end verification |
| C5 (4 tasks) | Canonical project-file receipt registration, immutable versions, reasoned official designation, authorized download-link contract and history; local project/course-file commands preserve frozen references | Actual upload bytes/progress, A receipt/signing adapter, project-file UI integration, canonical course-file persistence and notification delivery; existing upload UI is still a demo |
| C6 (3 tasks) | Canonical linked discussions, concurrent replies, mentions, important snapshots and immediate linked-evidence source-change marking; local UI commands | Connect real pages and canonical identity; deliver A notifications; process D downstream events |
| C7 (7 tasks) | Canonical Admin user directory API and real-mode read-only UI; removed fabricated AI window totals, trends and health assertions | Identity lifecycle integration, teacher review UI/contracts, course lifecycle/invites, audit queries, timestamped AI usage aggregation, scoped expiring access approvals |

## Existing team code that must be reused

- `server/` already implements teacher application persistence/review and account
  disable with session revocation. These are baseline identity capabilities, not
  new C work. Current Admin pages still use local workspace operations for those
  actions. The identity API also needs nonempty rejection/disable reasons and a
  self-disable guard to meet C7's specification.
- `lib/commands/files.ts` already validates local file metadata, manages version
  history and preserves baseline source references. It does not upload bytes.
- `services/api` has canonical UUID User/Course/project models. Its development
  identity header is explicitly unavailable in production. The `server/` user
  IDs, roles and session schema cannot be imported as canonical IDs.

## Work that can continue without third-party credentials

These are implementation tasks, not reasons to wait for A:

1. Continue canonical C4/C5 page adapters against explicit API fixtures, following
   the separate daily feature flag pattern; canonical route context remains needed
   before enabling them in production. Do not map mock string IDs to made-up UUIDs.
2. Implement canonical C5-04 course-file publication and retained replacements,
   reusing the verified receipt boundary and B's frozen-reference contract.
3. Implement C7-04 course draft/publish/end transitions, reasoned history and
   idempotency. Settle invite ownership and the assignment's unique-course-code
   rule against the existing `(code, semester)` database constraint before migration.
4. Implement C7-05/06 read contracts and real timestamp aggregation once the A
   record schema is agreed; missing historical fields must not be invented.
5. Implement C7-07 structured approval records, scope, expiry and replay protection;
   actual permission activation must call A's authorization service.
6. Continue C7-02/03 page contracts, required reasons, self-disable prevention and
   failure recovery against explicit fixtures; reuse the existing identity review
   service when A reconciles identity IDs and server-side authorization. UI checks
   alone cannot deliver session revocation or secure teacher promotion.

## Dependencies that cannot be supplied by vendor documentation

| Owner | Concrete delivery needed | Effect while absent |
| --- | --- | --- |
| A | Verified session and real role -> canonical UUID current user | Production business APIs remain closed; no demo-header bypass |
| A/B | Canonical workspace/project/task/criterion loading and route context | Mock string IDs must not be translated into fabricated UUIDs |
| A | A4 notifications/actions/audit, validated upload receipts and signed URLs | No actual notification delivery or persistent file bytes |
| A | Authorized GitHub/Feishu query and stable source snapshots | C cannot prove that local source lists equal external services |
| D | Verification query, authoritative completion and evidence-change consumer | No C bypass of acceptance; pending events do not mean delivered invalidation |
| A/team | PR review and staging acceptance using a clean database | No task is marked finally accepted solely because CI passed |

## Verification and scope

- The first 17 commits passed GitHub CI at `341c646`.
- With the Admin directory addition, the canonical PostgreSQL suite passed
  **302 tests, zero skipped**. C7-01 adds 31 cases; no new migration is needed.
- The post-merge C1/C4/C5 batch adds 239 cases: **541 distinct backend cases**
  passed across a full run and targeted reruns (including the corrected schema
  head expectation and 8 added PostgreSQL cases). Database-dependent tests were
  enabled with zero skips. See the exact run breakdown in `C_DELIVERY.md`.
- C browser tests deliberately distinguish local workspace behavior from intercepted
  canonical API responses. They do not assert live OAuth/storage/vendor acceptance.
- The canonical C1/C4/C5 implementation and interface boundaries are described in
  `C_DAILY_READS.md`, `C_ACTIVITY_RECORDS.md` and `C_PROJECT_FILES.md`.
- Per-feature tests, later commits and final CI are recorded in `C_DELIVERY.md`
  and the linked PRs. Every remaining task still requires the relevant API/UI/error/permission
  checks and actual team acceptance; a single percentage would conceal those gaps.

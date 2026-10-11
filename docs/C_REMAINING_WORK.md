# C implementation status and remaining work

This is a code audit, not team acceptance. The assignment enumerates 35 C tasks.
Passing tests or touching a task ID does not mean that task has passed the Feishu
Definition of Done. The 17-commit first delivery implemented parts of 21 task IDs;
it did not complete 21 tasks. Existing baseline work is identified separately.

The follow-up adds substantive partial deliverables for C4-02/03/04,
C5-01/03/04 and C7-01/06, bringing the coverage to **29 of 35 task IDs**.
This is implementation coverage, not a completion percentage. The six remaining
IDs without a new main business deliverable are C5-02 and C7-02/03/04/05/07;
small incidental edits to an upload button do not count as delivering C5-02.

## What is implemented

| Area | Implemented C work | Still missing for complete acceptance |
| --- | --- | --- |
| C1 (4 tasks) | URL tabs, retained baseline project entry links, removal of arbitrary action completion and fixed growth; atomic local notification read actions, pagination and failed-save recovery | Persistent A notifications/actions, canonical home aggregation and activity queries, real record navigation |
| C2 (8 tasks) | Canonical execution state machine, assignee/dependency checks, reasoned progress and rollups, versioned notes, candidate capture, atomic prepare-submission; typed client and UI source/tab rules | Production identity and canonical workspace IDs; connect pages to these APIs; A source/storage providers and D verification query/completion authority |
| C3 (5 tasks) | Persistent snapshots/decisions/effective queries; adopt/withdraw/source-change rules, reasons, versions, idempotency; local UI filters/history/permissions | Real A source change events; reliable outbox delivery and D invalidation consumption; real UI integration |
| C4 (4 tasks) | Local record filtering/pagination, safe GitHub links, task-number matching and manual associations, Feishu reasoned candidate/ignore/restore operations | Persist C association/triage decisions against canonical A source IDs; A source query/sync providers; production end-to-end verification |
| C5 (4 tasks) | Project-file URL filters/pagination; reasoned atomic official-version designation; scoped course-file publication commands; old versions and frozen references retained | Signed storage URLs and actual bytes, canonical file/version persistence, notification delivery; current upload metadata is explicitly a demo |
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

1. Implement C1 home/activity read models over canonical current memberships and
   C-owned task/evidence/discussion data. Expose unavailable A-owned totals explicitly.
2. Persist C4 task associations and Feishu triage commands behind typed A source
   providers; test them with deterministic provider fixtures before live adapters exist.
3. Persist C5 logical files, immutable versions and official/publication decisions;
   require a verified storage receipt before accepting a real uploaded file.
4. Implement C7-04 course draft/publish/end transitions, reasoned history and
   idempotency. Settle invite ownership and the assignment's unique-course-code
   rule against the existing `(code, semester)` database constraint before migration.
5. Implement C7-05/06 read contracts and real timestamp aggregation once the A
   record schema is agreed; missing historical fields must not be invented.
6. Implement C7-07 structured approval records, scope, expiry and replay protection;
   actual permission activation must call A's authorization service.
7. Continue C7-02/03 page contracts, required reasons, self-disable prevention and
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
- C browser tests deliberately distinguish local workspace behavior from intercepted
  canonical API responses. They do not assert live OAuth/storage/vendor acceptance.
- Per-feature tests, later commits and final CI are recorded in `C_DELIVERY.md`
  and PR #9. Every remaining task still requires the relevant API/UI/error/permission
  checks and actual team acceptance; a single percentage would conceal those gaps.

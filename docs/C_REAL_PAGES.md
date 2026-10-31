# C real API page handoff

The C pages preserve the existing page map and shared layout. Feature flags route
to small C-owned components before the demo-role guard. A's authenticated page
gate still runs, and each backend request independently checks current authority.
The real page components never translate `project-1`, `course-1` or other seed
identifiers into database UUIDs and never fall back to local sample data.

## Features and routes

| Flag | Screens | Interface |
| --- | --- | --- |
| `daily=real` | 04, 30 | Canonical home summary and personal activity |
| `inbox=real` | 05, 06 | A-backed notification and assigned action-item ports |
| `cworkspace=real` | 14, 15, 20–24 | Canonical task execution, evidence, activity, files and discussions |
| `coursefiles=real` | 50 | Canonical course file versions and publication |
| `cidentity=real` | 51, 52 | Existing identity service directory, disable and teacher review |
| `governance=real` | 53–56 | Canonical course lifecycle, audit, usage and access decisions |

Set the chosen entries in `NEXT_PUBLIC_API_FEATURES`; flags are independent.
With mocks globally disabled, the default for every feature is real. Enable the
canonical features against `services/api`, which now includes A's unified cookie
session transport. The browser defaults to same-origin `/api/v1`, and Next
forwards `Idempotency-Key` with cookies and CSRF headers. `server/` is historical.
With `workspace=real`, the shell contains no seed objects, uses valid route UUIDs
for navigation and actual inbox totals for its badge. It disables global search
until an authorized search provider exists; feature pages query their own data.

## Page and interaction structure

- Task detail separates overview, acceptance criteria, evidence, verification,
  linked discussions and execution history. Tabs live in the URL. Progress and
  implementation-note forms retain input on failures; refreshing after a version
  conflict requires the user to check the current saved state. Progress at 100%
  cannot complete a task. D's verification tab explains its unavailable service.
- Submission saves the note draft and pending-submission state together. A
  source selector shows actual authorized records; switching source clears its
  selection. Manual descriptions, existing task notes and important discussions
  can become candidate evidence. File/GitHub/Feishu snapshots need A's adapter.
  Successful preparation displays the actual receipt and does not enter a mock
  acceptance flow on screens 16 or 17.
- Evidence has URL filters, criterion choices from the current task context,
  source snapshots, decision history and explicit reasoned adoption/withdrawal.
- GitHub and Feishu display authorized provider query results, current connection
  state and association/decision controls. Their connection and sync controls
  remain A-owned. Original GitHub links require the exact GitHub HTTPS host.
- Project and course files have URL filters, version history, reasoned official
  designation/publication, and short-lived signed preview/download links. Actual
  byte upload remains unavailable until A provides its upload interface.
- Discussions support task/requirement/module/milestone references, mentions,
  concurrent replies, important marks and explicit confirmation before discarding
  edits. Task detail uses the same discussion component with its task scope.
- Governance pages use real lists and detail records with reason/version-aware
  decisions. An unavailable audit or usage source yields an error, not a synthetic
  trend. Authorization activation must be acknowledged by A before approval.
- Inbox pages expose read-state controls and processing links. There is no C
  endpoint or button to arbitrarily complete an assigned action item.

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

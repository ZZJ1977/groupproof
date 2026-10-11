# C4 canonical activity-record handoff

This slice owns C's task associations and Feishu triage decisions. It does not
implement A's GitHub/Feishu authentication, connection, ingestion or synchronization.
The current collaboration pages still use the explicitly local mock commands;
their mock IDs must not be passed to these canonical UUID routes.

## Source contract

`services/api/app/modules/c/activity_ports.py` defines the `ActivitySourcePort`.
Its default implementation returns `503 ACTIVITY_SOURCE_UNAVAILABLE` for both
list and detail. There are no third-party SDKs, credentials, inferred source authors
or browser-supplied source contents in these commands.

A must explicitly wire an adapter over its authorized ingestion store. Every call
contains the canonical project UUID and authenticated actor UUID. Each result
contains a canonical source UUID, trusted author ID/name, aware timestamp, title,
summary, kind, optional opaque Feishu `group_id`, and a `VerifiedSource` with
project/type, stable identity, immutable revision, reproducible content and safe
original URL. Identity/revision must fit C3's 255-character provenance fields.
Deleted sources must be explicit; access/network failures must not masquerade as
deletion or an empty successful query. GitHub URLs must use the public HTTPS
`github.com` origin without credentials. C validates the adapter boundary too.

The paginated query contract is exact:

- Apply `author_id`, inclusive aware `since`/`until`, literal case-insensitive
  `q` over title/summary, exact `group_id`, and exact `record_kind` before pagination.
  HTTP names the last filter `kind`; `group_id` is a nonblank opaque string of at
  most 200 characters and applies to Feishu.
- C translates its own task/status conditions into `include_ids` and `exclude_ids`
  before calling A. `include_ids=None` means unrestricted; `include_ids=()` means
  match nothing. C must not filter an already paginated upstream page locally.
- Return the complete matching total and requested page, ordered by timestamp
  descending then source UUID ascending. A partial upstream page is an error.
  Pages are bounded to 100 records; source records are never fetched unbounded.
- C checks page completeness, duplicate IDs, project/type, filters and ordering.
  C state/history for a page is batch-loaded, not one query per result.

An explicit `T-1` or `T-1.2` prefix in a canonical task title can match the same
standalone code in a GitHub record title only when unique in that project.
The canonical Task model currently has no code column. These are suggestions;
the client must obtain user confirmation and submit a reasoned association.
UUID suffixes, array positions and GitHub issue numbers are never guessed as codes.

## HTTP routes

All paths are below `/api/v1`, use the common typed success/error envelopes,
and return private/no-store responses. `source_type` is `github` or `feishu`.

| Method | Path below `/projects/{project_id}/activities/{source_type}` | Result |
| --- | --- | --- |
| GET | empty suffix | Authorized filtered page with C state and suggestions |
| GET | `/{source_id}` | Authorized live source with C state |
| GET | `/{source_id}/history` | Stored immutable C decision/source history |
| PUT | `/{source_id}/association` | Set/clear same-project task association |
| POST | `/{source_id}/decisions` | Feishu `adopt`, `ignore`, or `restore` |

Write bodies forbid extra fields and require a nonblank reason and current
`expected_version`. Every write requires `Idempotency-Key`. Adoption additionally
requires canonical `task_id` and nonempty unique `criterion_ids`. Browser input
cannot supply an actor, source author, source body, URL, evidence ID or snapshot.

## Persistence and transaction rules

Migration `0009_c_activity_records.py` has revision `0009`, parent `0008`.
`c_activity_records` uniquely identifies project/type/source UUID and stable source
identity. `c_activity_decisions` appends reason, actor, before/after state and an
immutable full source capture per resulting version. Downgrade refuses to erase
any existing C4 decisions. No A source table or D verification row is modified.

Current project members and the course teacher may write after verified-email,
active-project/course and frozen-baseline checks. Current course staff may read;
TA is read-only, and Admin status grants no project-content privilege. Cross-project
reads/writes fail before the source provider is called. Association/adoption
requires the task in the latest frozen plan; C3 also verifies task execution state
and every AC's actual task membership when creating a candidate.

Feishu triage begins at `candidate`; it may become `ignored` and be restored, or
become `adopted` once. Adoption resolves the source through the trusted port and
calls C3 `create_evidence` through a private, scope-bound resolved SourcePort.
The new evidence is **candidate**, not formal. Evidence, source snapshot, C4 state,
decision, idempotency responses and both outbox events commit in one transaction.
No implicit task start, formal adoption or D completion occurs.

Project row locks serialize C writers, and version compare-and-set plus unique
constraints prevent lost decisions and duplicate adoption. Permission is checked
again before an idempotent replay; a successful replay does not require A to remain
available. A changed request under the same key fails. Failed writes roll back all
records together. Stored history remains readable when the external adapter fails.

`source_changed` in C4 reads compares the current source with the last C4 decision
capture. This read flag does **not** mutate C3 evidence validity or invalidate D.
The separate trusted C3 SourcePort/source-change event and downstream D delivery
still need A/D integration. Outbox rows mean pending delivery, not sent notifications.

## Verification

`test_c_activity.py` exercises relational commands and adapter boundaries using an
explicit source fixture. `test_c_activity_http.py` checks HTTP validation/envelopes
and unavailable-provider behavior. `test_c_activity_postgres.py` contains actual
same-key and competing-command races, independent-record preservation, and guarded
empty/nonempty migration rollback. SQLite results do not establish PG locking;
run the PostgreSQL suite only against a configured disposable test database.

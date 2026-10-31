# C5 project file service

This delivery implements the C-owned project file lifecycle in the canonical
`services/api` application. The default A storage port returns **503**. It does
not upload bytes, manufacture receipts, issue fake links, or claim notification
delivery. Course-file publication remains a separate integration task; the
existing C5-04 frontend is still an explicitly labelled metadata demonstration.

## Ownership and assembly

- `app/modules/c/files_models.py`: `c_logical_files`, `c_file_versions`,
  `c_file_decisions`. The A `files` table and all B snapshots remain unchanged.
- `files_storage.py`: A's `StoragePort`, immutable receipt/link DTOs, defensive
  output validation, and the unavailable default dependency.
- `files_service.py`: authorization, queries, append-only version registration,
  official designation, CAS, audit and transactional outbox.
- `files_router.py` / `files_schemas.py`: canonical HTTP and typed contracts.
- Migration `0010_c_files.py`: revision `0010`, parent revision `0009`.

The canonical migration environment imports these models, and the existing C
router mounts `files_router.router` under `/api/v1`. Existing
`get_current_user` remains the authentication boundary and refuses demo headers
in production. Production storage wiring must explicitly replace
`get_storage_port`; it cannot be selected through a client request parameter.

## HTTP contract

All paths below begin with `/api/v1/projects/{project_id}`. All successful and
failed responses use the application's envelope and private/no-store headers.

| Method / path | Operation |
| --- | --- |
| `GET /files` | Scoped combined filters and pagination |
| `GET /files/{file_id}` | All retained versions and audit decisions |
| `POST /files` | Register the first draft from an A-verified upload receipt |
| `POST /files/{file_id}/versions` | Append a draft version from another receipt |
| `POST /files/{file_id}/designate` | Make the latest draft official |
| `GET /files/{file_id}/versions/{version_id}/link` | Authorize a fresh preview/download link |

Writes require a nonblank `Idempotency-Key` header and a nonblank `reason`.
Registration accepts only `receipt_id`, `category` (documents/images/exports),
and `reason`. Appending accepts `receipt_id`, the logical file's current
`expected_version`, and `reason`. Designation accepts `version_id`,
`expected_version`, and `reason`. Extra keys, including browser hashes, object
paths, actor IDs or URLs, are rejected. `expected_version` refers to the C
logical file's `lock_version`, **not** a B project/plan version.

Example registration body:

```json
{
  "receipt_id": "00000000-0000-4000-8000-000000000001",
  "category": "documents",
  "reason": "Register the completed upload after storage validation"
}
```

The illustrative UUID must be replaced with a real, unexpired receipt issued by
A. Submitting it to the default port returns 503 and creates no file/version,
audit, replay or outbox row.

List parameters: `category=all|documents|images|exports|archived`, `q`,
`file_type` (extension), `status=draft|current|superseded`,
`sort=updated_desc|updated_asc|name_asc|size_desc`, `page`, `page_size` (1–100,
default 10). Filters combine before counting and pagination. Search treats SQL
wildcards literally. Empty results return page 1; excessive pages clamp to the
last page. By default the list shows each current official version and latest
draft, while the archived category exposes superseded history. Sorting has
stable file/version tie breakers. Returned version IDs are immutable references;
raw storage coordinates and receipt IDs are not exposed.

## Authorization and transaction rules

Current project members and assigned course teachers/TA may read. Only verified,
active project members may write, and both project and course must be active.
Platform administrators and unrelated teachers get no implicit content access.
Preparation of project files does not require a frozen B baseline or plan.
Every link request repeats authorization; historical versions remain readable
to currently authorized users. Ended/archived contexts remain read-only.

Writers serialize on the canonical project row and use a conditional update on
the C logical file's `lock_version`. The logical name is case-insensitively
unique within the project. A new version may have a different original filename
(for example `report-v2.pdf`); it retains the existing logical file name and
stores the new name on that immutable version. Each receipt
may be registered only once. A stale lock version or different payload under
the same operation/key returns 409. Same-input retries reuse the original
operation but return the file's **current** state, so retrying an older official
designation cannot reactivate it. Permission/lifecycle checks precede replay.

Registration produces draft v1. Append produces a new draft while retaining the
old official pointer until explicit designation. Only the latest draft can be
designated. Stored byte metadata is never rewritten: status is derived from
the logical file's official/latest version numbers. Earlier versions, decisions
and B frozen references are retained. The service never rewrites B's references
or creates/modifies D verification results.

Each successful command stores one audit decision and one `file.created`,
`file.appended`, or `file.designated` outbox fact in the same transaction as
the file mutation and replay record. `delivered_at` remains null. A/D consumers
and member notification delivery are pending integrations, not completed work.
Internal service helpers never commit; HTTP uses the existing `commit_command`
boundary to roll back every row on validation/storage/database failure.

## A storage port requirements

`resolve_receipt(project_id, actor_id, receipt_id)` must independently verify
the completed upload and return an `UploadReceipt` bound to that project and
uploader. It must provide immutable provider/object/revision coordinates,
SHA-256, actual byte count (0–50 MiB), a safe filename and inspected MIME,
`status=completed`, `scan_status=clean`, and an aware future expiry. C validates
all fields again, including supported extension/MIME pairs, binding and expiry.
Metadata selected in a browser does not satisfy this boundary. A must guarantee
that an object revision cannot later return different bytes.

`sign_version(...)` must check the exact immutable object revision is available
and return a `StorageLink` bound to the requested project, actor and purpose.
Its HTTPS hostname must be in the trusted adapter's `allowed_download_hosts`,
without URL credentials, fragments, nonstandard ports or control characters.
Expiry must be in the next 15 minutes. The request cannot choose an allowlist,
hostname or target URL. C never fetches arbitrary returned URLs. The adapter
owns safe response Content-Type/Content-Disposition handling, especially for
preview responses. Transient adapter failure is 503, not deletion or success.

The C evidence `SourcePort` bridge to these immutable version IDs is a separate
integration boundary; this delivery does not silently switch evidence sources
or mark old evidence changed merely because another file version was appended.

## Validation

Local runs: **100 SQLite/HTTP cases and all 7 PostgreSQL cases passed**; scoped
Ruff passes. Windows HTTP tests need
local loopback access for asyncio's socket pair; they run without an external
HTTP server or the shared PostgreSQL container.

`tests/test_c_files.py` uses real relational SQLite persistence, FK enforcement,
rollback and explicit A-port test doubles. `tests/test_c_files_http.py` mounts
the real router on an isolated test application. They cover authority, state
changes before replay, malformed/foreign/expired/unscanned receipt output,
retained history, conflicts, failure rollback, query combinations and unsafe
signing output. The fake storage port exists only in tests.

`tests/test_c_files_postgres.py` contains three actual PostgreSQL race cases
(duplicate registration, competing append CAS and duplicate designation) and
four migration cases (empty rollback/reapply and refusal with history, outbox
or replay data). It
requires the disposable `C_TEST_DATABASE_URL`, creates/removes a unique test
schema and is skipped without that environment variable. These were executed
against the isolated local PostgreSQL database with migration upgrade/check;
SQLite is not evidence of PostgreSQL locking correctness.

Downgrade refuses to drop these tables if any file/version/decision or matching
outbox/replay row remains. Preserving/exporting that data requires a deliberate
migration plan; populated downgrade never silently deletes provenance.

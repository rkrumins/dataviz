# Building a Connector

> **Who this is for:** a team sending another system's catalog into a data source's graph through
> the HTTP API alone: a warehouse, a BI tool, a pipeline scheduler, a spreadsheet of record. It
> runs on a schedule or on every change, from a few rows up to files of several gigabytes. Each
> import can be published onto the published graph with no person in the loop, or left in a draft
> for review.
>
> **Related reading:**
> - the format's identity rules: [18 · Entity Identity](/docs/versioning-identity);
> - the pipeline inside: [Import / Export](/docs/versioning-import-export);
> - every route and refusal: the [Versioning API reference](/docs/versioning-api-reference);
> - credentials: the [Integration Quickstart](/docs/integration-quickstart).
>
> A working connector is in `docs/examples/connector/`.

A connector does five things. Each has a section below.

1. **Map** the source's records to import records, and write them as a file (§2–§4).
2. **Send** the file: in one request, or in resumable parts up to 10 GiB (§5).
3. **Import** it into a draft, which reconciles every row against the graph (§5).
4. **Publish** it: the import publishes itself, you publish it, or a person reviews it (§6).
5. **Follow** the jobs, and read what they did (§7).

Run it again on the same source and nothing changes. Change the source, and only what changed is
written.

```mermaid
sequenceDiagram
    participant C as Connector
    participant A as API
    participant W as Transfer worker
    C->>A: POST imports/uploads (fileName, size, format)
    A-->>C: uploadId, partBytes, parts, expiresAt
    par several at once
        C->>A: PUT uploads/{id}/parts/{n}
    end
    C->>A: POST uploads/{id}/complete?autoPublish=true
    A-->>C: 202 jobId, branchId
    W->>W: parse, then nodes, then edges, into the draft
    W->>W: queue the draft's publish job
    loop until finished
        C->>A: GET imports/{jobId}
    end
    A-->>C: completed, summary.publish = queued, jobId
    loop until finished
        C->>A: GET publish-jobs/{jobId}
    end
    A-->>C: completed, commitId: the file's deltas are on main
```

## 1. Before you start

### A key, and what it may do

Use a **service account's key** (`nxsat_…`) for anything that runs unattended: it acts as the
account, not as whoever made it, and keeps working when people leave. A personal key (`nxpat_…`)
acts as you. Make either as the [Integration Quickstart](/docs/integration-quickstart) shows. Send
it as `Authorization: Bearer nxsat_…` on every request.

| To do this | The key needs | Its account needs, in the workspace |
|---|---|---|
| Read the schema, template and jobs | Data: read | read on the data source |
| Dry-run a file (`…/imports/validate`) | Data: read | read |
| Import into a draft | Data: read & write | manage (Member or above) |
| Place what it creates in a view (`viewId`) | Views: read & write as well | edit on that view |
| Publish the import (`autoPublish`), publish a draft, merge a merge request | Data: read & write | **Publisher** (`workspace:datasource:publish`) |

A key never holds publish itself. It publishes where the person or service account it belongs to
publishes. Write main directly (bulk ingest), publish a draft, merge a review: all follow the same
rule. So a **Data: read & write** key whose account is a Publisher can advance the published graph.
Give such an account Publisher only where it should. The key's own **publish** switch is about
views, not data.

### Finding the ids

```bash
api() { curl -sS -H "Authorization: Bearer $SYNODIC_TOKEN" "$SYNODIC_URL$2" -X "$1" "${@:3}"; }

api GET /api/v1/admin/workspaces | jq -r '.[] | [.id, .name, ([.dataSources[].id] | join(" "))] | @tsv'
GID=$(api GET "/api/v1/$WS/versioning/resolve?dataSourceId=$DS" | jq -r .graphId)   # the graph_… id
```

- **`ws_…` and `ds_…`:** the workspace and the data source, from the first call.
- **`graph_…`:** the data source's versioned graph. A `404` means version control isn't on for the
  data source. A `bootstrap` object means it is still being turned on: wait until it is `null`.
- **`br_…`:** a draft. Every import answers with its own, as `branchId`.

The API explorer is at `/docs` on the API's host (`/viz-docs` through the app). It marks every
operation a key may call. A production deployment may turn it off (`API_DOCS_ENABLED`).

## 2. The record format

One record per node or edge, with the same columns in every format: an NDJSON line, a JSON object,
or a CSV, TSV or Excel row (where every cell is text). Version 1 only ever gains columns, so a
connector written against it keeps working.

| Columns | What they say |
|---|---|
| `kind` | `node` or `edge` |
| `urn`, `entity_id` | Which node a row is, as a pointer ([§3](#3-identity-point-at-nodes-dont-name-them)) |
| `entityType` | A node's type, one the data source's ontology names. Needed to create a node |
| `displayName`, `description`, `sourceSystem`, `layerAssignment` | A node's own fields |
| `qualifiedName` | A node's qualified name. Where no `urn` matches, an import finds a node by it |
| `tags` | A node's tags: a JSON list, or a `;`-separated cell. Tags a row adds are added to the node's tags; a stale exported row's removals apply too |
| `edgeType`, `confidence` | An edge's type (one the ontology names), and an optional confidence from 0 to 1 |
| `sourceUrn`, `targetUrn`, `source_entity_id`, `target_entity_id`, `sourceQualifiedName`, `targetQualifiedName` | How each end of an edge is found |
| `source.<field>`, `target.<field>` | An edge's end, found by a field of its node: the data source's identifier, or a field marked "Match imports by this" |
| `prop.<name>` | One property per column |
| `properties_json` | Properties too nested for a column, as a JSON object |
| `baseVersion` | The version an export wrote the row at. An exported row edited offline is merged with what changed since ([§4](#4-full-snapshots-and-deltas)) |
| `_op` | Blank (or `upsert`) creates or updates; `delete` deletes |

**What a row says, and what it leaves alone:**

- **A blank cell, or a property left out, keeps what the graph holds.** Send only what you know.
- **`\N` removes a property** (`null` in `properties_json`). `\NULL` and `\n` mean the same. A
  node's own fields (`description`, …) can't be cleared by an import: set them to a new value.
- **`_op=delete` deletes the node** a row points at, and the edges on it, and what it contains
  (its containment subtree, as the ontology says). An edge row with `_op=delete` deletes that edge.
- **A delete of something that isn't there is done already.** Whether it was deleted by an earlier
  run, or never existed, the row is unchanged, with the note "nothing to delete". So a delta sent
  twice is safe, and the dry run counts such rows in a hint, since a mistyped name lands there too.

**Three ways to learn a data source's columns:**

- **The schema.** `GET /api/v1/{ws}/versioning/graphs/{graphId}/imports/schema` is the JSON Schema
  (draft 2020-12) of one record, narrowed to the data source: its entity and edge types as enums,
  and its properties typed. Validate what you write against it in your own CI.
  - The generic version is committed at `backend/common/schema/import-record.v1.json`.
  - `X-Schema-Version` is the format's version.
  - The schema follows the ontology, so cache it by its `ETag`: `If-None-Match` answers `304` while
    nothing changed.
- **The template.** `GET …/imports/template?format=xlsx|csv|ndjson` gives every column the data
  source can carry, with a worked row of each entity type and an edge of each relationship type.
  The Excel one explains every column on its Columns sheet, and names the identifier property.
- **An export.** It is what a round trip looks like, with real data.

```bash
api GET "/api/v1/$WS/versioning/graphs/$GID/imports/schema" > import-record.json
```

**Formats.**
- **NDJSON, CSV and TSV are read a line at a time,** so they go up to 10 GiB. NDJSON is the format
  for a program: a CSV parses about a fifth slower (§9).
- **A JSON array and an Excel workbook are read whole,** so they stay at 100 MB.
- **Line breaks.** A CSV cell may hold one inside quotes. A line, or a quoted CSV record, longer
  than 16 MB fails the import, naming the line; it is almost always CR-only line endings or a quote
  left open.
- **Encodings.** UTF-8, with or without a BOM, and Windows-1252 are both read.

## 3. Identity: point at nodes, don't name them

The platform names every node itself (a `urn:uuid:`), so ids stay stable and opaque. A file's ids
are **pointers**:

- **`urn` is your system's name for the thing.** Use one that never changes, such as
  `urn:acme:table:sales.orders`. The first import creates the node with an id derived from that
  urn. Every later import finds it by the same urn, so re-running a file updates instead of
  duplicating — whichever draft it goes to, in a fork, or after the graph is made again. The urn
  is not stored on the node.
- **The data source's identifier property** (`prop.<identifier>`) is a pointer too, for a source
  identified by it. It is reserved: the node's identifier holds its platform urn.
- **A `urn:uuid:` your system already gave the entity** is kept as its id. Use that when the same
  entity must have the same id in several environments.
- **`entity_id` is file-local.** It links rows of one file — an edge to a node row — and nothing
  more, unless it is a node's real id, as in an export. A row that points by nothing else is
  created again on every import.
- **Keep your own key as a property** if people should see or search it: `prop.sap_id`. Mark the
  field "Match imports by this" in the ontology to match rows by it, and "Must be unique" to keep it
  unique.
- **An edge finds its ends the same way:** `sourceUrn` / `targetUrn`, `source.<field>` /
  `target.<field>`, or `source_entity_id` / `target_entity_id` (another row's file id). An edge
  itself is its two ends and its type, so sending it again changes nothing. To re-point an edge,
  delete its row and add a new one.

## 4. Full snapshots and deltas

| You send | Use | What happens |
|---|---|---|
| Only what changed | `reconcileMode=upsert` (the default) | Rows set what they name and leave the rest. Deletes are `_op=delete` rows. |
| Everything in a scope, every time | `reconcileMode=replace`, with `viewId` for the scope | The same as upsert, and what the file leaves out of the scope is deleted. With no `viewId`, the scope is the whole data source. |

- **Unchanged rows cost nothing.** An import writes only fields that differ, so a full snapshot
  run nightly writes only that day's changes.
- **A replace deletes nothing while any row is refused,** since the refused row might name what it
  means to keep. The job fails, and the file's other rows stay on its draft.
- **A row without `baseVersion` sets what it carries.** A connector's own rows are the source's
  truth: if two runs write one field, the later wins.
- **A row an export wrote carries `baseVersion`,** and is merged with what changed since: only the
  cells it changed apply, and one someone else also changed refuses the row, naming the field.
- **One row per entity.** When two rows of a file name one node or edge and say different things,
  the second is refused. Send each entity once per file.

## 5. Sending the file

| File | Send it with |
|---|---|
| Up to 100 MB (32 MB behind the Helm chart's ingress) | `POST …/imports?format=ndjson&idempotencyKey=…`, with the file as the body |
| Up to 10 GiB (NDJSON, CSV or TSV) | The resumable upload, below. Use it for anything over a few MB: every part is small, and a dropped connection costs one part |

**The resumable upload, step by step:**

1. **`POST …/imports/uploads`** `{"fileName": "catalog.ndjson", "size": 4294967296, "format": "ndjson"}`.
   - It answers `201` with `uploadId`, `partBytes` (16 MiB), `parts`, `received` (`[]`) and
     `expiresAt`.
   - A file too large for its format is refused here, `413`, before any of it is sent.
2. **`PUT …/imports/uploads/{uploadId}/parts/{n}`** for `n` from `0` to `parts - 1`, each with its
   bytes as the body.
   - Every part holds exactly `partBytes`, and the last holds the rest; a part of the wrong size is
     `422`.
   - Parts go in any order, and several at once.
   - Sending a part again replaces it — until the upload is completed: then it is `409`.
3. **`GET …/imports/uploads/{uploadId}`** lists `received`, the parts stored whole. To resume after
   a failure or a restart, send the others. Keep `uploadId`, or you start again: a new upload knows
   nothing of an old one.
4. **`POST …/imports/uploads/{uploadId}/complete`**, with `reconcileMode`, `viewId`, `branchId` or
   `autoPublish` as query parameters.
   - It answers `202` with `jobId` and `branchId`.
   - An upload is imported once, however often it is completed: asking again — after a lost
     answer, or twice at once — answers with the same import. One that broke off before its import
     was queued is queued then.
   - A part still missing is `409`.

**Timing and the uplink.**
- **Each request has 120 s.** A 16 MiB part must arrive within that, so N parts at once need about
  N × 1.1 Mbit/s: 3 need 3.4 Mbit/s and 4 need 4.5 Mbit/s. On a slow link, send fewer at once.
- **An upload has 24 hours** from its creation (`expiresAt`) to be completed. After that, its
  parts are swept, and `GET` answers `404`.
- **What's checked.** Parts are checked by their exact size, and TLS carries them intact. There is
  no checksum, so make sure that an upload you resume is of the same file: the reference connector
  keys it by the file's sha256.

**Where it lands.**
- **A draft, every time.** Without `branchId`, an import opens a draft of its own. With it, the
  import stacks onto your open draft (one import at a time per draft: `409 job_active` while
  another runs).
- **`main` is never written by the import itself:** only by its publish (§6).
- **`idempotencyKey`** on the single request is permanent per graph. The same key from the same
  caller always answers with the job it started, whatever happened to that job since, and whatever
  `branchId` it is sent with. So derive it from the file and the run, such as
  `nightly-2026-11-05-<sha256>`, not from the file alone: a key whose job failed would otherwise
  answer with that failure forever. Only a job whose file never arrived is taken back by its key.

## 6. Publishing

An import lands in a draft. Three ways on from there:

| Way | How | Needs |
|---|---|---|
| **The import publishes itself** | `autoPublish=true` when you start the import | Publisher, and a data source that lets people merge their own changes |
| **You publish the draft** | `POST …/branches/{branchId}/publish` `{"message": "…"}` | the same |
| **A person reviews it** | `POST …/branches/{branchId}/merge-requests` `{"title": "…", "reviewers": […]}`; once approved, `POST …/merge-requests/{prId}/merge` | merging: Publisher. A service account's own managers can't approve its reviews (four eyes) |

### `autoPublish`: an import that publishes itself

Ask for it on `POST …/imports` or on `…/uploads/{id}/complete`. It is checked before anything is
created:
- **`403 publish_required`:** the caller can't publish. For a key, its account isn't a Publisher.
- **`409 review_required`:** the data source's review policy says nobody merges their own changes.
- **`422 auto_publish_needs_own_draft`:** you sent `branchId`. An import that publishes itself
  opens a draft of its own, so it never publishes anyone else's work.

When the import completes, `summary.publish` on its job says what happened:

| `summary.publish.state` | What happened | What to do |
|---|---|---|
| `queued`, with `jobId` | The draft is being published, as a large publish is: a job | Follow `GET …/publish-jobs/{jobId}` to `completed` (with `commitId`) or `failed` (with `error`) |
| `unchanged` | The file changed nothing. Its empty draft was closed | Nothing |
| `skipped`, with `reason` | It wasn't published, and the draft is kept for review | Read `reason.type` (below) |
| missing, a minute after `completed` | The worker stopped between the two steps | Publish the draft yourself: `POST …/branches/{branchId}/publish` |

Why a publish is skipped (`reason.type`):
- **`rows_refused`:** some rows weren't imported (refused or unreadable). Look at the import's
  preview, fix the file, and send it again; or fix the draft and publish it.
- **`not_up_to_date`, with `behindBy`:** someone published to the same data source while the file
  was imported, so the draft is behind `main`.
  - A small draft can be updated from main (`POST …/branches/{branchId}/rebase`) and published.
  - A draft of millions of changes can't: updating it reads every change at once. Import the file
    again instead, and keep other publishing to that data source out of the import's window.
- **Others:** the refusal the publish route would give: the draft closed meanwhile
  (`branch_closed`), the policy changed (`review_required`), …

The publish job checks again, when it runs, that the import's owner may still publish. The review
policy as it is then holds too.

## 7. Following a job

`GET …/imports/{jobId}` (and `GET …/publish-jobs/{jobId}`) is read-only, so poll it as often as you
like. Every few seconds at first, and every 30 s or so for a long job, is plenty.

| Field | Means |
|---|---|
| `status` | `pending`, `running`, `completed`, `failed`, `cancelled` |
| `phase` | Where it is: `queued`, `parse` (reading the file into staged rows), `nodes`, `edges`, `replace` (the deletes of a replace) |
| `processed`, `total`, `progress` | Rows applied so far, rows in the file, and a percentage |
| `queuedAhead` | While queued: the jobs before it |
| `stale` | Running, but its worker has gone quiet. Another worker takes it over and resumes it: wait |
| `attempt` | Which attempt this is. A job taken over more than 3 times fails |
| `errorMessage`, `summary.failure` | Why it failed, and whether starting it again would help |
| `summary` | The tallies: `new`, `updated`, `unchanged`, `deleted`, `invalid` (refused), `skipped` (records that are neither a node nor an edge), `viewAssignments`, `publish` |

- **The preview.** `GET …/imports/{jobId}/preview` lists changed rows, up to 200, with the reason
  for each refused one. For the whole change, read the draft's diff against `main`:
  `GET …/diff/summary?branchId={branchId}`.
- **Refused rows don't stop the others.** A refused row is quarantined with its reason, and the
  rest import.
- **An import survives its worker.** A deploy or a crash hands it to another worker, which carries
  on from its last window of 10,000 rows. A publish job is safe to run again: a draft is never
  published twice.

## 8. Errors and retries

Errors come back as `{"detail": …}`: a sentence, or an object with a `type`, `code` or `error`
(see [API Guide → Errors](/docs/api-guide)). What an import connector meets:

| Status | `detail` | Means | Retry? |
|---|---|---|---|
| `401` | `api_key_expired`, … | The key isn't accepted | No: fix the key |
| `403` | `missing_permission`, `publish_required`, `api_key_read_only`, `api_key_out_of_scope` | The key, or its account, may not | No |
| `404` | | An unknown graph, job or draft, or an upload that expired | No |
| `409` | `job_active` | Another import is running on that draft | Yes: wait for it |
| `409` | `branch_closed`, `main_write_forbidden`, `review_required`, `not_up_to_date` | The draft can't take this | No: see §6 |
| `409` | `idempotency_key_reused` | The key started another kind of job | No: use a new key |
| `409` | parts missing (a sentence) | The upload isn't complete | Send the missing parts |
| `413` | | Too large: for the request (use the upload), the format (split the file), or the dry run (8 MiB) | No |
| `422` | | A file that can't be read, or a part of the wrong size | No: fix it |
| `429` | `rate_limited`, `PROVIDER_BUSY` | Too many requests: a key has 1,200 a minute | Yes, after `Retry-After` |
| `503` | `lock_busy`, `DB_UNAVAILABLE`, `api_keys_unavailable` | Busy or out of reach for a moment | Yes, after `Retry-After`, else a few seconds |
| `504` | `REQUEST_TIMEOUT` | The request ran out of time, which may have been after it did its work | Read the state before you write again |

Every call an import connector makes does no harm sent twice:
- a part replaces itself;
- completing an upload answers with its import;
- a single request with an `idempotencyKey` answers with its job;
- a publish sent twice finds its draft published: `409 branch_closed` with the draft `merged`.

## 9. Large files

Measured end to end over HTTP on one machine, through the reference connector with `--publish`. The
setup:
- 4 vCPU and 15 GB RAM;
- Postgres 16 with default settings, holding the parts (the `database` store);
- the API and one transfer worker.

The data: tables, each with 10 columns, `CONTAINS` and `FLOWS_TO` edges, and about 120 bytes per
row.

| Run | File | Rows | Upload | Import | Publish | Peak memory |
|---|---|---|---|---|---|---|
| NDJSON | 53 MB | 440,000 | under 1 s (4 parts) | 125 s, about 3,500 rows/s | 65 s | worker 410 MB, API 385 MB, connector 140 MB |
| CSV, the same rows | 30 MB | 440,000 | under 1 s (2 parts) | 155 s, about 2,800 rows/s | 65 s | as above |

**What follows for a 2–4 GB file:**

- **Time.** At these rates, a 4 GB NDJSON file of rows like these (about 35 million) imports in
  about 3 hours and publishes in about 1.5. A 2 GB one takes half that. Rows of 250 bytes halve the
  row count, and roughly the time. A CSV takes about a quarter longer to import.
- **Memory** stays flat: windows of 10,000 rows, whatever the file's size.
- **The upload** is the quick part. 16 MiB parts at 4 at a time fill the link, and at
  100 Mbit/s a 4 GB file is up in about 6 minutes.

**What to set up for gigabyte imports:**

- **Disk, first of all.** An import writes far more into Postgres than its file holds. In this run, the graph took about
1.4 GB for the 53 MB file: every entity is kept twice, as the draft's version and the published
copy, with their indexes, about 3.2 KB per entity. The import's staged rows took about 0.8 KB per
row more, and are kept for 7 days (`IMPORT_STAGING_GC_DAYS`). That is about 27 times an NDJSON file
of short rows: for 4 GB of them, about 110 GB of graph and 28 GB of staged rows. Size Postgres for
it before the first gigabyte import. The in-cluster Postgres volumes are 10–20 Gi.
- **The object store.**
  - The default keeps uploaded parts in Postgres, where they compress well.
  - Above about 1 GB, set `OBJECT_STORE_BACKEND=s3` (an image with `requirements-s3.txt`), or
    `local` on a volume every API and transfer-worker pod mounts. Parts are swept a day after they
    arrive.
- **Proxies.** Parts are 16 MiB, under every limit on the way, so the resumable upload needs
  nothing raised.
  - Behind the Helm chart, a single-request import over 32 MB is refused by the ingress
    (`ingress.annotations."nginx.ingress.kubernetes.io/proxy-body-size"`). The app takes up to
    100 MB.
  - Every proxy must allow a request at least 120 s.
- **One import at a time per draft, two per worker.** `GRAPHVER_TRANSFER_SLOTS` (2) jobs run at
  once on each transfer worker. Run more workers for more at once.
- **Keep main quiet while a large import runs.** An import that publishes itself needs `main` not
  to have moved since it began (§6).

## 10. Walkthroughs

### A small file, with curl

```bash
export SYNODIC_URL=https://synodic.example.com SYNODIC_TOKEN=nxsat_…
api POST "/api/v1/$WS/versioning/graphs/$GID/imports/validate?format=ndjson" \
    --data-binary @catalog.ndjson | jq '{summary, unknownColumns, hints, refused: [.rows[] | select(.op == "invalid")]}'
JOB=$(api POST "/api/v1/$WS/versioning/graphs/$GID/imports?format=ndjson&autoPublish=true&idempotencyKey=nightly-$(date +%F)" \
    --data-binary @catalog.ndjson | jq -r .jobId)
until api GET "/api/v1/$WS/versioning/graphs/$GID/imports/$JOB" | jq -e '.status | test("completed|failed")' >/dev/null; do sleep 5; done
api GET "/api/v1/$WS/versioning/graphs/$GID/imports/$JOB" | jq '{status, summary}'
```

The dry run takes up to 8 MiB and 10,000 rows, reads them as an import would, and writes nothing.
It reports:
- `summary`: how many rows would be new, updated, unchanged, deleted or refused;
- `rows`: up to 200 changed rows, with their reasons;
- `unknownColumns`: usually a typo (`prop_owner` for `prop.owner`);
- `hints`.

For a larger file, dry-run its first rows. An edge whose end node comes later in the file reads as
refused there.

### A large file, with the reference connector

```bash
pip install httpx
export SYNODIC_URL=https://synodic.example.com SYNODIC_TOKEN=nxsat_…
python docs/examples/connector/connector.py --file catalog.ndjson --workspace "$WS" --graph "$GID" --check
python docs/examples/connector/connector.py --file catalog.ndjson --workspace "$WS" --graph "$GID" --publish
```

What the connector does:
- **Sending:** 4 parts at a time from disk, each retried after `Retry-After` on `429`/`503`, or
  after a growing pause on other `5xx` and dropped connections.
- **Resuming:** a run that stops is resumed by the next one, from `catalog.ndjson.upload.json`.
- **Following:** the import, then its publish. If the import never wrote how its publish went, it
  publishes the draft itself.
- **Exit code:** non-zero when the import fails or couldn't publish itself, with the reason in its
  output.

Given a catalog instead of `--file`, it maps one first: `source.json`, a warehouse's tables, columns
and lineage, and a table it dropped. `backend/tests/test_connector_example.py` holds it to the
record contract, and its calls to the routes a key may call.

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `413` on `POST …/imports` | Over 100 MB, or over 32 MB behind the Helm ingress | Use the resumable upload |
| Parts keep timing out (`504`, or the client's own timeout) | The uplink can't carry that many 16 MiB parts within 120 s | Send fewer at once |
| `404` resuming an upload | It expired (24 h), or it is another caller's | Start a new upload |
| `409` on a part | The upload is complete | Start a new upload to send a different file |
| The job failed: "Line N … has no line break within 16 MB" | CR-only line endings, or no line breaks | Save the file with LF or CRLF line endings |
| The job failed: "… opens a quoted cell that doesn't close" | A CSV quote left open | Close the quote, or escape it as `""` |
| `summary.invalid` > 0, and `publish.state: skipped` | Rows refused: unknown types, missing ends, … | Read the preview's reasons, fix the file, send it again |
| `publish.reason.type: not_up_to_date` | Something was published to the data source mid-import | Update a small draft from main and publish it; import a large file again |
| `403 publish_required` with `autoPublish` | The key's account isn't a Publisher | Give the account Publisher, or import without `autoPublish` and have a person publish |
| Every run creates new nodes | Rows point by `entity_id` alone, which is file-local | Give each node a stable `urn` |
| `stale: true` for a while | The worker running the job stopped | Wait: another takes it over and resumes it |
| A delete row is `unchanged` with "nothing to delete" | What it names isn't in the graph | Fine for a delta sent again; otherwise check the name |

## 12. The format's versioning

- **Version 1 only gains columns.** An import ignores columns it doesn't know, and the dry run
  reports them.
- **A change to how v1 rows are read is announced in the [changelog](/docs/changelog)** before it
  ships, under **Changed**, with what to do (for example, rows exported with `baseVersion` merged
  field by field, or deletes of what's gone counting as done).
- **A breaking change would be version 2,** with its own schema, alongside version 1 for at least a
  release. `X-Schema-Version` on the schema says which a server speaks.

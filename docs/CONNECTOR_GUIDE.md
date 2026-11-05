# Building a Connector

> **Who this is for:** a team sending another system's catalog — a warehouse, a BI tool, a
> pipeline scheduler, a spreadsheet of record — into a data source's graph, on a schedule or on
> every change, through the HTTP API alone. The format and its rules are in
> [18 · Entity Identity](/docs/versioning-identity) and
> [Import / Export](/docs/versioning-import-export); the routes and their refusals in the
> [Versioning API reference](/docs/versioning-api-reference); credentials in the
> [Integration Quickstart](/docs/integration-quickstart). A working example is in
> `docs/examples/connector/`.

A connector does six things. Each is a section below.

1. **Map** the source's records to import records.
2. **Write** them as one file — NDJSON for a program.
3. **Check** the file without importing it.
4. **Import** it into a draft, safely retried.
5. **Wait** for the job, and read what it did.
6. **Publish** — a person, or a reviewed merge request.

Run it again on the same source and nothing changes. Change the source and only what changed is
written.

## 1. The record format

One record per node or edge, the same columns in every format: an NDJSON line, a JSON object, or a
CSV, TSV or Excel row (where every cell is text). Version 1 only ever gains columns, so a connector
written against it keeps working.

| Columns | What they say |
|---|---|
| `kind` | `node` or `edge` |
| `urn`, `entity_id` | Which node a row is, as a pointer ([§2](#2-identity-point-at-nodes-dont-name-them)) |
| `entityType`, `displayName`, `qualifiedName`, `description`, `sourceSystem`, `layerAssignment`, `tags` | A node's own fields |
| `edgeType`, `sourceUrn`, `targetUrn`, `source_entity_id`, `target_entity_id`, `sourceQualifiedName`, `targetQualifiedName`, `confidence` | An edge, and how each end is found |
| `prop.<name>` | One property per column |
| `source.<field>`, `target.<field>` | An edge's end, found by a field of its node |
| `properties_json` | Properties too nested for a column, as a JSON object |
| `_op` | Blank (or `upsert`) creates or updates; `delete` deletes |

**Three ways to learn a data source's columns:**

- **The schema.** `GET /api/v1/{ws}/versioning/graphs/{graphId}/imports/schema` is the JSON Schema
  (draft 2020-12) of one record, narrowed to the data source: its entity and edge types as enums,
  and its properties typed. Validate what you write against it in your own CI. The generic
  version is committed at `backend/common/schema/import-record.v1.json`. `X-Schema-Version` is the
  format's version, and `If-None-Match` with the `ETag` answers `304` while nothing changed.
- **The template.** `GET …/imports/template?format=xlsx|csv|ndjson` gives every column the data
  source can carry, with a worked row of each entity type and an edge of each relationship type.
  The Excel one explains every column on its Columns sheet.
- **An export.** It is what a round trip looks like, with real data.

```bash
api GET "/api/v1/$WS/versioning/graphs/$GID/imports/schema" > import-record.json
```

## 2. Identity: point at nodes, don't name them

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
  itself is its two ends and its type, so sending it again changes nothing.

## 3. Full snapshots and deltas

| You send | Use | What happens |
|---|---|---|
| Only what changed | `reconcileMode=upsert` (the default) | Rows set what they name. A blank cell, or a property left out, keeps what the graph holds. `\N` removes a property (`null` in `properties_json`). `_op=delete` deletes a node by its pointer. |
| Everything in a scope, every time | `reconcileMode=replace`, with `viewId` for the scope | The same as upsert, and what the file leaves out of the scope is deleted. A file with unreadable or refused rows deletes nothing. |

Unchanged rows cost nothing: an import writes only fields that differ. So a full snapshot run
nightly writes only that day's changes.

## 4. Sending the file

| File | Send it with |
|---|---|
| Up to 100 MB | `POST /api/v1/{ws}/versioning/graphs/{graphId}/imports?format=ndjson&idempotencyKey=…` with the file as the body |
| Up to 10 GiB (NDJSON, CSV or TSV) | `POST …/imports/uploads` `{fileName, size, format}`, then `PUT …/uploads/{id}/parts/{n}` with each part of exactly `partBytes`, then `POST …/uploads/{id}/complete`. `GET …/uploads/{id}` says which parts arrived, so a broken upload resumes. |

- **`idempotencyKey` makes a retry safe.** The same key from the same caller answers with the job it
  started, never a second import. Derive it from the file's content, so a retried run of the same
  file reuses it.
- **`branchId` stacks onto your open draft.** Without it, an import opens a draft of its own. An
  import never writes `main`.
- **Credentials.** A service account's key (`nxsat_…`) with manage on the data source. See the
  [Integration Quickstart](/docs/integration-quickstart).

## 5. Check first: the dry run

```bash
api POST "/api/v1/$WS/versioning/graphs/$GID/imports/validate?format=ndjson" \
    --data-binary @catalog.ndjson | jq '{summary, unknownColumns, refused: [.rows[] | select(.op == "invalid")]}'
```

`POST …/imports/validate` reads the file exactly as an import would and writes nothing: no draft,
no job. It answers:

- `summary`: how many rows would be new, updated, unchanged, deleted or refused, and how many
  records weren't rows at all;
- `rows`: the changed rows, up to 200, each with its `op`, the entity it matched (or the id it
  would be created as) and the reasons for a refusal;
- `unknownColumns`: columns the format doesn't name, usually a typo (`prop_owner` for
  `prop.owner`), which an import ignores.

Add `branchId` to check against a draft. It takes one window of rows (10,000) and 8 MiB; past
that, import into a draft, which is itself a dry run until it is published. A strict graph's write
gate, which runs at commit, can still refuse a row the dry run passes.

## 6. Wait, read, publish

- **`GET …/imports/{jobId}`** — `status` (`pending`, `running`, `completed`, `failed`,
  `cancelled`) and `summary`.
- **`GET …/imports/{jobId}/preview`** — the changed rows, with the reason for each refused one.
  A refused row is quarantined: the rest still import.
- **Publishing.** An API key can't publish. Open a merge request from the draft for a person to
  review and merge, or leave the draft for its owner. Nothing reaches `main` before that.

## 7. The reference connector

`docs/examples/connector/connector.py` does all of the above in about 150 lines, with only
`httpx`. It turns `source.json` — a warehouse's tables, columns and lineage, and what it dropped —
into records with urns of its own (`urn:acme-warehouse:table:…`). It then checks the file, imports
it under a key drawn from the file (in parts when the file is large), and waits for the job.
`backend/tests/test_connector_example.py` holds it to the record contract and to the API's shape.

```bash
SYNODIC_URL=https://… SYNODIC_TOKEN=nxsat_… \
    python docs/examples/connector/connector.py docs/examples/connector/source.json \
    --workspace "$WS" --graph "$GID" --check
```

## Guarantees and limits

- **Re-running a file is safe.** The same urns find the same nodes, and the same edges are the
  same edges.
- **A row can't break the batch.** A refused row is quarantined with its reason, and the rest
  import.
- **Version 1 only gains columns.** Unknown columns are ignored by an import and reported by the
  dry run.
- **A row without `baseVersion` sets what it carries.** A connector's own rows are the source's
  truth: two runs writing one field, the later wins. A row an export wrote carries `baseVersion`,
  and is merged with what changed since: only the cells it changed apply, and one someone else
  also changed refuses the row, naming the field.
- **One row per entity.** When two rows of a file name one node or edge and say different things,
  the second is refused. Send each entity once per file.
- **Your id, kept.** A `urn` finds its node again but isn't stored. To see the source's own id on
  the node, send it in a property too, and mark that property "Match imports by this".

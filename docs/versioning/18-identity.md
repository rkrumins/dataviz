# 18 · Entity Identity

> **Audience & scope:** engineers, reviewers and integrators. What an entity's id is, how the
> platform mints one, which ids it derives from a source instead, how a request is made safe to
> send again, and how properties are added, changed and removed by import, export and the API.
> How an import matches rows is in [08 · Import / Export](08-import-export.md); the routes are in
> [06 · API Reference](06-api-reference.md); every behaviour change is in the
> [CHANGELOG](../../CHANGELOG.md).

**Checked against the code on 2026-11-04.**

**TL;DR.** Every node and edge the platform creates is named `urn:uuid:<uuid>`: RFC 9562's URN
form of a UUID, lowercase. One module mints these ids (`backend/app/services/versioning/ids.py`),
and a test fails the build when a write path mints one any other way. A new entity's id is a
**UUIDv7**. UUIDv7s are time-ordered, so inserts keyed by them stay sequential at millions of rows,
and they are unique without a database round trip. An id that a retried request must mint again is
a **UUIDv5** named by the request's key. A node has one identity: its id, its urn and the data
source's identifier property hold the same value. An id is opaque. An entity's type and origin are
its own fields, never read from its id, so an id never goes stale. Ids that already exist, and ids
derived from a source, are kept as they are.

---

## 1. The form

| | |
|---|---|
| **Form** | `urn:uuid:` plus the 36-character 8-4-4-4-12 form of the UUID, lowercase, 45 characters in all: `urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f70` |
| **A node** | Its `entity_id`, its `urn` and its identifier property hold the same value. The identifier property is set in the data source's node identity settings. |
| **An edge** | Its id is its `entity_id`. Its ends name nodes by urn. |
| **Opaque** | Nothing parses an id. Type, origin and names are the entity's own fields. |
| **Existing ids** | Kept. A string a graph already uses (`urn:synodic:…`, `ent_…`, a provider's urn) stays a valid id. |

`uuid_urn(value)` gives the canonical form of a `urn:uuid:` in any case, and `None` for anything
else. A bare UUID, a UUID in braces, or 32 hex digits without hyphens is not one, because an id is
the whole string.

## 2. Minting

### A new entity: UUIDv7 (`new_entity_id`)

The layout is RFC 9562 §5.7: a 48-bit Unix-millisecond timestamp, the version `7`, then 74 random
bits split 12 and 62 around the variant `10`.

- **Monotonic within a process** (RFC 9562 §6.2, method 2).
  - Within one millisecond, or when the clock steps back, the random field counts up from its last
    value, so ids minted back to back sort in mint order.
  - If the field runs out, the timestamp moves on to the next millisecond.
- **Independent across processes.** Each process starts each millisecond from its own random
  point, so two processes' ids collide only if their runs overlap within 2^74 values. Take 100
  processes minting a sustained million ids a second between them: the odds are about 1 in 6
  million a year.
- **Hand-written,** because `uuid.uuid7` is in Python's standard library only from 3.14 and CI runs
  3.11.
- **At scale.**
  - A new id needs no database round trip.
  - Inserts keyed by it go to the right-hand end of each graph's range in `entity_heads`
    (`graph_id, branch_id, entity_id`) and in `node_versions`' `ix_nv_urn`, not to random pages.
  - The text form sorts as the number does, so id columns stay `Text`.

### An id that must repeat: UUIDv5 (`derived_entity_id(kind, seed)`)

The id is `uuid5(ENTITY_NAMESPACE, "<kind>/<seed>")`.

- **`ENTITY_NAMESPACE`** is `f957ac52-8d28-4774-a953-af5a68dc6b11`. It is fixed for good, because
  changing it would rename every derived id.
- **`kind`** is `node` or `edge`, so one seed names a node and an edge apart.
- **Seeds are not secret.** SHA-1 names the entity here; it protects nothing.
- **A v5 never equals a v7,** because their version digits differ.

| Request | Seed |
|---|---|
| `POST /graph/changes` with an `Idempotency-Key`: a create whose client `ref` is at least 16 characters (as every canvas temp ref is) | `<graph>/<branch>/<actor>/ref:<ref>`, so a later save that still carries the same staged create names the same entity |
| Any other create in that save | `<graph>/<branch>/<actor>/key:<key>/<n>`, where `n` is its turn among them |
| `POST /graph/nodes/create` with `idempotencyKey`, or a `create_node` command of `/commands/batch` | `<data source>/<branch>/<actor>/<key>` |
| `POST /graph/edges` with `idempotencyKey`, or a `create_edge` command | the same |

## 3. Where each id comes from

| Path | A new node | A new edge |
|---|---|---|
| Canvas save, `POST /graph/changes` | v7, or v5 under an `Idempotency-Key` | the same |
| `POST /graph/nodes/create`, a `create_node` command | v7, or v5 with `idempotencyKey`. Its containment edge is v7. | — |
| `POST /graph/edges`, a `create_edge` command | — | v7, or v5 with `idempotencyKey` |
| A draft's `POST …/branches/{bid}/changes` | the create's `entityId`, else its payload's `urn`, else v7, which becomes its urn too | its `entityId`, else v7 |
| Import, `POST …/imports` ([08 §3b](08-import-export.md#3b-resolve-a-window-at-a-time)) | The entity a row matches. Otherwise: the row's urn (or its identifier value) when nothing holds it; else the deleted node that held it, brought back; else v7. | v7 |
| `…/bulk-ingest`, `…/sync` | the row's own id, else v7 | the same |

**Kept: ids derived from a source.** A re-sync or a resumed seed finds what it made by these ids,
so they stay:

- a provider's urn (DataHub, OpenMetadata, FalkorDB);
- a sync's `sync:<urn>`, for a row that brings a urn but no id;
- a bootstrap edge's `<source>|<TYPE>|<target>`;
- a view package seed's `stable_prefixed_id("ent", …)`, for a line with no id.

`tests/test_identity_minting_guard.py` lists each one, with the reason. Any other way of minting
an id fails the build.

## 4. Sending a request again

| Path | Key | Sent again, it… |
|---|---|---|
| `POST /graph/changes` | the `Idempotency-Key` header, up to 128 characters | Answers with the first commit and the entities as they are now, even if the draft has closed since. `uq_commits_idem` makes two racing attempts land once. |
| `POST /graph/nodes/create` | `idempotencyKey` in the body | Answers with the node the first request created, and writes nothing. |
| `POST /graph/edges` | `idempotencyKey` in the body | Answers with the edge the first request created, and writes nothing. |
| `POST …/imports`, `POST …/exports` | `?idempotencyKey` | Answers with the job the first request started. |
| `POST …/bulk-ingest`, `POST …/sync` | `?idempotencyKey` | Answers with the first commit (`idempotent_replay`). |

A key belongs to one caller on one branch. The same key from someone else, or on another draft, is
a new request.

**Running an import again** starts a new job. What happens to each row depends on how it names its
entity:

- A row that names an entity by `entity_id` or `urn` updates it. Every row of an export names its
  entity this way.
- A row from which the earlier import kept a urn (or an identifier value) is found by that value.
- A row whose field is marked as a team key ("Match imports by this") is matched by that field.
- A row that brings only the file's own `entity_id` is created again, because that id links the
  file's rows to each other and nothing more.

## 5. Adding, changing and removing properties

**By import, including an edited export:**

- **One column per property.** Each property has its own `prop.<name>` column.
  - A value sets the property, whether it is new or already there.
  - A blank cell leaves it as it is.
  - `\N` or `\NULL` removes it. In `properties_json`, a `null` does the same.
- **`_op` = `delete`** removes the entity.
- **An export writes the same columns,** plus `entity_id`, `urn` and `baseVersion`. A file edited in
  a spreadsheet re-imports as updates of exactly what changed. A row that changes nothing is counted
  `unchanged`, and nothing is written for it.
- **`reconcileMode=upsert`** (the default) touches only what the file names. `replace` also deletes
  what the file leaves out of its scope.

**By the API:**

- **`POST /graph/changes`:**
  - An `update` merges `payload.properties` key by key, so a property left out is kept.
  - `unsetProperties` names the properties to remove.
  - `baseVersion` (the `version` the client read) makes the update a three-way merge. A same-field
    edit made meanwhile is then a `409` with `current`, not an overwrite.
- **A draft's `POST …/branches/{bid}/changes`** merges, and takes `unsetProperties`, the same way.

**Large and incremental changes.** An incremental change is simply a batch or file of what changed.
Absent properties and blank cells are left as they are.

| Size | Send it as | How it lands |
|---|---|---|
| Up to 8 MiB a request (`MAX_REQUEST_BODY_BYTES`) | `POST /graph/changes` | One atomic commit per request. |
| Up to 100 MB (`MAX_IMPORT_BODY_BYTES`) | `POST …/imports`, with the file as the body | Windows of 10,000 rows, each one commit on the draft. Memory stays flat, and a job a worker drops is resumed. |
| Up to 10 GiB, as NDJSON, CSV or TSV | `POST …/imports/uploads`, then each part, then `…/complete` | The same, and the upload resumes part by part. |

## 6. Referencing an entity from outside

- **By its `urn`.** A node's urn is its id, and it never changes.
- **By a team's own reference,** such as a SAP id or a DataHub urn, kept as an ordinary property.
  - It imports and exports as `prop.<name>`.
  - Mark the field "Match imports by this" to match rows by it.
  - Mark it "Must be unique" to keep it unique.
  - Keep it out of the identifier property, which holds the node's urn.

## 7. Guarantees and non-goals

**Guaranteed:**

- An entity's id never changes. A deleted entity keeps its id, and restoring it brings it back
  under that id.
- Minting adds no query and no lock.
- Every write path mints through `ids.py`, and the guard test holds them to it.

**Not done:**

- Re-keying existing entities, which would rewrite their history.
- A native `uuid` column. Id columns stay `Text`, because they hold legacy and provider ids too.
- A per-data-source id format.

## 8. What changes for integrators

- **Don't parse urns.** A new one carries no type or origin; read `entityType` and the properties
  instead.
- **Searching by part of a urn** no longer finds new nodes by their type or origin.
- **Placement rules by urn pattern** (`urn:synodic:*:dataset:*`) don't place new nodes. Use an
  entity-type rule instead; the rule editor says so.
- **`POST /graph/edges` with `idempotencyKey`** names the edge with a v5 derived from the key, not
  with the key itself.

# 18 · Entity Identity

> **Audience & scope:** engineers, reviewers and integrators. What an entity's id is, how the
> platform mints one, which ids it derives from a source instead, how a request is made safe to
> send again, and how properties are added, changed and removed by import, export and the API.
> How an import matches rows is in [08 · Import / Export](08-import-export.md); the routes are in
> [06 · API Reference](06-api-reference.md); every behaviour change is in the
> [CHANGELOG](../../CHANGELOG.md).

**Checked against the code on 2026-11-11.**

**TL;DR.** Every node and edge the platform creates is named `urn:uuid:<uuid>`: RFC 9562's URN
form of a UUID, lowercase. One module mints these ids (`backend/app/services/versioning/ids.py`),
and a test fails the build when a write path mints one any other way. A new entity's id is a
**UUIDv7**. UUIDv7s are time-ordered, so inserts keyed by them stay sequential at millions of rows,
and they are unique without a database round trip. An id that a retried request must mint again is
a **UUIDv5** named by the request's key. A node's id never changes; its urn is the name a file or
a source gives it, which the data source's identifier property holds too, and is its id when it was
given none. An id is opaque. An entity's type and origin are
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
| `POST /graph/nodes/create` with `idempotencyKey`, or a `create_node` command of `/commands/batch` | `<data source>/<branch>/<actor>/<key>`. `<branch>` is `main` for every write to the published graph: fresh, catching up, external or versioned. So a retry names the same node while the first write is projected, and after the graph gains version control. A connection's engine uses its connection id in place of the data source. |
| `POST /graph/edges` with `idempotencyKey`, or a `create_edge` command | the same |
| A view package seed's line with no id | `<upload>:<offset>`, its place in the upload, so a resumed seed derives the same id |
| An imported node, named from its row's pointer | `<data source>/pointer:<pointer>`: the data source at the root of the graph's fork lineage, and the row's urn, else its identifier value (a `urn:uuid:` in canonical form). The same file imported again names the same nodes, in a fork or after the graph is made again. |
| An imported node, by a matching property (`identifier=prop.<name>`) | `<data source>/prop.<name>:<value>`: the same value sent again names the same node. A v7 instead when a live node already holds that id (its value has changed since). |
| An imported edge | `<data source>/edge:<source id>|<target id>|<TYPE>`: its ends' ids and its type, upper-cased. The same edge sent again, from any file or draft, or after a delete, is the same edge. |

## 3. Where each id comes from

| Path | A new node | A new edge |
|---|---|---|
| Canvas save, `POST /graph/changes` | v7, or v5 under an `Idempotency-Key` | the same |
| `POST /graph/nodes/create`, a `create_node` command | v7, or v5 with `idempotencyKey`. Its containment edge is v7. | — |
| `POST /graph/edges`, a `create_edge` command | — | v7, or v5 with `idempotencyKey` |
| A draft's `POST …/branches/{bid}/changes` | the create's `entityId`, else its payload's `urn`, else v7, which becomes its urn too | its `entityId`, else v7 |
| Import, `POST …/imports` ([08 §3b](08-import-export.md#3b-resolve-a-window-at-a-time)) | The entity a row names by the import's `identifier`. Otherwise: the deleted node its urn names, brought back; else a free `urn:uuid:` the row brings as its urn or (by `entity_id`) its entity_id, kept; else v5 derived from the row's urn or identifier value; else, for a row a qualifiedName or team key finds again, v7. A row that names nothing a later import could find it by is refused. The node keeps the urn its row gives (its id when it gives none); an identifier value finds a node and is not stored. | v5 of its ends and type |
| `…/bulk-ingest` | As an import mints it: a `urn:uuid:` the row brings (its `entity_id`, `id` or `urn`), kept; else v5 of its urn, as an import by urn derives it (`pointer_id`); else v5 of its own id; else v7. A node with no urn is given its id as its urn. A second row naming the same node is refused. | a `urn:uuid:` the row brings; else v5 of its own id; else v5 of its ends and type. A second row naming the same edge is refused |
| `…/sync` | The node already holding the row's urn — for a row with none, the id it derives, which a node made from it carries as its urn — else the one holding the row's own id (an id from before, whatever its format, a `urn:uuid:` in any case), else, for a row with no urn, the node holding the id it derives (the one it made, whatever urn it carries now; a deleted one is brought back), else the deleted node whose last urn it was, brought back, else as `…/bulk-ingest` mints it — and v7 when another node holds the id a row's urn derives. A row with no urn gives the node it makes, or finds by the id it derives, that id as its urn; one it finds by an id from before is taken as the row comes, as it always was | the edge already joining the two ends with that type, else the one holding the row's own id, else the deleted edge that last joined them with that type, brought back, else as `…/bulk-ingest` mints it (v7 when another holds it) |
| Enabling version control (`/graph/bootstrap`) | the node's urn, as the graph holds it | the edge's own id, else `<source>|<TYPE>|<target>` |
| A view package seed | the line's entity id, else v5; a line with neither an id nor a urn is named by that id, its urn too | the line's entity id, else v5 |

**Kept: ids derived from a source.** A re-sync finds what it made by these ids, so they stay:

- a provider's urn (DataHub, OpenMetadata, FalkorDB), which is also a node's id once its graph
  gains version control;
- a bootstrap edge's `<source>|<TYPE>|<target>`, for an edge with no id of its own;
- a sync's `sync:e:…`, which syncs gave an edge with no id before the routes minted v5s. A later
  sync finds such an edge by its ends and keeps its id;
- `sync:<urn>`, which syncs gave nodes before a new node was named by its urn. A later sync finds
  such a node by its urn and keeps its id.

`tests/test_identity_minting_guard.py` lists each one, with the reason. Any other way of minting
an id fails the build.

## 3a. Across the lifecycle: external and versioned graphs

An id is the same opaque string at every stage of a data source's life. Nothing reads a type or
an origin out of it.

| Stage | What happens to ids |
|---|---|
| **External graph** | Read live. The provider keys a node by `urn` and an edge by its `id`, as exact strings. A write needs version control (`409 versioning_not_enabled` without it). |
| **Enabling version control** | Each node's id becomes its urn, as the graph spells it, so a `urn:uuid:` keeps one identity. Edges keep their ids. The backfill sets each node's anchor (`n.entityId`) to that id, including where an earlier graph of the key left another. |
| **Operating** | The projection writes nodes by urn and edges by id. Forks read their root's store, so they share its ids. Freezing or moving a graph's key leaves ids alone. |
| **Abandoning a conversion** | The data source keeps its id. Enabling version control again makes a new graph, and its nodes are again named by their urns. |
| **Trash and restore** | Both ids stay. |
| **Purge** | The data source and its graph go. The customer's own key is never dropped. A new data source on that key names its nodes by their urns again. |

**Scopes that last.** A keyed create's id is scoped to the data source, not the graph, and
writes to main are always `main`. So a retry names the same entity while the first write is
projected, and after the graph gains version control. Across data sources (a new data source on a
key, or another environment), match an entity by its platform urn, which an export carries, or by a
team key.

**Not built yet:** detach, release of the original key and drift sync (doc 14). The rules above
keep them working once they are built: id = urn everywhere, the projection keyed by urn, and scopes
held by the data source.

## 4. Sending a request again

| Path | Key | Sent again, it… |
|---|---|---|
| `POST /graph/changes` | the `Idempotency-Key` header, up to 128 characters | Answers with the first commit and the entities as they are now, even if the draft has closed since. `uq_commits_idem` makes two racing attempts land once. |
| `POST /graph/nodes/create` | `idempotencyKey` in the body | Answers with the node the first request created, and writes nothing. |
| `POST /graph/edges` | `idempotencyKey` in the body | Answers with the edge the first request created, and writes nothing. |
| `POST …/imports`, `POST …/exports` | `?idempotencyKey` | Answers with the job the first request started, whatever has happened to it since, and whatever `branchId` it is sent with. |
| `POST …/imports/uploads/{id}/complete` | the upload itself | Answers with the import it started: an upload is imported once. |
| `POST …/bulk-ingest`, `POST …/sync` | `?idempotencyKey` | Answers with the first commit (`idempotent_replay`). |

A key belongs to one caller. On `/graph/changes` it also belongs to one branch, so the same key on
another draft is a new request there. An import's or export's key is the caller's for good on the
graph, on any draft. The same key from someone else is always a new request.

**Running an import again** starts a new job. What happens to each row depends on how it names its
entity, which the import's `identifier` says ([08 §3b](08-import-export.md#3b-resolve-a-window-at-a-time)):
`entity_id` (the default), `urn`, `prop.<name>`, or `prop.<name>,urn`. By a property, rows are
found through its index, which finds a node made or edited in the app since the last import too.
With `,urn`, a row without the property, or whose value no node holds yet, is found by its urn, and
that node takes the value.

- A row that names an entity by its `entity_id` updates it. Every row of an export does.
- A row's `urn`, or (by `entity_id`) its value of the identifier property, is a **pointer**. It finds
  the node that carries it as its urn, or the node an earlier import made from it, whose id was
  derived from it. So the same file imported again updates what it made, and creates nothing.
- By `entity_id`, a row whose field is marked as a team key ("Match imports by this") is matched by
  that field, and one with no urn by a unique qualifiedName. By `urn`, by neither.
- A row that brings only the file's own `entity_id` is refused (`no_key`): that id links the file's
  rows to each other and nothing more, so the row would be created again by every import, and
  under `reconcileMode=replace` each run would delete the node the previous run made.
- A row whose urn and identifier value point at two different entities is refused. So is a row,
  by `prop.<name>`, that would make a new node with a urn another node holds (`two_entities`):
  to change that node's value, send its `entity_id` with the new one. When that node holds no
  value of the property yet (a graph first loaded by urn), send `prop.<name>,urn` instead: the row
  finds the node by its urn, and the node takes the value.
- A matched row's urn or identifier value that names nothing is reported on the row, not applied.
  An import never changes a node's urn.
- A row an export wrote, imported after its entity changed, applies only the cells it changed; see
  [08 §4a](08-import-export.md#4a-offline-edits-are-reconciled-never-silently-lost).

Each identifier, walked through over the API with its requests and answers: [Export, edit offline, import back](../IMPORT_EXPORT_API.md).

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
  what the file leaves out of its scope, but never what a row of the file names, refused or not (a
  refused delete row keeps only what it matched), nor a node an edge row names as an end. With a property identifier,
  `replaceScope=keyed` deletes only what holds the property: nodes made in the app or by another
  source stay, with their edges, except an edge to a node the replace deletes, which goes with that
  node.

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
| Up to 10 GiB (`IMPORT_MAX_BYTES`; 100 MB as JSON or Excel) | `POST …/imports`, with the file as the body | Windows of 10,000 rows, each one commit on the draft. Memory stays flat, and a job a worker drops is resumed. |
| Up to 10 GiB, as NDJSON, CSV or TSV | `POST …/imports/uploads`, then each part, then `…/complete` | The same, and the upload resumes part by part. |

## 6. Referencing an entity from outside

- **By its `urn`.** An imported node keeps the urn its file gave it, and an import never changes
  it; a node made with none has its id as its urn. Neither ever changes the node's id.
- **By a team's own reference,** such as a SAP id or a DataHub urn, kept as an ordinary property.
  - It imports and exports as `prop.<name>`.
  - Mark the field "Match imports by this" to match rows by it.
  - Mark it "Must be unique" to keep it unique.
  - Keep it out of the identifier property, which is reserved: it holds the node's urn, and a
    file's value there finds a node and is never stored.
- **An identifier value beside a different urn** is a second name for the row's node, but only
  within that import. Later imports find the node by its urn.

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

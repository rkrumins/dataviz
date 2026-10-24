# Native read-only queries: security

*For security reviewers and operators.* People who may query a data source can
write their own Cypher and run it, read-only, on FalkorDB and Neo4j sources,
from the search panel's **Cypher** tab. This page says who can, what may run,
how read-only is enforced, what bounds every run, what is recorded, and what an
operator should set on the database to back it up.

The user guide is [Advanced Search](/guide/advanced-search#your-own-cypher); the
permission and the share opt-in are in [RBAC](/docs/rbac#native-queries).

---

## At a glance

| Question | Answer |
| --- | --- |
| Who | People with `workspace:native-query:read` and data-source access in the workspace (every role that reads data sources has it by default; revocable per role), or someone a View is shared with directly, when the share opts in to **Query data** — for that View's own data source only |
| Never | API keys, anonymous callers, a View's visibility (open to everyone or the whole workspace), drafts and branches |
| Where | FalkorDB and Neo4j data sources. Other stores answer `501` |
| What | One read-only Cypher statement. Writes, administration, files and URLs, other databases, plugins and parameters are refused before the engine sees the query |
| How much | Rows, time, reply size and response size are capped; each person and each data source are rate- and concurrency-limited |
| Recorded | Every run that reaches the guard, refused or not, in the activity log — committed before a row is returned |
| Switch | **Native read-only queries** (`nativeQueryEnabled`), a security switch: on by default, and off if its value can't be read |

A native query reads **the whole data source**, not only the View it starts
from. That is the point of it, and the reason it has its own permission and its
own opt-in on a share rather than following from reading a View.

---

## Who can run one

The route is `POST /api/v1/{ws_id}/graph/search/native`. In order:

1. **The switch.** With **Native read-only queries** off, every call is refused
   (`403`, `feature_disabled`) and the UI hides **Edit and run**.
2. **A person.** The route is not on the API-key surface
   (`backend/app/auth/api_key_surface.py`), so a key is refused before the
   handler runs, and the access check refuses a key's claims again. No
   anonymous caller reaches it.
3. **The published graph.** A `branchId` other than `main` is refused (`501`):
   native queries never read a draft.
4. **One of two ways in** (`backend/app/services/native_query/access.py`):
   - `workspace:native-query:read` together with data-source access in the
     workspace (`via: "permission"`); or
   - a direct share of the request's `viewId` — to the caller or a group they
     are in — that has **Query data** on (`can_query_source`), for that View's
     own data source only (`via: "grant"`). Visibility never counts: a View
     open to the organization or the workspace lets no one query its source.
5. **A FalkorDB or Neo4j source** (`501` otherwise).

A refused caller gets `403` with `"permission": "workspace:native-query:read"`,
and the refusal is recorded as `user.access_denied`, like any other.

**Turning Query data on** for a share needs both the right to manage the View's
shares and the right to query its data source yourself — nobody hands on a reach
they don't have. Turning it off needs only the right to manage the shares. An
opt-in stays until someone turns it off, even if the person who turned it on
later loses their own access; review shares from the View's **Share** dialog.

---

## What may run

The guard (`backend/app/services/native_query/guard.py`) reads the query as
tokens from one shared lexer — strings, escapes, backtick names, comments and
nesting — so a keyword inside a string, a comment or a backtick name is never
taken for one, and a word that can't be a keyword where it stands (a property,
a label, a map key) is left alone. It refuses, naming the position:

| Refused | Why |
| --- | --- |
| `CREATE`, `INSERT`, `MERGE`, `SET`, `DELETE`, `DETACH`, `REMOVE`, `FOREACH` | Writes to the graph |
| `DROP`, `ALTER`, `RENAME`, `GRANT`, `DENY`, `REVOKE`, `TERMINATE`, `START`, `STOP`, `ENABLE`, `DISABLE`, `DEALLOCATE`, `REALLOCATE` | Changes the database |
| `LOAD` (`LOAD CSV`) | Reads files or URLs from the database server |
| `USE` | Reads another database |
| `SHOW`, `EXPLAIN`, `PROFILE` | Not a query of the graph |
| `CYPHER …` options | Sets query options |
| `… IN TRANSACTIONS`, `PERIODIC COMMIT` | Batches writes |
| `CALL` of anything but the engine's read procedures | FalkorDB: `db.labels`, `db.relationshipTypes`, `db.propertyKeys`, `db.indexes`, `db.constraints`, and the `db.idx.fulltext.*` / `db.idx.vector.*` queries. Neo4j: `db.labels`, `db.relationshipTypes`, `db.propertyKeys`, `db.schema.visualization`, `db.schema.nodeTypeProperties`, `db.schema.relTypeProperties`, and the `db.index.fulltext.*` / `db.index.vector.*` queries |
| A namespaced function outside the built-ins | FalkorDB: `vec.*`, `string.*`, `list.*`. Neo4j: the temporal and spatial namespaces and `vector.similarity.*`. This keeps out `apoc.*`, `gds.*` and every plugin |
| A `$parameter` | A native query carries its values in its text |
| More than one statement | One statement per run |
| A carriage return, vertical tab, form feed, NEL or Unicode line or paragraph separator | Engines disagree on where a `//` comment ends at these, so text one engine runs as code must never be a comment to the guard. `\r\n` and `\r` are turned into `\n` first, and anything else is refused |

**Rows.** Every top-level `RETURN` (each side of a `UNION`) gets `LIMIT n+1`,
or an existing literal `LIMIT` larger than that is lowered to it; the extra row
only tells the person that more matched. A parameter `LIMIT` is refused, and so is a query that
doesn't end in `RETURN`, unless it is a bare schema-listing `CALL`. The rewrite
is added after the last token, so a trailing `//` comment can't swallow it, and
the response's `executedQuery` shows exactly what ran.

The guard was checked against both engines for the cases where a lexer and an
engine could read the same text differently: string escapes, doubled quotes,
backtick escapes and comment endings.

---

## How read-only is enforced

Three layers, so that no single mistake writes:

1. **The engine's read-only mode.** FalkorDB runs the query with
   `GRAPH.RO_QUERY`; Neo4j runs it in a `READ` session, in one unmanaged
   transaction that is always rolled back.
2. **Neo4j's own plan check.** Before running it, Neo4j `EXPLAIN`s the query in
   the same transaction; a plan whose type isn't read-only is refused
   (`native_query_write_refused`) and never runs.
3. **The guard**, in front of both.

**`LOAD CSV` is the exception that matters.** Both engines treat it as a read:
FalkorDB runs `LOAD CSV FROM 'https://…'` inside `GRAPH.RO_QUERY`, and Neo4j
plans it as `READ_ONLY`. So the guard is the only control that stops a person
making the database server fetch a URL or read a file. It refuses `LOAD`
wherever it stands as a clause; back it up on the database as below.

---

## Bounds

| Bound | Default | Set with |
| --- | --- | --- |
| Rows shown | 200; at most 1,000 | `NATIVE_QUERY_DEFAULT_ROWS`, `NATIVE_QUERY_MAX_ROWS` (up to 10,000) |
| Time | 10 s; at most 30 s | `NATIVE_QUERY_DEFAULT_TIMEOUT_MS`, `NATIVE_QUERY_MAX_TIMEOUT_MS` (up to 60 s, under the 120 s budget of `/graph/` routes) |
| Runs per person | 20 a minute | `NATIVE_QUERY_RATE` (`429`, with `Retry-After`) |
| Runs at once, per data source, per API process | 2 | `NATIVE_QUERY_CONCURRENCY` (`429` after a 2 s wait) |
| FalkorDB reply read off the socket | 16 MiB | `NATIVE_QUERY_MAX_REPLY_BYTES` — the connection is dropped past it, so the API process never holds more (`422`) |
| Query text | 20,000 characters | — |
| Response | 8 MiB of rows (`truncatedReason: "size"`) | — |
| One value | Text 2,000 characters; lists and maps 100 entries, 4 levels deep; paths 100 steps | — |

**FalkorDB** runs native queries on a read replica when there is one, else the
primary, over a small pool of their own (`NATIVE_QUERY_CONCURRENCY`
connections), so they never queue behind searches. The server is asked to stop
the query at its time limit, and the client gives up two seconds later. Nothing
is retried or re-run elsewhere; a replica that stops answering is set aside for
a while.

**Neo4j** pulls at most `limit + 1` rows, in batches, inside a transaction
with the time limit; cancelling stops the transaction.

**Cancelling.** When the person cancels or leaves, the API notices within half
a second and stops the call — FalkorDB's connection is closed (the server
still stops the query at its time limit), Neo4j's transaction is rolled back.

---

## What is recorded

Every run that reaches the guard writes one
`workspace.data_source.native_query_run` event to the activity log, in the
**Data** category and the workspace's audience, so the workspace's admins see it
on its **Activity** tab and auditors under **Administration → Activity**:

| Field | Holds |
| --- | --- |
| Actor, workspace, data source | Who ran it, where |
| `outcome` | `ok`, or the refusal's code (`native_query_refused`, `native_query_timeout`, `rate_limited`, …) |
| `via` | `permission` or `grant` (a share's **Query data**) |
| `viewId` | The View it was started from, when there was one |
| `query`, `queryHash` | The query's first 8,192 characters (`queryTruncated` past that) and a hash of the whole |
| `limit`, `timeoutMs`, `elapsedMs`, `rows`, `truncatedReason` | What it was allowed and what it did |

The record is committed **before** any row is returned. If it can't be written,
the rows are withheld and the person is told so (`503`, `audit_unavailable`):
no record, no rows.

Metrics: `native_query_runs_total{engine,outcome}`,
`native_query_seconds{engine}` and `native_query_rows_total{engine}`. One log
line per run carries the outcome, row count, time, query hash and request id,
and never the query text.

---

## Errors

Every refusal is `{"detail": {"code", "message", "requestId", "position"?}}` in
plain words (a body that doesn't match the model — a query over 20,000
characters, say — gets the usual `422` validation answer). None names a host, a port, a credential or a stack trace; a failure
on the server says only that it failed and quotes the request id, which finds
the log line.

| Status | Code | When |
| --- | --- | --- |
| `400` | `native_query_refused` | The guard refused it (with `position`) |
| `400` | `native_query_syntax` | The engine couldn't parse it (with `position` when the engine gives one) |
| `400` | `native_query_write_refused` | Neo4j's plan check found a write |
| `403` | `feature_disabled` · `missing_permission` | The switch is off · no way in |
| `404` | `not_found` | No such data source in the workspace |
| `422` | `native_query_too_large` | The reply passed the byte cap, or the engine's memory limit |
| `429` | `rate_limited` · `busy` | Too many runs by this person · too many at once on this source (`Retry-After`) |
| `499` | `cancelled` | The person went away |
| `501` | `native_query_unavailable` | A draft or branch, or a source that isn't FalkorDB or Neo4j |
| `503` | `unavailable` · `audit_unavailable` | The source isn't answering · the run couldn't be recorded |
| `504` | `native_query_timeout` | The query ran past its time |
| `500` | `native_query_failed` | Anything else (logged with the request id) |

---

## Threats and controls

| Threat | Control |
| --- | --- |
| A write, schema change or administration command | Engine read-only mode; Neo4j's plan check; the guard |
| Server-side request forgery or file reads through `LOAD CSV` | The guard (the engines run it as a read); operator egress limits below |
| Plugins with side effects or network access (`apoc.*`, `gds.*`) | The procedure and function allowlists |
| Hiding a clause from the guard (comments, strings, line breaks, backticks) | One tokenizer for the guard and the row cap; line breaks the engines read differently are refused; checked against both engines |
| Reading another database | `USE` refused; the data source's own graph only |
| Exhausting the database | Row limit written into the query; server-side time limit; per-person rate and per-source concurrency limits; FalkorDB on replicas and its own pool; operator memory limits below |
| Exhausting the API process | The reply byte cap on the socket; the response cap; capped values; nothing read whole |
| Reaching data through a View | A View never grants it by visibility; only a direct share with **Query data**, set by someone who may query the source |
| Scripts and leaked keys | API keys refused at the surface and in the access check |
| Unaccountable reads | An activity record per run, committed before any row; metrics; a log line |
| Leaking infrastructure in errors | Errors are rewritten to plain words with a request id |

---

## Operator hardening

The controls above hold on their own. These settings on the database back them
up and bound what one query can cost:

**FalkorDB**

- `TIMEOUT_MAX` — the longest any read may run, in milliseconds (`0`, the
  default, means unlimited). Set it to at least `NATIVE_QUERY_MAX_TIMEOUT_MS`.
  FalkorDB may keep working on a query after the client's deadline until this
  limit stops it.
- `QUERY_MEM_CAPACITY` — the most memory one query may use (`0` means
  unlimited). A query that passes it fails, and the person is told the answer
  was too large.
- **Read replicas.** Native queries go to a replica when there is one, so the
  primary — and the writes waiting on FalkorDB's per-graph lock — feel them
  least.
- **Egress.** FalkorDB fetches URLs for `LOAD CSV`. Don't let the FalkorDB host
  reach networks it doesn't need, and keep its `IMPORT_FOLDER` empty.

**Neo4j**

- `db.transaction.timeout` — the longest any transaction may run.
- `db.memory.transaction.max` — the most memory one transaction may use. Neo4j
  can't cap a single huge row on the client side, so this is the limit for it.
- `dbms.security.allow_csv_import_from_file_urls=false`, and limit the host's
  egress, for the same reason as FalkorDB.
- Read replicas or secondaries, where you run a cluster.

Native queries use the data source's existing login; the engines' read-only
modes, not that login's privileges, keep them read-only.

---

## Where in the code

| Concern | File |
| --- | --- |
| Route | `backend/app/api/v1/endpoints/graph.py` (`search_native`) |
| Who may run one | `backend/app/services/native_query/access.py` |
| Pipeline: rate, guard, row cap, bulkhead, cancel, cap, record | `backend/app/services/native_query/service.py` |
| Tokenizer, guard, row cap | `backend/app/services/native_query/lexer.py`, `guard.py`, `limit.py` |
| Values | `backend/app/services/native_query/cells.py` |
| Bounds | `backend/app/services/native_query/settings.py` |
| FalkorDB: replica, pool, byte cap | `backend/app/providers/falkordb_native.py` |
| Neo4j: READ transaction, plan check | `backend/graph/adapters/neo4j_provider.py` (`run_readonly_cypher`) |
| Share opt-in | `backend/app/api/v1/endpoints/view_grants.py`, `backend/app/services/view_access.py` |
| Console | `frontend/src/components/canvas/search/panel/native/` |
| Tests | `backend/tests/test_native_query_*.py`, `backend/tests/integration/test_native_query_live.py` |

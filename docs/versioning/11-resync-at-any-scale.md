# 11 · Re-sync at any scale

> **Status: designed, not built.** A size guard (`GRAPHVER_RESYNC_MAX_ENTITIES`, default
> 250,000) currently refuses what would not survive. This chapter is how that guard gets
> deleted. It exists so the next person does not have to re-derive any of it.

## The problem, measured

`POST /{ws}/graph/resync` → `resync_from_provider` → `sync_ingest`, run against a real
478,430-entity graph:

| | |
|---|---|
| peak RSS | **2,095 MiB** (2,030 MiB over a 65 MiB baseline) |
| elapsed | 90.4 s |
| **entities actually changed** | **808** |

**Two gigabytes of RAM, on the web tier, inside one HTTP request, to compute 808 changes.**
4.45 KiB per entity, and it is linear: the 7.7M model asks for **~30 GB** and takes the API
process — and every request in flight on it — down.

The cost is **six whole-graph structures held at once** (`service.py`, `sync_ingest`):

1. `collect_provider_rows(provider)` — the entire external snapshot as one Python list, via
   OFFSET paging (itself O(n²)-ish at depth on FalkorDB).
2. `base = _state_as_of(last import/sync seq)` — the whole graph.
3. `ours = _state_as_of(head)` — the whole graph.
4. `theirs = _external_state(rows, ours)` — the whole graph …
5. … plus the `urn_index` and `edge_index` it builds by iterating **all** of `ours`.
6. `merged` — the whole graph. Then `sorted(set(base) | set(ours) | set(theirs))`, and
   `kind_by_entity`.

**Both callers are affected, not just resync.** `sync_ingest` materialises `base` and `ours`
regardless of how many rows it is handed — so `POST /versioning/.../sync` pushing a *single
row* into a 7.7M graph asks for ~30 GB just as surely as a full re-sync does. That is why the
guard lives in `sync_ingest`, not only on the resync path.

## Why it is not simply "window it"

A re-sync is **authoritative**: an entity the snapshot no longer mentions is *deleted* (if the
user has not touched it). Deletions are therefore defined by **absence** — and absence cannot
be windowed. Iterating the provider's pages will never tell you what is *missing* from them.
Any design that forgets this silently stops deleting.

## The design

### 1. Discard by content hash, on the fly

The 808 figure is the key: **almost nothing changes in a re-sync**, yet everything is
materialised. And there is an exact rule for what may be thrown away:

> If `theirs == ours` for an entity, it can produce **no delta, regardless of `base`**.
> `three_way_merge(base, ours, theirs)` with `ours == theirs` returns `ours`: no conflict, no
> change. Whatever `base` was, both sides now agree.

So an entity identical to what we already hold can be dropped **the moment it is read**, and
never enter memory again. We already have everything needed to detect that cheaply:

- `entity_heads.content_hash` — written by the bootstrap's `heads` phase; the current hash of
  every entity, already indexed by `(graph_id, branch_id, entity_id)`.
- `node_versions.urn` + `ix_nv_urn` — resolves an external urn to its existing `entity_id`.

Per provider page: batch-resolve `urn → (entity_id, head content_hash)`, hash the external
payload the same way the writer does (`_sanitize_node_properties` → `content_hash`), and keep
**only** the rows whose hash differs. Everything else is freed immediately.

Edge identity needs endpoint `urn → entity_id`; batch-resolve it **per page** from
`node_versions`, exactly as `bootstrap_worker._known_nodes` does. Do **not** build a
whole-graph `urn_to_eid` map — that is allocation #5 above, and it is the subtle one.

### 2. Keep the id SET, because deletions demand it

Deletions cannot be windowed away, so keep `seen` — the set of external entity ids. Strings
only: ~40 MB at 478k, ~600 MB at 7.7M. Then

```
deletions = entity_heads (non-tombstoned) − seen
```

found by streaming `entity_heads` in keyset windows and membership-testing against `seen`.

At the largest sizes even 600 MB is more than we want in a request; stage the ids into
`import_rows` instead (it already exists, is keyed by `job_id`, has a `match_key` index, and is
GC'd on terminal — it was built for precisely this) and compute the difference in SQL. That
makes the whole operation O(1) in the id space. **Do this second, not first** — the hash-based
discard is where the two orders of magnitude are.

### 3. Merge only the touched set

```
touched = changed ∪ deletions
base    = _values_at(s, gid, main, touched, last_sync_seq)   # O(touched), the helper exists
ours    = _values_at(s, gid, main, touched, head_seq)        # O(touched)
```

then the 3-way merge over `touched` only.

### 4. Reuse the tail that already solves the cascades

`_cascade_containment`, `_cascade_incident_edges` and `_assert_referential_integrity` need
**global** visibility — an edge is dangling only relative to the whole graph — which is what
forces the full `merged` map today.

**`revert_commit` already solved this**, and its solution is the one to copy:
`_hydrate_merge_neighborhood` pulls in exactly the neighbours the cascades need around a
*bounded* changed-set. Do not reinvent it, and do not window the cascades — that is where a
subtle, silent, data-losing bug will come from.

Result: **O(seen + touched + page)** instead of O(graph).

### 5. Then get it off the web tier

Bounded memory is necessary and not sufficient: even at O(window), a 7.7M re-sync is ~20
minutes of work, and it currently runs **inline in the HTTP request**
(`endpoints/graph.py` awaits `resync_from_provider`). The end state is a **`resync` job on the
existing phased worker** — the machinery landed with the bootstrap and is a direct fit:

- `JobORM` as the durable queue, `job_type='resync'` (widen `ck_jobs_type` — **widen-only**,
  see `20260713_1400_jobs_bootstrap_type.py`; that table is multi-producer and a hard-coded
  allow-list has wedged alembic on it before).
- `BootstrapRunner`'s shape: phases with a cursor, `retry_count` as a claim epoch, a **timer**
  heartbeat (not a per-window one — see why in `bootstrap_worker._heartbeat`), transient-fault
  retry with backoff, and shrink-on-timeout.
- `202 + jobId`, progress, and a report — reuse `BootstrapProgress` on the front end.

At that point the size guard, its config knob, its typed 422 and
`backend/tests/test_sync_size_guard.py` all get **deleted**.

## Before touching any of this

`sync_ingest` has **one** test (`tests/integration/test_versioning_sync.py`). The surface being
rewritten is 3-way conflict detection, `external_wins`, resolutions, urn/edge-triple identity
matching, authoritative deletion, three cascades, and referential integrity — on the path that
writes commits to the source of truth.

**Write characterisation tests that pin the current semantics first**, so the rewrite can be
*proven* behaviour-preserving rather than hoped to be. That is the first commit of this work,
not an afterthought.

## Order of work

1. Characterisation tests for the current merge semantics.
2. Hash-discard + id-set + bounded `_values_at` merge (the two orders of magnitude).
3. Re-measure on the 478k graph; expect O(window), not 2 GB.
4. Move it onto the worker as a `resync` job (202 + progress + resumable).
5. Stage the id set into `import_rows` for the unbounded case.
6. Delete the guard, the knob, the 422 and the guard's tests.

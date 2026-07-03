# Versioning: Draft Lineage, the Draft↔Main Read Model, Merge Data-Loss & Repair

> **Audience:** Engineers/agents working on the graph **versioning** subsystem (drafts, branches,
> publish/merge, the FalkorDB projection, and the canvas read paths). Read
> [VERSIONING_E2E.md](VERSIONING_E2E.md) and [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) first for the
> baseline model; this doc is the engineering memory for a sequence of changes made to fix draft
> lineage rendering and a severe **merge-time data-loss** bug, plus the repair tooling for graphs
> already damaged by it.

This is a handoff/memory document: it records the **requirements**, the **architecture as it actually
behaves**, the **changes delivered** (with commit hashes + files), the **design decisions and their
trade-offs**, the **gaps still open**, and **how to verify/operate** everything.

---

## 1. The journey & requirements (what the user asked for)

1. **Draft lineage must render.** Opening a draft branch in the Context View Canvas showed *no
   lineage edges* — only a handful survived ("Edge Legend · 5 on screen" vs. the dense lineage on
   main). Drafts were useless for impact analysis.
2. **The invariant (stated explicitly by the user):** *A draft opened off `main` must read
   **identically** to `main` — every node and every edge, including the aggregated-lineage rollups —
   until a change is made. Then **only** the entities the draft added/removed/edited may differ.*
   The user asked for the **best scalable** way to guarantee this and was open to a redesign.
3. **A merge corrupted `main`.** After merging a draft, nodes on `main` rendered their raw **URN**
   instead of a name, and the entity-drawer Properties panel showed junk
   (`{ "id": "{}", "confidence": "<name> <name>", "childCount": N }`). The user (correctly) called
   this data corruption and demanded a full root-cause + fix.
4. **Repair the already-damaged data** by reverting the offending commit, via a reusable script.

---

## 2. Architecture primer (how draft vs main reads actually work)

Source of truth is **Postgres** (the *graphver* store: commits + per-entity version rows). **FalkorDB
is a rebuildable read cache** of `main`, written by the **projector**. The canvas reads through
`ContextEngine`, which selects a provider per request:

- **`main`, projection fresh** → live **FalkorDB** provider (`falkordb_provider.py`) — the hot path,
  and the only place the **materialized aggregated-lineage rollups** exist.
- **`main`, projection lagging** (e.g. just after a merge) → `VersionedBranchProvider` (Postgres
  composition) so a just-committed change is visible immediately (read-your-writes).
- **A live draft** → **`DraftOverlayProvider`** (NEW — see §3.1), wrapping *whatever serves `main`*
  and overlaying the draft's bounded delta.
- **As-of / historical reads** → `VersionedBranchProvider` with `as_of_seq` (read-only snapshot).

Routing lives in `backend/app/services/context_engine.py::ContextEngine._for_workspace`
(the `is_draft` / `main_fresh` block, ~line 123).

**Key files**
- `backend/app/services/versioning/service.py` — `GraphVersioningService`: drafts, `stage_changes`,
  `checkpoint`, `publish`/`merge_mr` → `_apply_draft_squash`, `revert_commit`, `commit_log`,
  `diff_*`, `materialize_state`, the Postgres composition helpers (`_state_as_of`, `_current_values`,
  `_values_at`, `_eid_for_urn`, `_containment_ancestors`).
- `backend/app/services/versioning/changeset.py` — `materialize()` (apply working-change ops →
  state) and `net_delta()` (per-entity squash delta).
- `backend/app/services/versioning/projection.py` — `FalkorProjector`: `_compute_changes`,
  `_node_item`/`_node_merge_cypher`, `_edge_item`/`_edge_merge_cypher`, the full-seed vs incremental
  paths, `ensure_projection_target` clean rebuild.
- `backend/app/providers/falkordb_provider.py` — live reads (`_node_from_props`,
  `_RESERVED_NODE_KEYS`, `_split_user_properties`, `_compute_searchable_text`) and writes.
- `backend/app/providers/versioned_branch_provider.py` — Postgres draft/as-of/main-lag reads.
- `backend/app/providers/draft_overlay_provider.py` — **NEW** read overlay (§3.1).

---

## 3. What was delivered (chronological, with commits)

### 3.1 Draft = main ⊕ sparse delta — `DraftOverlayProvider`  · commit `84a467f`
**Problem:** browse-mode cross-container lineage is surfaced **only** via the aggregated rollups
(overview arcs + drill-down). `VersionedBranchProvider.get_aggregated_edges_between` was a hard-empty
stub, so a draft had no rolled-up lineage at any zoom — hence "5 on screen."

**Chosen design (user picked "sparse overlay" over "recompute rollups in Postgres"):** a draft
**reuses main's reads and overlays only its bounded delta**.
- New `backend/app/providers/draft_overlay_provider.py::DraftOverlayProvider` wraps the **base**
  provider that serves `main` (live FalkorDB when fresh, else Postgres-main reader) and applies the
  draft's patch set. **Empty delta ⇒ pure pass-through ⇒ the draft IS main, by construction.** Cost is
  `O(main_read + delta)`; no per-draft FalkorDB graph; reuses main's materialized rollups + caches.
- Delta source: new `GraphVersioningService.branch_overlay_delta(graph_id, branch_id)` — reader-shaped
  upserts/removes (nodes + edges), bounded by draft size, empty for a no-change draft.
- Aggregated overlay: `get_aggregated_edges_between` takes the base's rollups and adjusts them by the
  draft's lineage-edge delta via `GraphVersioningService.aggregated_overlay_adjust` (ancestor-pair
  rollup of added/removed lineage edges, composed-containment aware). No lineage delta ⇒ main's
  rollups verbatim.
- Node/edge/children/top-level/trace reads delegate to base + `O(delta)` patch helpers; **writes**
  delegate to an internal `VersionedBranchProvider` (commit to the draft, unchanged).
- Routing: `context_engine.py` sends a live draft to `DraftOverlayProvider`; main + as-of paths
  unchanged.

**Proof:** `backend/tests/test_draft_overlay_provider.py` (no infra — empty-delta identity + add/remove
deltas over a stub base) and `backend/tests/integration/test_draft_overlay_delta.py` (live PG — the
two service helpers). `test_versioning_draft_read_routing.py` updated for the new routing.

### 3.2 Node Properties leak — reserve `entityId`/`searchableText`  · commit `28de8d5`
The projector/provider `SET` denormalized fields on nodes (`entityId`, `searchableText`, …) and
`_node_from_props` treats any attribute **not** in `_RESERVED_NODE_KEYS` as a user property. `entityId`
and `searchableText` were unreserved → they leaked into the Properties panel. Added both to
`_RESERVED_NODE_KEYS` (`falkordb_provider.py`). **This is a genuine read-hygiene fix but it was NOT the
cause of the user's reported corruption** (see §3.3 and the gap in §5.1). Regression:
`backend/tests/test_node_property_hygiene.py` (round-trip + a structural invariant that every
projector-written node attr is reserved).

### 3.3 ⭐ Merge data-loss — `update` ops must be field-level patches  · commit `4dd7df4`  (THE root cause)
**Reproduced** (`/tmp/repro_merge_corruption.py` during the session): a draft that does a *partial*
`update` (the canvas sends only the edited fields) → `publish`/merge made the node's Postgres payload
`displayName=None, properties=null` — the partial payload **replaced the whole entity**, erasing
`displayName`/`urn`/`properties`. The projected node then keyed as `gv:<urn>` with an empty name →
**the URN-as-name corruption.**

**Cause:** `changeset.py::materialize()` (used by `checkpoint`) and the parallel
`service.py::_apply_ops_once` applied an `update` as a **wholesale replace**
(`state[eid] = dict(payload)`), but a version row stores the *full* payload and composition is
**last-writer-wins per entity, not per field**. Truncation was invisible on the draft (the read
overlay still had the base row) and only surfaced when publish/merge projected the stripped payload
onto `main`.

**Fix:** an `update` is now a **field-level PATCH** — merge the op payload onto the entity's current
value, preserving fields it doesn't mention. `create` still replaces wholesale; `delete` still
tombstones; full-payload callers are unaffected (every field present in the merge). Applied in both
`materialize()` and `_apply_ops_once`. Regression: `backend/tests/test_changeset_materialize.py`
(patch preserves unmentioned fields, create replaces, delete tombstones, update-on-absent acts as
create, sequential ops compound).

> ⚠️ This **prevents recurrence**; it does not retroactively restore entities already truncated by a
> prior merge. Those need §3.4.

### 3.4 Repair tooling — revert the corrupting commit + re-project  · commit `540d390`
`backend/scripts/repair_revert_commit.py` — a thin CLI over the versioning system's own revert (no new
service logic):
- `--graph-id` / `--data-source-id` to target the graph.
- `--list [N]` (default, read-only) — newest-first `main` commits to spot the offending
  `squash_publish`/`import`.
- `--commit-id <id>` or `--revert-head` → `svc.revert_commit` rewrites every entity that commit
  touched back to its **pre-commit** state (a new auditable `revert` commit) and bumps the projection
  target. `MergeConflict` (a later commit touched those entities) prints the ids and advises peeling
  later commits first.
- `--dry-run` previews via `diff_commits` (what would be restored), writes nothing.
- Re-projects through the production `project_now` (FalkorDB), `--no-project` to skip. **No data
  loss** — pre-commit payloads live in history; FalkorDB is rebuildable.

Proof: `backend/tests/integration/test_repair_revert_commit.py` (truncate a node via a commit, revert,
assert `displayName`/`qualifiedName`/`properties` restored + a `revert` commit recorded). CLI smoke-
tested (`--list`, `--dry-run` writes nothing, `--revert-head`).

### 3.5 Prior-session context that set the stage  · commit `4382756`
"Reflect merged main state in FalkorDB" added `ensure_projection_target` (re-points a graph's
projection to the data source's *real* graph and resets the watermark → a **full clean-rebuild
re-seed**) and the drop+re-MERGE seed. This is *why the §3.3 truncation became visible across the
whole graph after a merge*: the re-seed rewrote every node from the (now-truncated) Postgres state.
The §3.3 fix addresses the truncation at the source; `4382756` itself is correct behavior.

---

## 4. Key design decisions & trade-offs

- **Sparse overlay over recompute (ADR-style):** a draft reuses main's materialized rollups + caches
  and pays only `O(delta)`; rejected "recompute aggregated rollups in Postgres per read"
  (`O(visible subtree)` per read + divergence risk vs. the FalkorDB materializer) and rejected a
  per-draft FalkorDB graph (RAM blow-up). The empty-delta fast path is what *guarantees* the
  no-change-draft===main invariant by construction rather than by re-derivation.
- **`update` = PATCH, not replace:** chosen as a defensive backend fix (rather than "make the frontend
  always send full payloads") because it is safe for all callers and removes a whole class of silent
  field-loss. Versions intentionally store the full payload (composition stays simple, per-entity LWW).
- **Read-time hygiene for denormalized fields:** reserving keys (§3.2) fixes leaks on *every* read
  immediately with no migration, because the leak is at read time, not in stored data.
- **Repair via `revert_commit`, not a manual data patch:** keeps an auditable `revert` commit, reuses
  conflict detection, and re-projects through the normal path. Reverting `--revert-head` is always
  conflict-free; peel back one commit at a time when unsure.

---

## 5. Gaps, risks & open items

### 5.1 ⚠️ UNRESOLVED: the `{id, confidence}` properties on nodes
The user's corrupted node also showed `properties = { "id": "{}", "confidence": "<displayName>
<qualifiedName>", "childCount": N }`. **This was NOT reproduced.** Investigation established:
- The values match `propertiesRaw` (`"{}"`) and `searchableText` (`"<name> <name>"`), but under the
  **edge-shaped keys** `id`/`confidence` — i.e. a *field re-keying* whose origin was not found.
- The §3.2 fix reserves `entityId`/`searchableText` (the keys *that* leak path produces), **not**
  `id`/`confidence`. The §3.3 fix explains the *displayName loss* but not these keys.
- It likely **predates** the reverted commit (so `revert` won't remove it) or is original seed noise.
**Action for the next agent:** after the user runs the repair, confirm whether `{id, confidence}`
persists on a node. If yes, reproduce-first (do not ship a speculative fix): check the
demo seed generators (`backend/scripts/seed_*.py` write `n.properties` as a **legacy JSON blob**;
`_node_from_props` ignores that blob — verify migration `migrate_native_properties.py` and any
FalkorDB→versioning import/sync path `service.py::bulk_ingest`/`sync_ingest` for an edge/node field
mix-up).

### 5.2 Existing corrupted data is not auto-healed
§3.3 stops new truncation; already-truncated nodes keep the stripped payload as their latest committed
version until the §3.4 repair (or a re-ingest) is run. The §3.3 code fix **must be deployed alongside
any repair**, or corruption recurs on the next edit.

### 5.3 `DraftOverlayProvider` best-effort areas (intentional, low-risk)
- **Trace overlay** (`trace_at_level`/`expand_aggregated`) patches delta lineage edges only within the
  base trace's node scope — fine for the common case; a trace anchored on a draft-new node may under-
  show until expanded.
- **Top-level added roots**: a draft-new node is treated as top-level only when no draft containment
  edge targets it (it can only see the draft's containment). Rare in practice.
- **Cache scope:** draft reads cache under the draft branch; if `main` changes while a draft is open,
  the draft's cached base can be briefly stale until TTL. Acceptable.

### 5.4 Scalability follow-up (not built)
Optionally precompute the draft's aggregated-edge delta at **checkpoint** time (bounded by changed
lineage) so reads overlay a ready-made delta instead of recomputing from raw delta edges — moves the
(already small) rollup-adjust from read- to write-time. Not needed for correctness.

### 5.5 Sandbox/test note
The dev Postgres in the agent sandbox idles out; restart with
`su postgres -c "$PGBIN/pg_ctl -D /tmp/pgtest -o '-p 5432 -k /tmp/pgsock -c listen_addresses=127.0.0.1' -l /tmp/pg.log start -w"`.
There is **no FalkorDB** in the sandbox — projection tests inject a fake graph client; live-FalkorDB
behavior is covered by `dev.sh infra` / CI.

---

## 6. Verification

All backend versioning checks (run with `GRAPHVER_E2E=1`, `PYTHONPATH=<repo>`, and
`GRAPHVER_DB_URL`/`MANAGEMENT_DB_URL` pointing at a live Postgres):

| Test | Infra | Covers |
|---|---|---|
| `backend/tests/test_changeset_materialize.py` | none | ⭐ update-as-patch (the §3.3 fix) |
| `backend/tests/test_node_property_hygiene.py` | none | §3.2 reserved-key leak + invariant |
| `backend/tests/test_draft_overlay_provider.py` | none | §3.1 overlay identity + delta application |
| `backend/tests/integration/test_draft_overlay_delta.py` | PG | §3.1 `branch_overlay_delta`/`aggregated_overlay_adjust` |
| `backend/tests/integration/test_repair_revert_commit.py` | PG | §3.4 revert restores a truncated node |
| `backend/tests/integration/test_versioning_draft_read_routing.py` | PG | draft→overlay / main routing |
| `backend/tests/integration/test_versioning_projection.py` | PG (fake Falkor) | projection seed/incremental/reseed |
| `backend/tests/integration/test_versioning_commit_diff.py` | PG | per-commit hierarchical diff |

**Manual e2e (live):** open a no-change draft → identical to main incl. dense lineage; edit a node →
only that node changes and its name/properties survive a publish; on a damaged graph, run the repair
(`--list` → `--dry-run` → revert) → names return.

---

## 7. Operating the repair tool (quick reference)
```bash
# 1) find the offending commit (read-only)
python backend/scripts/repair_revert_commit.py --data-source-id <ds> --list 20
# 2) preview (writes nothing)
python backend/scripts/repair_revert_commit.py --graph-id <gid> --commit-id <cid> --dry-run
# 3) revert + re-project
python backend/scripts/repair_revert_commit.py --graph-id <gid> --commit-id <cid> --actor you
#    (or --revert-head to peel the latest; --no-project to skip the FalkorDB rebuild)
```

## 8. Commit map (branch `claude/affectionate-fermi-ii373`)
- `84a467f` — DraftOverlayProvider (sparse overlay) + routing + service delta helpers.
- `28de8d5` — reserve `entityId`/`searchableText` (read hygiene; not the reported corruption).
- `4dd7df4` — ⭐ `update` ops are field-level patches (fixes merge data-loss / name loss).
- `540d390` — `repair_revert_commit.py` + integration test.
- `4382756` (prior) — merge→FalkorDB reflection + full re-seed (context for §3.5).

---

## 9. Diagnostic trail — what was ruled out (so you don't repeat it)

The merge corruption took three passes and two wrong turns; recording them:

- **The read-overlay (`DraftOverlayProvider`) is NOT a write path.** Verified it has zero references in
  any write/merge/publish/projection path — it cannot corrupt stored data. It had just been deployed
  when the corruption surfaced, which made it a tempting but incorrect suspect.
- **The `searchableText`/`entityId` leak (§3.2) was real but secondary.** Reproduced: a node round-
  tripped through the projector schema (`_node_item` → `n += nativeProps` / `n.searchableText` →
  `_node_from_props`) reads back with `searchableText` (`"<displayName> <qualifiedName>"`) and
  `entityId` leaking into `properties` because they weren't reserved. Genuinely fixed — **but the
  user's junk keys were `id`/`confidence`, not these**, so this did not resolve the report (→ §5.1).
- **The projection full re-seed (`4382756`) was the *trigger*, not the *cause*.**
  `ensure_projection_target` resets the watermark → a full rebuild rewrote every node from the
  (truncated) Postgres state, which is why corruption appeared graph-wide after a merge. The projector
  itself is correct.
- **The node/edge `_compute_changes` collision hypothesis** (an edge row overwriting a node in the
  incremental `last` map) was considered and rejected — it would *drop* a node, not give it edge-shaped
  keys, and node (`urn`) vs edge (`id`) entity_ids don't collide in practice.
- **The frontend is a pass-through, not the cause.** `toCanvasNode` (`frontend/src/hooks/useGraphHydration.ts`)
  copies `n.properties` verbatim; `nodeUpdatePayload` (`frontend/src/features/versioning/model/stagedChangesToOps.ts`)
  sends only the edited fields — a *partial* update. So the fix had to be backend patch semantics
  (§3.3), which makes any partial caller safe rather than relying on the client to send full payloads.
- **The cause was found only by reproducing the full pipeline** (`/tmp/repro_merge_corruption.py`:
  seed → partial-update draft → publish → project → read) and observing the Postgres payload collapse
  to `displayName=None, properties=null`. Lesson: reproduce end-to-end before fixing; static analysis
  alone sent me down the two wrong turns above.

## 10. Self-service blank models + commit-boundary ontology enforcement (2026-07-03)

A second wave of work (branch `claude/affectionate-fermi-ii373`, uncommitted at time of writing)
added the **blank-canvas authoring** capability: users provision an empty, ontology-governed
lineage model from the UI and build it by hand. Everything below is backend-verified by tests.

### 10.1 `kind="blank"` graphs & one-call provisioning

`POST /{ws}/versioning/blank-graphs` (`versioning.py::create_blank_graph`, gate
`workspace:datasource:manage`) provisions in one call:
1. a **manual data source** on a chosen FalkorDB provider — no catalog item; the chosen
   **published** ontology bound via `ontology_id`; `source_mode="managed"`; and a minted
   collision-proof `graph_name = "blank_<ds_id>"` (a full projection seed WIPES its named
   FalkorDB key, so physical names are never user-supplied);
2. a **genesis-only versioned graph** — `create_graph(kind="blank", ontology_enforcement=
   "strict")` pinned to that name + provider (`projection_state.falkor_graph_name` /
   `falkor_provider`);
3. best-effort **aggregation registration** (`AggregationService.trigger`, source
   `onboarding`) so the data source's readiness row exists from day one.

Cross-store consistency: management and graphver may be separate DBs (no 2PC) — the data
source commits first and is **compensated away** (hard delete) if graph creation fails (502).
Guards: unpublished ontology → 422 `ontology_not_published`; non-FalkorDB provider → 422
`provider_unsupported`. `graphs.kind` gained `'blank'` via migration
`20260703_1200_graph_kind_blank` (CHECK-constraint swap). `/resolve` now returns `kind` so
the UI can distinguish a genesis-only blank model (guided empty canvas) from a not-yet-seeded
graph (the "Enable version control" CTA) — the old `needsSeed = mainHeadCommitSeq <= 1`
heuristic alone would misfire on blank graphs.

### 10.2 Rich ontology rules at the commit boundary

Previously the durable write path checked only inline-spec **type-name membership** plus
structural edge integrity; the rich rules (`can_contain`, edge `source_types`/`target_types`)
lived only in `mutation_validator.py` on the interactive `ContextEngine` path — and the
`/graph/changes` batch save bypassed them for edges. Now:

- `versioning/ontology.py` gained `OntologyRules` (frozen: `entity_types{can_contain}`,
  `edge_types{source_types,target_types,is_containment}` keyed UPPERCASE,
  `containment_edge_types`) and `validate_entities_rich(entities, endpoint_types, rules)` —
  pure, mirrors `mutation_validator` semantics: empty sets = unrestricted, case-insensitive
  type match, **creates-only** (updates/deletes never gated — legacy data must not block
  edits), violations `{entity_id, kind, reason, rule}` with `rule ∈ unknown_entity_type |
  unknown_edge_type | invalid_source | invalid_target | containment_not_allowed` (a superset
  of the legacy shape — every `OntologyViolation` consumer keeps working).
- The rules are **resolved at the API layer and injected** (`ontology_rules=` kwarg — the
  same decoupling as `containment_edge_types`): `_live_ontology_rules`/`_rules_for_meta` in
  `versioning.py` (stage/commit/publish/merge endpoints), `_resolve_ontology_rules` in
  `graph.py::apply_graph_changes` (closing the batch-edge gap), and a
  `set_ontology_rules(...)` push-down on `VersionedWriteProvider` from
  `ContextEngine._resolve_ontology` (assigned-ontology only).
- Service gates: `apply_ops`/`_apply_ops_once` (endpoint types free from the already-hydrated
  `new_vals`/`cur_vals`; a `create` op on an already-live entity — the write-through's
  idempotent endpoint upsert — counts as an update, so legacy entities are never
  re-litigated); `stage_changes` (eager, batch+committed-head endpoint types; endpoints that
  exist only as uncommitted working changes are skipped — **checkpoint is the authoritative
  gate**); `checkpoint` (over `net_delta` against the composed head state);
  `_apply_draft_squash` (publish + `merge_mr`) — **rules resolved at merge time**, so an
  ontology tightened after a draft opened blocks the merge with per-entity reasons.
- Scoping rules: only data sources with an **explicitly assigned** `ontology_id` are gated
  (system-default/introspection fallback layers never retroactively gate legacy graphs);
  `kind="blank"` graphs **fail closed** (`ontology_required` 422 / `ontology_unavailable`
  503) — they are contractually ontology-governed. `bulk_ingest`/`sync_ingest` and
  `revert_commit` are deliberately **exempt** (re-sync must not break; revert is the
  administrative repair path and must be able to restore pre-ontology states).

Tests: `backend/tests/test_versioning_ontology_rules.py` (pure validator),
`backend/tests/integration/test_versioning_rich_enforcement.py` (apply_ops / stage+checkpoint
/ publish re-gate / permissive + None unchanged / legacy-endpoint upsert not re-litigated),
`backend/tests/integration/test_blank_graph_provisioning.py` (happy path, guards,
compensation, `/resolve.kind`).

### 10.3 Provider-aware projection routing & the aggregation chain

The projector previously wrote to ONE env-configured FalkorDB (`FALKORDB_HOST/PORT`) while
reads (`ProviderManager`) and the **aggregation worker** resolve per-provider connections —
on a pinned non-default provider, raw edges and `:AGGREGATED` rollups would land on
*different instances*. Now the graph-factory contract is `(name, provider_id=None) ->
graph | awaitable`:

- `backend/app/providers/falkor_graph_registry.py::make_registry_graph_factory` routes per
  `projection_state.falkor_provider` (ProviderORM host/port + decrypted creds, one handle per
  host/port, `apply_local_dev_falkordb_override` parity with the read path); anything
  unroutable (None/"default"/unknown/inactive/non-falkordb/lookup failure) falls back to the
  env instance with a loud log. Wired into the in-process worker (`main.py`), the standalone
  worker (`versioning/__main__.py`), and the interactive projector + hot read path
  (`versioning.py::get_falkor_read_factory`). Eviction drops route via the pinned provider
  too (`cache_manager.evict` → `drop_graph(name, provider_id)`).
- Publish→rollup chain for manual models (verified end-to-end wiring): publish →
  `project_now` → incremental `:AGGREGATED` maintenance (`edge_types_resolver`) per window;
  full seeds / stale windows → `on_rollups_stale` → `AggregationService.trigger`
  (idempotency `gv-rollup-rebuild:<graph_id>`) → per-provider `AggregationWorker` MERGE.
  **Deployment note:** the standalone projection worker has no `on_rollups_stale` wiring (no
  in-process aggregation service) — manual-model publishes go through the interactive
  `project_now`, which has it; wiring the standalone worker to the trigger API is a named
  follow-up.
- Known residuals: registry handles cache per process (credential rotation needs a restart);
  a deleted provider row falls back to the env instance (logged loudly).

Tests: `backend/tests/integration/test_versioning_projection_provider_routing.py` (pinned /
default / sync-factory / drop routing); all existing projection/eviction/worker suites green
with the widened factory contract (fake factories updated to `(name, provider_id=None)`).

## 11. Per-commit file manifest

- **`84a467f`** — new `backend/app/providers/draft_overlay_provider.py` (`DraftOverlayProvider` +
  `_OverlayDelta` index: node/edge upsert/remove maps, lineage-vs-containment split, childCount delta);
  `backend/app/services/context_engine.py` (live-draft routing → overlay); `service.py` (new
  `branch_overlay_delta` → `{nodesUpsert, nodesRemove, edgesUpsert, edgesRemove}`, and
  `aggregated_overlay_adjust` → `{(srcUrn,tgtUrn): {weight, types}}`); tests
  `test_draft_overlay_provider.py`, `integration/test_draft_overlay_delta.py`, and updated
  `integration/test_versioning_draft_read_routing.py`.
- **`28de8d5`** — `backend/app/providers/falkordb_provider.py` (`_RESERVED_NODE_KEYS` += `entityId`,
  `searchableText`); test `test_node_property_hygiene.py`.
- **`4dd7df4`** — `backend/app/services/versioning/changeset.py` (`materialize()` update→patch),
  `backend/app/services/versioning/service.py` (`_apply_ops_once` update→patch); test
  `test_changeset_materialize.py`.
- **`540d390`** — new `backend/scripts/repair_revert_commit.py`; test
  `integration/test_repair_revert_commit.py`.
- **`c1e67b5`** — `docs/VERSIONING_DRAFTS_LINEAGE_AND_MERGE.md` (this doc); `docs/TECHNICAL_DEBT.md`
  §2.3 pointer.

> The session also produced throwaway repro scripts under `/tmp` (`repro_corruption.py`,
> `repro_merge_corruption.py`) — not committed; their logic is preserved in the regression tests above.

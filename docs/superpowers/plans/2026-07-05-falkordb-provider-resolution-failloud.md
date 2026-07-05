# FalkorDB Provider Resolution + Fail-Loud (No Silent Fallback) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A FalkorDB graph provider resolves to ONE correct instance consistently across read, projection, and rebuild — for ANY provider, with NO silent default/env fallback. A provider that is unreachable/misconfigured **fails loud** (surfaced error + banner), never a silently-empty view; and rebuild is **non-destructive on failure** (never drop-then-fail-to-reseed). This fixes the data-integrity bug where a `localhost:6379`-registered provider (which resolves differently in web vs worker vs env-default) caused empty views and rebuild-wipes.

**Architecture:** Root cause — `localhost` resolves to three different instances across processes because the host-rewrite helpers read env vars independently per container; and connection failures are swallowed (read `except: return []`; projection `→ env default`; rebuild drops before validating). Fix: one shared `resolve_falkordb_target`, re-raise on connection failure (distinguish from genuinely-empty), raise on pinned-unresolvable provider (no env fallback), and validate connectivity before the destructive drop. Postgres is the untouched source of truth; a corrected rebuild fully restores FalkorDB.

**Tech Stack:** FastAPI + FalkorDB (redis client) + Postgres; pytest (`GRAPHVER_E2E=1`).

## Global Constraints

- **NO silent fallback for a PINNED provider.** The env-default handle is used ONLY for a genuinely unrouted/None provider — never as a fallback when a specific provider fails to resolve/connect.
- **Distinguish "graph genuinely empty" (0 nodes) from "provider unreachable."** Empty-graph → `[]`/empty UI; connection failure → raise → 503 → banner. `_is_missing_graph_error` already treats `ConnectionError("refused")` as NOT a missing graph (pinned by `test_falkordb_empty_graph.py:41`) — reuse it.
- **Rebuild never destroys on failure.** Validate target connectivity BEFORE the drop; a failed drop raises (never "proceed to MERGE"). Postgres is untouched; versioned reads fall back to Postgres while `projected < committed`.
- **One resolution path** used by all three sites (provider creation, projection registry resolve, registry key-list) so read-instance == projection-instance.
- Backend tests run `GRAPHVER_E2E=1` with live Postgres; projection tests inject a fake graph client (no live FalkorDB in sandbox). Don't break `test_versioning_projection_provider_routing.py` (None→default stays valid) or `test_falkordb_empty_graph.py`. `git status` before every commit; stage only the task's files; never bare `git stash`; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Read path fails loud on connection failure (the core "empty view → surfaced error")

**Files:** Modify `backend/app/providers/falkordb_provider.py` (`get_nodes` ~:1838-1842, `get_top_level_or_orphan_nodes` ~:2345-2349 + ~:2401-2403). **Test:** `backend/tests/test_falkordb_failloud.py` (new; may extend `test_falkordb_empty_graph.py`).

**Change:** replace the bare `except Exception: … return []` with a classifier: `if _is_missing_graph_error(e): return []` else `raise`. A connection refusal / transient drop after connect now re-raises → `CircuitBreakerProxy` opens → `ProviderUnavailable` → `graph.py` 503 → the frontend banner. A genuinely empty key / empty `result_set` still returns `[]`.

- [ ] Step 1: Failing tests — a fake FalkorDB client whose query raises `ConnectionError("Connection refused")` → `get_nodes`/`get_top_level` RAISE (not return `[]`); a client returning an empty result_set / missing-graph → returns `[]`. (Reuse `_is_missing_graph_error` semantics; see `test_falkordb_empty_graph.py:41` for the ConnectionError case.)
- [ ] Step 2: Run → FAIL (today they return `[]` on the ConnectionError).
- [ ] Step 3: Implement the classifier at all three catch sites.
- [ ] Step 4: Run → PASS; run `test_falkordb_empty_graph.py` — genuine-empty still returns `[]`.
- [ ] Step 5: Commit `fix(falkordb): read fails loud on connection failure (distinguish from empty graph)`.

### Task 2: One host-resolution path (read-instance == projection-instance)

**Files:** Create/consolidate `resolve_falkordb_target(host, port) -> (host, port)` composing `apply_local_dev_falkordb_override` + `_normalize_falkordb_host` (put it where both `manager.py` and `falkor_graph_registry.py` can import — e.g. `falkordb_provider.py` or a small `falkordb_hosts.py`). Modify the 3 call sites: `manager.py:_create_provider_instance` (~:740), `falkor_graph_registry.py:_resolve` (~:94-96), `falkor_graph_registry.py:list_graph_keys` (~:154-156). **Test:** `backend/tests/test_falkordb_host_resolution.py`.

**Change:** all three sites call the SAME `resolve_falkordb_target`, so a given `(host, port)` resolves identically in every process. Behavior-preserving refactor (same helpers, one path) — the durable guarantee against future drift.

- [ ] Step 1: Failing test — `resolve_falkordb_target('localhost', 6379)` and `resolve_falkordb_target('falkordb', 6379)` return the documented normalized target under representative env (rewrite set/unset); assert the three call sites all route through it (import + call assertion). Pin that `'falkordb'` is a passthrough (matches `test_falkordb_empty_graph.py:58,73`).
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement `resolve_falkordb_target`; route the 3 sites through it.
- [ ] Step 4: Run → PASS; existing manager/registry/projection-routing tests green.
- [ ] Step 5: Commit `refactor(falkordb): single resolve_falkordb_target across read/projection/registry`.

### Task 3: Projection raises for a pinned-unresolvable provider (no silent env fallback)

**Files:** Modify `backend/app/providers/falkor_graph_registry.py` (`_resolve` :77-82 missing/inactive/no-host, :98-102 exception). **Test:** extend `backend/tests/integration/test_versioning_projection_provider_routing.py`.

**Change:** when an EXPLICITLY PINNED `provider_id` is missing/inactive/non-falkordb/no-host or its lookup errors, **raise** a clear error (e.g. `ProviderConfigurationError`) instead of `conn=None` → env-default. The env default remains ONLY for the genuinely `_UNROUTED`/None case (:119). `list_graph_keys` (:158-160) likewise must not silently use env-default for a pinned failure.

- [ ] Step 1: Failing tests — a pinned provider that is inactive / non-falkordb / missing-host → `_resolve` RAISES (not env default); a `None`/unrouted provider → still returns the env-default handle (unchanged, `test_versioning_projection_provider_routing.py:84-89`).
- [ ] Step 2: Run → FAIL (today it routes to default).
- [ ] Step 3: Implement the raise for pinned-unresolvable; keep None→default.
- [ ] Step 4: Run → PASS; the existing routing test's None case stays green.
- [ ] Step 5: Commit `fix(projection): pinned-unresolvable provider raises instead of env-default fallback`.

### Task 4: Non-destructive rebuild (probe before drop; raise on drop failure)

**Files:** Modify `backend/app/services/versioning/projection.py` (`project_graph` full-seed: before the drop ~:277; the drop-failure handler ~:288-293). **Test:** `backend/tests/integration/test_versioning_projection.py` (extend) or a focused projection test with a fake client.

**Change:** (a) before `client.delete()` (:277), PING/probe the resolved client and RAISE if unreachable — so the outer handler (:314-357) records `last_error` + re-raises with **nothing dropped**. (b) On a non-`"empty key"` drop failure (:288-293), **raise** instead of logging + proceeding to `_apply`. A failed/misrouted drop must abort, never continue to a MERGE that can't repair a wipe.

- [ ] Step 1: Failing tests — a fake client that fails the probe → `project_graph` raises BEFORE `delete()` is called (assert delete NOT called, status reset, `last_error` set); a client whose `delete()` raises a non-empty-key error → raises (does NOT call `_apply`); a healthy client → full seed proceeds as today.
- [ ] Step 2: Run → FAIL (today it drops-then-proceeds).
- [ ] Step 3: Implement the pre-drop probe + raise-on-drop-failure.
- [ ] Step 4: Run → PASS; existing projection seed/incremental/reseed tests green.
- [ ] Step 5: Commit `fix(projection): probe before drop + abort on drop failure (non-destructive rebuild)`.

### Final: whole-fix review + recovery guidance

- Whole-fix review (`requesting-code-review`) with the invariants as lens: read/projection/rebuild resolve the SAME instance; no silent fallback for a pinned provider; connection failure surfaces (never silent-empty); rebuild never destroys on failure; genuinely-empty graphs still render empty.
- **Recovery runbook (in the review + a note to the user):** (1) fix the stored provider host so it's resolvable in every container (register providers as the compose service name / a real host, NOT `localhost`); (2) `request_projection_rebuild` → `rebuild_now`/`project_now` replays `(0, head]` from Postgres → clean re-seed → views restored; (3) versioned reads fall back to Postgres while `projected < committed`, so the window never serves empty.
- Update `docs/VERSIONING_DRAFTS_LINEAGE_AND_MERGE.md` §10.3 with the fail-loud + non-destructive-rebuild + single-resolution-path guarantees.

## Self-Review (author)
- Fail-loud read distinguishes empty vs unreachable (Task 1) — reuses `_is_missing_graph_error`. ✔
- One resolution path, all 3 sites (Task 2) — read==projection instance. ✔
- No silent fallback for pinned provider (Task 3); None→default preserved. ✔
- Rebuild non-destructive: probe-before-drop + raise-on-drop-failure (Task 4). ✔
- Recovery from Postgres documented; Postgres never touched. ✔
- Works for ANY provider (no localhost-specific hack in the code; the localhost fix is config the fail-loud change surfaces). ✔

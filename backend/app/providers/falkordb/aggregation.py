"""Aggregation run metadata and control-flow primitives, plus ``AggregationMixin``.

``AggRunMeta``, ``AggregationBatchAbort`` and ``_completed`` moved unchanged
from the pre-class section of the former ``falkordb_provider.py``
(``AggRunMeta`` lines 16-30, ``AggregationBatchAbort`` lines 57-63,
``_completed`` lines 66-69, as of the package move).

``AggregationMixin`` is carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split: the class
body's opening block, immediately after the class docstring — its
"Batch-level materialization" comment header through
``_rows_to_aggregated_result`` (lines 69-2049), a single contiguous block.

This mixin owns the ``:AGGREGATED`` roll-up accounting that the Connections
panel and the trace canvas read: warming and caching the urn->label map,
reacting to lineage-edge writes/deletes and containment changes, and
serving ``get_aggregated_edges_between`` (materialized, on-demand, and
mixed-depth synthesis alike). ``tests/test_falkordb_ondemand_pairs.py``
regex-matches the on-demand synthesis path's Cypher text directly, so it
is a second Cypher golden for this area — any rewording of a query it
covers, even a semantically identical one, fails it by design. See
``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2
for why this has to be a mixin rather than a delegate/helper object.
"""
import asyncio
import json
import os
import time
from collections import deque
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, Optional, Set, Tuple

from backend.app.models.graph import AggregatedEdgeInfo, AggregatedEdgeResult
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.knobs import _BULK_CREATE_BATCH_DEFAULT
from backend.app.providers.falkordb.rowmap import _sanitize_label


class AggRunMeta(NamedTuple):
    """Aggregation-run metadata resolved by ``_aggregation_run_meta``.

    ``regime``: 'cube' (every ancestor combination stored) or 'boundary'
    (canonical depth-diagonal only). ``stamp_version``: 2 = every stored
    :AGGREGATED edge carries sourceDepth/targetDepth; 1 = legacy stamps
    (depth unknown); 0 = env-forced, no stored contract. ``max_depth``:
    deepest containment depth stamped by the last run (None when
    unknown). ``last_materialized_at``: ISO timestamp of the last
    completed run (None = never / unknown)."""

    regime: str
    stamp_version: int
    max_depth: Optional[int]
    last_materialized_at: Optional[str]


class AggregationBatchAbort(Exception):
    """Raised when sustained provider failure makes continuing pointless.

    The worker's outer try/except marks the job ``status=failed`` and
    preserves ``last_cursor`` so the job can be resumed once the
    provider recovers.
    """


async def _completed(value):
    """A completed awaitable — lets asyncio.gather mix cached values with
    live queries without special-casing."""
    return value


class AggregationMixin:
    """Urn-label caching, lineage-write/containment hooks, and the
    :AGGREGATED roll-up synthesis and query paths."""

    # ------------------------------------------------------------------ #
    # Batch-level materialization (used by materialize_aggregated_edges_batch)
    # ------------------------------------------------------------------ #

    # Max ancestor pairs per Cypher UNWIND+MERGE call.  Each input edge
    # fans out to ~4 ancestor pairs (s_chain × t_chain), so 5000 input
    # edges produce ~20K pairs.  A single MERGE with 20K items + REDUCE
    # exceeds FalkorDB's 3s socket_timeout.  500 pairs keeps each call
    # well under 1s while still being 500× fewer round-trips than the
    # old per-edge approach. This is the *ceiling*; the per-graph
    # adaptive sizer (``_aggregation_sub_batch_size``) shrinks toward
    # ``_MERGE_SUB_BATCH_MIN`` when MERGE latency creeps past
    # ``_MERGE_SUB_BATCH_TARGET_HIGH_S`` (AIMD), and grows back toward
    # the ceiling after a run of healthy sub-batches.
    _MERGE_SUB_BATCH_SIZE = 500
    _MERGE_SUB_BATCH_MIN = 50
    _MERGE_SUB_BATCH_TARGET_HIGH_S = 2.0
    _MERGE_SUB_BATCH_TARGET_LOW_S = 0.8
    _MERGE_SUB_BATCH_GROW_AFTER = 5
    _MERGE_SUB_BATCH_GROW_STEP = 100

    # UNWIND batch size for bulk-CREATE. FalkorDB's documented best
    # practice is 10k–50k rows per UNWIND: large batches amortize the
    # parser/planner overhead, and CREATE is O(1) per row so larger
    # batches don't widen the per-row variance. The layered-lineage
    # importer uses 2000 because its writes are MERGE-on-node (which is
    # more variance-prone); our path is CREATE-on-relationship, which
    # tolerates and benefits from the higher number.
    _BULK_CREATE_BATCH_SIZE = _BULK_CREATE_BATCH_DEFAULT
    _BULK_WIPE_BATCH_SIZE = 50000    # cursored DELETE chunk for AGGREGATED wipe

    async def _wipe_aggregated_edges(
        self,
        *,
        should_cancel: Optional[Callable[[], bool]] = None,
    ) -> int:
        """Drop all :AGGREGATED edges on the projection graph in cursored chunks.

        Returns the total number of edges deleted. Each chunk is bounded so
        a single statement can't exceed the write timeout on a graph with
        millions of AGGREGATED edges; the loop converges when a chunk
        deletes zero rows.

        Short-circuits with a single cheap existence probe before issuing
        any DELETE — on a fresh graph (first bulk rebuild ever), this
        saves the millisecond-scale empty-DELETE round-trip; more
        importantly, on a graph where AGGREGATED happens to already be
        empty, the probe returns instantly and we don't pay any wipe
        time at all.
        """
        probe = await self._proj_query(
            "MATCH ()-[r:AGGREGATED]->() RETURN r LIMIT 1"
        )
        if not (probe.result_set or []):
            logger.info(
                "Bulk wipe AGGREGATED on %s: graph has no AGGREGATED edges, "
                "skipping wipe phase.", self._graph_name,
            )
            return 0

        total_deleted = 0
        while True:
            if should_cancel is not None and should_cancel():
                from backend.app.services.aggregation.cancel import JobCancelled
                from datetime import datetime, timezone
                raise JobCancelled(
                    job_id="<bulk-wipe-cancel>",
                    observed_at=datetime.now(timezone.utc).isoformat(),
                )
            res = await self._proj_query(
                "MATCH ()-[r:AGGREGATED]->() "
                f"WITH r LIMIT {self._BULK_WIPE_BATCH_SIZE} "
                "DELETE r RETURN count(r) AS n"
            )
            n = 0
            if res.result_set:
                first = res.result_set[0]
                n = (first[0] if first else 0) or 0
            total_deleted += int(n)
            if n == 0:
                break
            logger.info(
                "Bulk wipe AGGREGATED on %s: chunk deleted %d (running total %d)",
                self._graph_name, n, total_deleted,
            )
        return total_deleted

    async def _purge_aggregated_idempotency_namespace(self) -> None:
        """Drop all Redis SADD members tracking AGGREGATED edge contributors.

        Required before a bulk rebuild — stale members from a prior attempt
        would inflate weights or carry stale contributor edge_ids forward
        into the rebuilt graph.
        """
        pattern = f"{self._agg_members_prefix()}:*"
        cursor: int = 0
        deleted = 0
        try:
            while True:
                reply = await self._redis.execute_command(
                    "SCAN", cursor, "MATCH", pattern, "COUNT", 1000,
                )
                # python-redis returns (cursor, [keys]); both may be bytes.
                next_cursor, keys = reply[0], reply[1]
                if isinstance(next_cursor, (bytes, bytearray)):
                    next_cursor = int(next_cursor)
                else:
                    next_cursor = int(next_cursor)
                if keys:
                    pipe = self._redis.pipeline(transaction=False)
                    for k in keys:
                        pipe.delete(k)
                    await pipe.execute()
                    deleted += len(keys)
                cursor = next_cursor
                if cursor == 0:
                    break
        except Exception as exc:
            logger.warning(
                "Idempotency namespace purge failed on %s (continuing — stale "
                "members may inflate the first incremental edge's weight): %s",
                self._graph_name, exc,
            )
            return
        if deleted:
            logger.info(
                "Purged %d Redis agg_members keys on %s before bulk rebuild.",
                deleted, self._graph_name,
            )

    async def _label_buckets(
        self, urns: List[str],
    ) -> List[Tuple[str, List[str]]]:
        """Group URNs by their sanitized node label so every anchor can
        be label-qualified into a per-label URN-index SEEK. This build
        has no label-less URN index, so an unlabeled ``WHERE n.urn IN
        $list`` anchor is a FULL node/relation scan with per-row IN-list
        membership — observed live at 4-9s per query on a 2M-node graph
        (and timing out the stored aggregated read entirely). The ``""``
        bucket collects URNs whose label could not be resolved; callers
        keep the unlabeled pattern for that (bounded) residue."""
        uniq = list(dict.fromkeys(u for u in urns if u))
        if not uniq:
            return []
        try:
            labels = await self._resolve_urn_labels_bulk(uniq)
        except Exception as exc:
            logger.debug("label bucketing failed (%s) — unlabeled fallback", exc)
            return [("", uniq)]
        buckets: Dict[str, List[str]] = {}
        for u in uniq:
            buckets.setdefault(labels.get(u) or "", []).append(u)
        return sorted(buckets.items())

    async def _resolve_urn_labels_bulk(
        self, urns: List[str],
    ) -> Dict[str, Optional[str]]:
        """Resolve URN → sanitized-label for many URNs at once.

        First consults the Redis URN→label cache populated as a side
        effect of node upserts / get_node calls. For misses, falls back
        to a single bulk Cypher querying labels for the missing URNs
        (one round-trip regardless of miss count). Caches results back
        to Redis for subsequent calls.

        Returns dict with every input URN as a key; the value is
        ``None`` when the URN's label could not be resolved (caller
        routes through the unlabeled fallback CREATE path for these).
        """
        out: Dict[str, Optional[str]] = {}
        if not urns:
            return out

        label_key = self._urn_label_key()
        missing: List[str] = []

        try:
            pipe = self._redis.pipeline(transaction=False)
            for u in urns:
                pipe.hget(label_key, u)
            raws = await pipe.execute()
            for u, raw in zip(urns, raws):
                if raw is None:
                    missing.append(u)
                else:
                    lbl = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
                    out[u] = _sanitize_label(lbl)
        except Exception:
            missing = list(urns)

        if missing:
            try:
                # Cache-miss bootstrap via PER-LABEL index seeks. The
                # previous single unlabeled ``WHERE n.urn IN $urns`` scan
                # was itself the bottleneck it tried to avoid: on builds
                # without a label-less URN index it is a FULL node scan —
                # observed timing out on a 2M-node graph, which then
                # dumped every reader into the unlabeled slow path
                # (cold-cache chicken-and-egg: resolving labels needed a
                # label). Enumerating the graph's few observed labels and
                # seeking each label's URN index turns the bootstrap into
                # K index-driven queries; the startup warmup caps out at
                # 200k nodes per label, so big graphs ALWAYS hit this
                # path for most of their nodes.
                rows: list = []
                try:
                    lbl_res = await self._ro_query(
                        self.dialect.labels_statement(),
                        timeout=5.0,
                    )
                    observed = [
                        str(r[0]) for r in (lbl_res.result_set or [])
                        if r and r[0] and not str(r[0]).startswith("_")
                    ]
                except Exception:
                    observed = []
                if observed:
                    unresolved = list(missing)
                    for lbl in observed:
                        if not unresolved:
                            break
                        safe = _sanitize_label(lbl)
                        res = await self._ro_query(
                            f"MATCH (n:{safe}) WHERE n.urn IN $urns "
                            "RETURN n.urn AS u",
                            params={"urns": unresolved},
                        )
                        hit = {
                            r[0] for r in (res.result_set or []) if r and r[0]
                        }
                        rows.extend([u, lbl] for u in hit)
                        if hit:
                            unresolved = [u for u in unresolved if u not in hit]
                    res = type("R", (), {"result_set": rows})()
                else:
                    # Label enumeration unavailable — legacy single scan.
                    res = await self._ro_query(
                        "MATCH (n) WHERE n.urn IN $urns "
                        "RETURN n.urn AS u, labels(n)[0] AS label",
                        params={"urns": missing},
                    )
                # The cache is an OPTIMIZATION, never a hard dependency. Resolve
                # the result FIRST, then write the cache only if a client exists.
                # This pipeline used to be opened BEFORE the loop, so a None
                # client (unset CACHE_REDIS_URL, or the dedicated cache Redis
                # simply DOWN — build_cache_client returns None by construction)
                # raised before ``out`` was ever populated. That threw away labels
                # which had resolved perfectly well and pushed the caller into the
                # unlabeled-MATCH fallback — i.e. a FULL NODE SCAN, the
                # 4-9s-on-2M-nodes antipattern this very cache exists to avoid.
                # A cache outage must not knock every label lookup off its index.
                resolved_labels: List[Tuple[str, str]] = []
                for row in res.result_set or []:
                    urn, label = row[0], row[1]
                    if label:
                        safe = _sanitize_label(label)
                        out[urn] = safe
                        resolved_labels.append((urn, safe))
                    else:
                        out[urn] = None
                if resolved_labels and self._redis is not None:
                    try:
                        store_pipe = self._redis.pipeline(transaction=False)
                        for urn, safe in resolved_labels:
                            store_pipe.hset(label_key, urn, safe)
                        await store_pipe.execute()
                    except Exception:
                        pass
            except Exception as exc:
                logger.warning(
                    "Bulk URN label resolution failed for %d URNs (will fall "
                    "back to unlabeled MATCH for these): %s",
                    len(missing), exc,
                )

        for u in urns:
            out.setdefault(u, None)
        return out

    async def _ensure_label_urn_indexes(self, labels: Set[str]) -> None:
        """Create per-label URN indexes for every label that will be
        matched during bulk-CREATE. Idempotent — best-effort on failure.

        Mirrors the pattern in the layered-lineage importer — indexes go in
        BEFORE any writes so every MATCH/CREATE row is an index seek.
        """
        if not labels:
            return
        _init_timeout = float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))
        for label in labels:
            try:
                await asyncio.wait_for(
                    self._proj.query(
                        self.dialect.create_node_index(label, "urn"),
                    ),
                    timeout=_init_timeout,
                )
            except Exception:
                pass  # already exists or unsupported

    async def _warmup_urn_label_cache_for_aggregation(self) -> None:
        """Pre-populate the Redis URN→label cache via one labeled scan
        per label in the graph.

        This is the Phase 1.8 fix for the write-side timeout fire on
        `sol_xlarge_test2`. Without warmup, `_resolve_urn_labels_bulk`
        falls back to a single unlabeled bulk Cypher
        (``MATCH (n) WHERE n.urn IN $urns ...``) on every cache miss.
        On a multi-million-node graph without an unlabeled URN index,
        that single Cypher can exceed the 5s read timeout and return
        no rows — leaving every URN in the missing list mapped to
        ``None``, which previously routed pairs to the (now-removed)
        unlabeled-fallback CREATE that scanned per row and busted the
        write timeout.

        With warmup, the cache is hot for every legitimately-labeled
        node BEFORE Phase C runs. Per-label scans use the per-label
        URN index (already created in ``_initialize_indices`` /
        ``_ensure_label_urn_indexes``), so each scan is index-assisted
        and fast. URNs still unresolved after warmup are genuinely
        label-less (legacy MERGE residue) or missing nodes; Phase 1.8
        drops those pairs with a count + sample warning rather than
        scanning forever.
        """
        try:
            res = await asyncio.wait_for(
                self._proj.ro_query(self.dialect.labels_statement(), {}),
                timeout=2.0,
            )
        except Exception as exc:
            logger.info(
                "URN→label warmup on %s: CALL db.labels() unavailable (%s); "
                "skipping warmup. _resolve_urn_labels_bulk will run its "
                "fallback Cypher on cache miss.",
                self._graph_name, exc,
            )
            return

        labels: List[str] = []
        for row in (res.result_set or []):
            if row and row[0]:
                lbl = row[0].decode("utf-8") if isinstance(row[0], (bytes, bytearray)) else str(row[0])
                if lbl.startswith("_"):
                    continue  # system-internal labels carry no URNs
                labels.append(lbl)
        if not labels:
            return

        label_key = self._urn_label_key()
        t_start = time.monotonic()
        total_cached = 0

        # Per-label hard cap to bound memory + cache size on huge labels.
        # ``layered_lineage_perf_xlarge`` style graphs sit well below this, and
        # any label with >200k nodes likely doesn't benefit from a full
        # cache pre-warm anyway (the per-label index seek at lookup time
        # is already fast).
        per_label_cap = int(os.getenv("FALKORDB_URN_LABEL_WARMUP_PER_LABEL_CAP", "200000"))
        per_label_timeout = float(os.getenv("FALKORDB_URN_LABEL_WARMUP_TIMEOUT_S", "30"))

        # CONTAINER-FIRST (BFS-priority) warm: the canvas opens at the
        # roots and expands container-by-container, so the nodes every
        # early request resolves are the CONTAINERS — and there are only
        # thousands of them even on a 2M-node graph. The stored
        # :AGGREGATED endpoints ARE that working set by construction
        # (every rollup endpoint is a container the canvas can show), and
        # the relation-anchored scan carries the labels along — no
        # dependence on denormalized properties (childCount proved
        # unpopulated on real import paths). The per-label fill passes
        # below top up to the cap; HSET idempotency dedupes the overlap.
        try:
            prio_pipe = self._redis.pipeline(transaction=False)
            prio_count = 0
            for prio_cypher in (
                f"MATCH (s)-[r:AGGREGATED]->() "
                f"RETURN DISTINCT s.urn, labels(s)[0] LIMIT {per_label_cap}",
                f"MATCH ()-[r:AGGREGATED]->(t) "
                f"RETURN DISTINCT t.urn, labels(t)[0] LIMIT {per_label_cap}",
            ):
                pr = await asyncio.wait_for(
                    self._proj.ro_query(prio_cypher, {}),
                    timeout=per_label_timeout,
                )
                for row in (pr.result_set or []):
                    if row and row[0] and row[1]:
                        urn = row[0]
                        if isinstance(urn, (bytes, bytearray)):
                            urn = urn.decode("utf-8")
                        prio_pipe.hset(
                            label_key, urn, _sanitize_label(str(row[1])),
                        )
                        prio_count += 1
            if prio_count:
                await prio_pipe.execute()
                total_cached += prio_count
                logger.info(
                    "URN→label warmup on %s: container-priority pass cached "
                    "%d rollup-endpoint entries.",
                    self._graph_name, prio_count,
                )
        except Exception as exc:
            logger.debug(
                "URN→label warmup on %s: container-priority pass failed "
                "(%s) — per-label fill only.", self._graph_name, exc,
            )

        for label in labels:
            safe = _sanitize_label(label)
            rows: list = []
            remaining = per_label_cap - len(rows)
            if remaining > 0:
                try:
                    lr = await asyncio.wait_for(
                        self._proj.ro_query(
                            f"MATCH (n:{safe}) RETURN n.urn LIMIT {remaining}",
                            {},
                        ),
                        timeout=per_label_timeout,
                    )
                    rows.extend(lr.result_set or [])
                except Exception as exc:
                    logger.warning(
                        "URN→label warmup on %s: scan for label %r failed (%s); "
                        "skipping. Pairs with %s-labeled endpoints may still hit "
                        "the resolver fallback Cypher.",
                        self._graph_name, label, exc, label,
                    )
            if not rows:
                continue

            pipe = self._redis.pipeline(transaction=False)
            count = 0
            for row in rows:
                urn = row[0]
                if not urn:
                    continue
                if isinstance(urn, (bytes, bytearray)):
                    urn = urn.decode("utf-8")
                pipe.hset(label_key, urn, safe)
                count += 1
            try:
                await pipe.execute()
                total_cached += count
            except Exception as exc:
                logger.warning(
                    "URN→label warmup on %s: pipeline failed for label %r "
                    "(%d entries lost): %s",
                    self._graph_name, label, count, exc,
                )

        # TTL on the whole per-graph hash: the cache Redis runs
        # volatile-lru, which can ONLY evict keys that carry a TTL — a
        # TTL-less hash is unevictable and a fleet of warmed 2M-node
        # graphs would wedge the instance at maxmemory. Refreshed on
        # every warmup; idle graphs age out and the self-healing
        # bootstrap rebuilds them on first touch.
        try:
            ttl_s = int(os.getenv("FALKORDB_URN_LABEL_CACHE_TTL_S", "604800"))
            if ttl_s > 0:
                await self._redis.expire(label_key, ttl_s)
        except Exception:
            pass

        elapsed_ms = (time.monotonic() - t_start) * 1000
        logger.info(
            "URN→label warmup on %s: cached %d urn→label entries across "
            "%d labels in %.1fms",
            self._graph_name, total_cached, len(labels), elapsed_ms,
        )

    async def _estimate_lineage_edge_count(
        self, lineage_types: List[str],
    ) -> int:
        """Best-effort lineage-edge total WITHOUT a full-graph scan.

        Reads the graph stats the stats service already maintains
        (``{graph}:stats_cache``, written by ``get_stats``) and sums the
        counts for the resolved lineage types. Returns 0 when no cache is
        available — the caller treats 0 as "unknown" and drives progress
        off the processed-edge count instead of a percentage.
        """
        if not lineage_types or self._redis is None:
            return 0
        try:
            cached = await self._redis.get(f"{self._cache_ns}:stats_cache")
            if not cached:
                return 0
            data = json.loads(cached)
            counts = data.get("edgeTypeCounts") or {}
            wanted = {str(t).upper() for t in lineage_types}
            total = 0
            for t, c in counts.items():
                if str(t).upper() in wanted:
                    try:
                        total += int(c)
                    except (ValueError, TypeError):
                        continue
            return total
        except Exception:
            return 0

    async def _derive_lineage_types_from_cache(
        self, containment: List[str],
    ) -> List[str]:
        """Derive lineage edge types from cached graph stats (no scan).

        Only used when the caller supplied no explicit lineage whitelist —
        in practice the ontology always freezes lineage types onto the job,
        so this is a defensive fallback.
        """
        if self._redis is None:
            return []
        exclude = {str(c).upper() for c in (containment or [])} | {"AGGREGATED"}
        try:
            cached = await self._redis.get(f"{self._cache_ns}:stats_cache")
            if not cached:
                return []
            data = json.loads(cached)
            counts = data.get("edgeTypeCounts") or {}
            return [t for t in counts if str(t).upper() not in exclude]
        except Exception:
            return []


    async def _resolve_chain_levels(
        self,
        s_chain: List[str],
        t_chain: List[str],
        entity_levels: Dict[str, int],
        *,
        caller: str,
    ) -> Optional[Tuple[Dict[str, int], Dict[str, str]]]:
        """(urn → level, urn → label) for both ancestor chains via the
        urn→label cache — the level/label resolution SHARED by the write
        and delete hooks so their pair selection can never diverge.

        Returns ``None`` when the hook must DEFER to the batch pipeline: a
        partially-resolved chain silently yields non-canonical rep pairs
        (a missing middle label makes the "deepest rep" skip a level),
        polluting the boundary. No level map ⇒ empty maps (legacy mode)."""
        urn_levels: Dict[str, int] = {}
        urn_labels: Dict[str, str] = {}
        if not entity_levels:
            return urn_levels, urn_labels
        chain_urns = list(dict.fromkeys(s_chain + t_chain))
        # The urn→label cache records the graph's OBSERVED spellings;
        # the level map is keyed by DECLARED ontology ids. Re-key by
        # every observed spelling, or alias-variant sources resolve
        # zero levels and the hooks defer on every single write.
        levels_by_spelling: Dict[str, int] = {}
        for _lbl, _lv in entity_levels.items():
            for _sp in self._alias_entity_types([_lbl]):
                levels_by_spelling[str(_sp)] = _lv
            levels_by_spelling[_lbl] = _lv
        try:
            label_key = self._urn_label_key()
            label_pipe = self._redis.pipeline(transaction=False)
            for u in chain_urns:
                label_pipe.hget(label_key, u)
            rows = await label_pipe.execute()
            unresolved = 0
            for u, raw in zip(chain_urns, rows):
                if not raw:
                    unresolved += 1
                    continue
                lbl = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
                urn_labels[u] = lbl
                lvl = levels_by_spelling.get(lbl)
                if lvl is not None:
                    urn_levels[u] = lvl
            if unresolved:
                logger.debug(
                    "%s: %d chain member(s) not in the urn→label cache — "
                    "deferring to the batch pipeline.", caller, unresolved,
                )
                return None
        except Exception as exc:
            logger.warning("%s: level lookup failed: %s", caller, exc)
            return None
        return urn_levels, urn_labels

    async def _get_ancestor_dag_pair(
        self, source_urn: str, target_urn: str,
    ) -> Optional[Tuple[Dict[str, int], Dict[str, int], bool, bool]]:
        """Both endpoints' ancestor CLOSURES ({ancestor_or_self: depth})
        plus whether each endpoint is itself a container — the DAG input
        the shared pair rules run on. Multi-parent nodes keep every
        ancestry (the flat-chain walk collapsed them to one). Two bounded
        label-free queries: the endpoint profile (children count + depth,
        the WS3 shape) and the distinct-ancestor depth query. Returns
        None when containment types are unconfigured."""
        try:
            containment = list(self._get_containment_edge_types())
        except Exception:
            return None
        if not containment:
            return None
        c_pattern = "|".join(
            _sanitize_label(t) for t in self._alias_rel_types(containment)
        )
        hops = self._containment_hop_bound()
        urns = [source_urn, target_urn]
        prof = await self._ro_query(
            f"MATCH (n) WHERE n.urn IN $urns "
            f"OPTIONAL MATCH (n)-[:{c_pattern}]->(ch) "
            f"WITH n, count(ch) AS kids "
            f"OPTIONAL MATCH p = (a)-[:{c_pattern}*1..{hops}]->(n) "
            f"RETURN n.urn, kids, coalesce(max(length(p)), 0)",
            params={"urns": urns},
        )
        profile: Dict[str, Tuple[bool, int]] = {}
        for row in (prof.result_set or []):
            if row and row[0]:
                profile[str(row[0])] = (int(row[1] or 0) > 0, int(row[2] or 0))
        anc = await self._ro_query(
            f"MATCH (a)-[:{c_pattern}*1..{hops}]->(child) "
            f"WHERE child.urn IN $urns "
            f"WITH DISTINCT child.urn AS cu, a "
            f"OPTIONAL MATCH q = (r0)-[:{c_pattern}*1..{hops}]->(a) "
            f"RETURN cu, a.urn, coalesce(max(length(q)), 0)",
            params={"urns": urns},
        )
        closures: Dict[str, Dict[str, int]] = {u: {} for u in urns}
        for row in (anc.result_set or []):
            if row and row[0] and row[1]:
                closures[str(row[0])][str(row[1])] = int(row[2] or 0)
        s_prof = profile.get(source_urn, (False, 0))
        t_prof = profile.get(target_urn, (False, 0))
        s_cl = dict(closures.get(source_urn) or {})
        t_cl = dict(closures.get(target_urn) or {})
        s_cl[source_urn] = s_prof[1]
        t_cl[target_urn] = t_prof[1]
        return s_cl, t_cl, s_prof[0], t_prof[0]

    def _hook_pairs(
        self,
        regime: str,
        source_urn: str,
        target_urn: str,
        s_cl: Dict[str, int],
        t_cl: Dict[str, int],
        s_is_container: bool,
        t_is_container: bool,
    ) -> List[Tuple[str, str]]:
        """Pair selection for the incremental hooks — the shared
        ``pair_rules`` the batch pipeline stores, dispatched on the
        stored regime so the hook writes exactly what the batch would:
        boundary → canonical depth-bridged container pairs; cube → the
        full ancestor cross-product (raw mirror excluded, matching the
        batch default). Sorted for a deterministic Redis pipeline."""
        from backend.common.providers.pair_rules import boundary_pairs, cube_pairs

        if regime == "cube":
            pairs = set(cube_pairs(
                s_cl, t_cl, include_leaf_mirror=False,
                s=source_urn, t=target_urn,
            ))
        else:
            s_reps = {
                a: d for a, d in s_cl.items()
                if a != source_urn or s_is_container
            }
            t_reps = {
                a: d for a, d in t_cl.items()
                if a != target_urn or t_is_container
            }
            pairs = boundary_pairs(s_reps, t_reps)
        return sorted(pairs)

    async def on_lineage_edge_written(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
        edge_type: str,
    ) -> int:
        """Materialize AGGREGATED edges when a lineage edge is written.

        Used for real-time per-edge materialization on individual writes.
        For bulk aggregation, use ``materialize_aggregated_edges_batch`` instead.

        Uses pre-computed ancestor chains instead of Cypher variable-length
        paths, eliminating the Cartesian product explosion.

        Idempotency: Uses Redis Sets to track which leaf edges contribute
        to each AGGREGATED pair. SADD is naturally idempotent.

        Batching: Collects all new pairs, then issues a single UNWIND+MERGE
        instead of one Cypher call per ancestor pair.

        Returns the number of AGGREGATED pairs whose graph edge was
        newly created or had its weight/sourceEdgeTypes updated as a
        result of this call. Returns 0 if every pair was already
        recorded in the Redis idempotency set (nothing to do). Callers
        sum this across the batch to report *actual graph edges
        affected* rather than *input edges processed*.
        """
        await self._ensure_connected()

        # DAG closures (every ancestry of a multi-parent node — the flat
        # chain collapsed them to one and silently dropped the rest) +
        # the stored regime, so the hook writes exactly the pair set the
        # batch pipeline owns.
        dag = await self._get_ancestor_dag_pair(source_urn, target_urn)
        if dag is None:
            logger.debug(
                "on_lineage_edge_written: containment unresolved for "
                "%s -> %s — deferring to the batch pipeline",
                source_urn, target_urn,
            )
            return 0
        s_cl, t_cl, s_cont, t_cont = dag
        meta = await self._aggregation_run_meta()

        members_key_prefix = self._agg_members_prefix()

        # Resolve ontology levels for every closure member up front (one
        # urn→label cache pipeline) — labels anchor the MERGE on per-label
        # URN indexes; levels survive as display stamps.
        entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}
        resolved = await self._resolve_chain_levels(
            list(s_cl), list(t_cl), entity_levels, caller="on_lineage_edge_written",
        )
        if resolved is None:
            return 0
        urn_levels, urn_labels = resolved

        if entity_levels and not urn_levels:
            # Level map exists but no chain member resolved (cold
            # urn→label cache). Level STAMPS would pollute the boundary;
            # skipping only delays visibility until the next batch run
            # reconciles.
            logger.debug(
                "on_lineage_edge_written: no chain levels resolved "
                "for %s -> %s — deferring to the batch pipeline",
                source_urn, target_urn,
            )
            return 0
        # Shared pair rule, regime-dispatched — mirrors the batch
        # pipeline on any graph shape (levels are stamps, never the
        # selector; depth stamps come from the closures).
        pairs_to_check = self._hook_pairs(
            meta.regime, source_urn, target_urn, s_cl, t_cl, s_cont, t_cont,
        )

        if not pairs_to_check:
            return 0
        depth_of = {**t_cl, **s_cl}

        # Pipeline: SADD for all pairs.
        # Do NOT silently fallback on Redis failure — the previous
        # ``except: sadd_results = [1] * len(...)`` treated every pair
        # as "newly added" and set weight=1, producing incorrect
        # AGGREGATED edges. Let the exception propagate so the caller
        # can count it as an error and, on sustained failure, abort the
        # job via AggregationBatchAbort.
        pipe = self._redis.pipeline(transaction=False)
        for s_urn, t_urn in pairs_to_check:
            member_key = f"{members_key_prefix}:{s_urn}:{t_urn}"
            pipe.execute_command("SADD", member_key, edge_id)
        sadd_results = await pipe.execute()

        # Phase 2: keep only pairs this raw edge hasn't contributed to
        # yet (SADD=1). Weight accounting is INCREMENT-BY-ONE on the
        # graph edge itself — never an overwrite from the Redis set's
        # SCARD, which is a separate accounting system from the batch
        # pipeline's raw-scan weights and would clobber a
        # pipeline-computed weight (observed class: 12,000 → 1).
        new_pairs = [(pairs_to_check[i], sadd_results[i]) for i in range(len(pairs_to_check)) if sadd_results[i] != 0]
        if not new_pairs:
            return 0

        # Phase 3: single UNWIND+MERGE for all new pairs, stamped with
        # the levels resolved up front. Coalesce in the Cypher SET
        # preserves backfilled level values when a fresh resolution
        # misses (same rationale as the batched materializer).
        # UNKNOWN_LEVEL sentinel for endpoints whose label has no declared
        # level. Stamping -1 (instead of leaving sourceLevel NULL) keeps
        # the backfill convergent: the digest WHERE filter sees the edge
        # as "stamped" and skips it on re-runs.
        from backend.app.services.ontology_levels import UNKNOWN_LEVEL

        merge_batch = []
        for (s_urn, t_urn), _ in new_pairs:
            merge_batch.append({
                "s": s_urn, "t": t_urn,
                # Shared edge identity with the batch pipeline: without
                # aggKey the two writers create PARALLEL edges for the
                # same pair, and reconcile (which deletes by aggKey) can
                # never remove the hook's copy.
                "k": f"{s_urn}|{t_urn}",
                "sl": urn_levels.get(s_urn, UNKNOWN_LEVEL),
                "tl": urn_levels.get(t_urn, UNKNOWN_LEVEL),
                # Structural depth stamps — the readers' filter dimension.
                "sd": depth_of.get(s_urn),
                "td": depth_of.get(t_urn),
            })

        # Stamp the current levelDigest so the cold-start probe doesn't
        # flag freshly-created edges as needing backfill. When the
        # ontology drifts later, these edges go stale alongside the
        # pre-existing ones and the next backfill run re-stamps them.
        digest = self._level_digest or ""

        # Do NOT catch exceptions here — the previous ``except: return 0``
        # silently swallowed MERGE failures (including the "Batched
        # AGGREGATED_MERGE failed: timeout" error). The caller in
        # materialize_aggregated_edges_batch has a per-edge try/except
        # that logs and increments the error counter; on sustained
        # failure, AggregationBatchAbort aborts the job and preserves
        # last_cursor for resume.

        _SET_CLAUSE = (
            "MERGE (s)-[r:AGGREGATED {aggKey: item.k}]->(t) "
            "SET r.weight = coalesce(r.weight, 0) + 1, "
            "r.sourceLevel = item.sl, "
            "r.targetLevel = item.tl, "
            "r.sourceDepth = item.sd, "
            "r.targetDepth = item.td, "
            "r.levelDigest = $digest, "
            "r.sourceEdgeTypes = CASE "
            "  WHEN r.sourceEdgeTypes IS NULL THEN [$edgeType] "
            "  WHEN NOT $edgeType IN r.sourceEdgeTypes "
            "    THEN r.sourceEdgeTypes + $edgeType "
            "  ELSE r.sourceEdgeTypes END, "
            "r.latestUpdate = timestamp()"
        )
        # Anchor node MERGEs on the per-label URN indexes (an unlabeled
        # ``MERGE (s {urn: ...})`` is a full node scan per item on
        # servers without unlabeled-index support). Canonical pairs are
        # containers whose labels resolved above; items with unknown
        # labels (legacy level-less graphs) keep the unlabeled pattern.
        by_label_pair: Dict[Tuple[str, str], list] = {}
        unlabeled_items: list = []
        for item in merge_batch:
            s_lbl = urn_labels.get(item["s"])
            t_lbl = urn_labels.get(item["t"])
            if s_lbl and t_lbl:
                by_label_pair.setdefault(
                    (_sanitize_label(s_lbl), _sanitize_label(t_lbl)), [],
                ).append(item)
            else:
                unlabeled_items.append(item)
        for (s_lbl, t_lbl), items in by_label_pair.items():
            await self._proj_query(
                "UNWIND $batch AS item "
                f"MERGE (s:{s_lbl} {{urn: item.s}}) "
                f"MERGE (t:{t_lbl} {{urn: item.t}}) "
                + _SET_CLAUSE,
                params={"batch": items, "edgeType": edge_type, "digest": digest},
            )
        if unlabeled_items:
            await self._proj_query(
                "UNWIND $batch AS item "
                "MERGE (s {urn: item.s}) "
                "MERGE (t {urn: item.t}) "
                + _SET_CLAUSE,
                params={"batch": unlabeled_items, "edgeType": edge_type, "digest": digest},
            )
        return len(merge_batch)

    async def on_lineage_edge_deleted(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
    ) -> None:
        """Decrement AGGREGATED edge weights when a lineage edge is removed.

        Mirror of ``on_lineage_edge_written`` (shared chain/level
        resolution + canonical pair selection), inverted:

        * SREM is the GATE — only a pair this edge verifiably contributed
          to via the hook (its id sat in the pair's ``agg_members`` set)
          is touched. The batch pipeline never populates those sets, so
          its cells are left alone for its own reconcile — the old SCARD
          path OVERWROTE pipeline-computed weights with set cardinality
          and DELETED any pair whose set was empty, i.e. every
          batch-written cell (the "12,000 → 1" data-loss class).
        * The graph write is a decrement-by-one via the
          ``AGGREGATED(aggKey)`` edge-index seek — no node lookups at
          all, so nothing to label-anchor; a cell reaching weight 0 is
          deleted in the same query.
        """
        await self._ensure_connected()

        dag = await self._get_ancestor_dag_pair(source_urn, target_urn)
        if dag is None:
            return  # defer to the batch pipeline, like the write hook
        s_cl, t_cl, s_cont, t_cont = dag
        meta = await self._aggregation_run_meta()

        members_key_prefix = self._agg_members_prefix()

        entity_levels: Dict[str, int] = getattr(self, "_entity_type_levels", None) or {}
        resolved = await self._resolve_chain_levels(
            list(s_cl), list(t_cl), entity_levels, caller="on_lineage_edge_deleted",
        )
        if resolved is None:
            return  # defer to the batch pipeline, like the write hook
        urn_levels, _urn_labels = resolved

        if entity_levels and not urn_levels:
            logger.debug(
                "on_lineage_edge_deleted: no chain levels resolved "
                "for %s -> %s — deferring to the batch pipeline",
                source_urn, target_urn,
            )
            return
        # Shared pair rule, regime-dispatched (write-hook parity) — the
        # SREM gate below still limits writes to hook-tracked pairs.
        pairs = self._hook_pairs(
            meta.regime, source_urn, target_urn, s_cl, t_cl, s_cont, t_cont,
        )
        if not pairs:
            return

        # SREM gate: 1 ⇒ this edge's contribution was tracked for the
        # pair — its stored weight (hook-incremented OR pipeline-computed
        # while the edge existed) includes it, so decrementing is exact.
        # 0 ⇒ untracked (pipeline-only cell, or a Redis flush): leave it
        # for the next batch reconcile rather than guess.
        try:
            pipe = self._redis.pipeline(transaction=False)
            for s_urn, t_urn in pairs:
                pipe.execute_command(
                    "SREM", f"{members_key_prefix}:{s_urn}:{t_urn}", edge_id,
                )
            srem_results = await pipe.execute()
        except Exception as exc:
            logger.warning(
                "on_lineage_edge_deleted: members-set SREM failed (%s) — "
                "leaving weights for the next batch reconcile", exc,
            )
            return

        keys = [
            f"{s_urn}|{t_urn}"
            for (s_urn, t_urn), removed in zip(pairs, srem_results)
            if removed
        ]
        if not keys:
            return

        try:
            await self._proj_query(
                "UNWIND $keys AS k "
                "MATCH ()-[r:AGGREGATED {aggKey: k}]->() "
                "SET r.weight = r.weight - 1, r.latestUpdate = timestamp() "
                "WITH r WHERE r.weight <= 0 DELETE r",
                params={"keys": keys},
            )
        except Exception as e:
            logger.error(f"Batched AGGREGATED decrement failed: {e}")

    async def on_containment_changed(self, urn: str) -> None:
        """Invalidate ancestor cache for a node and its descendants, then rebuild.

        When a node's parent changes, its entire subtree's ancestor chains
        are invalidated and lazily recomputed on next access. Targets the
        current containment-types namespace; older namespaces are
        unreachable so they don't need to be touched.
        """
        await self._ensure_connected()
        cache_key = self._ancestors_cache_key()

        # Invalidate this node's cached chain
        try:
            await self._redis.hdel(cache_key, urn)
        except Exception:
            pass

        # Invalidate descendants (BFS through containment)
        containment = list(self._get_containment_edge_types())
        queue = deque([urn])
        visited: Set[str] = {urn}

        while queue:
            current = queue.popleft()
            result = await self._ro_query(
                "MATCH (p)-[r]->(c) WHERE p.urn = $urn AND type(r) IN $ctypes RETURN c.urn",
                params={"urn": current, "ctypes": containment},
            )
            child_urns = [row[0] for row in (result.result_set or []) if row[0] and row[0] not in visited]
            if child_urns:
                try:
                    pipe = self._redis.pipeline(transaction=False)
                    for cu in child_urns:
                        pipe.execute_command("HDEL", cache_key, cu)
                        visited.add(cu)
                        queue.append(cu)
                    await pipe.execute()
                except Exception:
                    pass

        logger.info(f"Invalidated ancestor cache for {len(visited)} nodes under {urn}")

    async def clear_content_caches(self) -> None:
        """Bulk counterpart to :meth:`on_containment_changed`: clears every
        containment-digest ancestors namespace and the urn→label cache,
        and drops the in-process aggregation run-meta memo.

        Call only from the confirmed-source-change signal (e.g. after an
        external bulk load/re-parent) — per-node edits still go through
        ``on_containment_changed``. Without this, both the read path and
        the aggregation rebuild worker keep resolving ancestor chains
        from the old graph shape for up to the 7-day content-cache TTL.

        Best-effort and never-raising: a no-op if no cache Redis is
        configured; any failure is logged and swallowed.
        """
        try:
            await self._ensure_connected()
            if self._redis is not None:
                pattern = f"{self._cache_ns}:ancestors:*"
                cursor = 0
                while True:
                    cursor, keys = await self._redis.scan(cursor, match=pattern, count=500)
                    if keys:
                        await self._redis.delete(*keys)
                    if cursor == 0:
                        break
                await self._redis.delete(self._urn_label_key())
        except Exception as e:
            logger.warning(f"clear_content_caches failed: {e}")
        finally:
            self._agg_meta_cached = None

    async def count_aggregated_edges(self) -> int:
        """Cheap COUNT for purge progress reporting. Returns the current
        number of materialized AGGREGATED edges in the projection graph.
        """
        await self._ensure_connected()
        result = await self._proj_query(
            "MATCH ()-[r:AGGREGATED]->() RETURN count(r) AS total"
        )
        return int(result.result_set[0][0]) if result.result_set else 0

    async def purge_aggregated_edges(
        self,
        *,
        batch_size: int = 10_000,
        progress_callback: Optional[Callable[[int], Awaitable[None]]] = None,
        should_cancel: Optional[Callable[[], bool]] = None,
    ) -> int:
        """Remove ALL materialized AGGREGATED edges from the graph.

        Also deletes the Redis ``{graph_name}:agg_members:*`` tracking
        sets. These sets are the idempotency state used by
        :meth:`on_lineage_edge_written` (SADD returns 0 when an edge_id
        is already a member, short-circuiting the MERGE). If they are
        NOT purged together with the graph edges, the next materialize
        run silently no-ops — the source edges appear "already
        contributed" even though the AGGREGATED edges they produced are
        gone from the graph, and the caller sees
        ``aggregated_edges_affected`` numbers that match the input
        count but 0 edges actually written to the graph.

        The deletion runs in batches of ``batch_size`` so multi-million-
        edge purges (a) report progress to the caller via
        ``progress_callback`` and (b) cannot silently truncate at the
        single hard-coded LIMIT 100000 the previous one-shot DELETE used.
        Each iteration's actual deleted count is summed into the
        running total handed to the callback.

        The Redis key prefix was renamed from ``agg:sourceEdgeIds:`` to
        ``agg_members:`` in an earlier refactor of
        :meth:`on_lineage_edge_written`; this method's scan pattern was
        not updated and so cleaned nothing until this fix.
        """
        await self._ensure_connected()

        # Clamp to a safe, non-zero range. 0 / negative would loop
        # forever; very large values defeat the progress-reporting
        # purpose this method exists for.
        if batch_size <= 0:
            batch_size = 10_000
        batch_size = min(batch_size, 100_000)

        try:
            total_deleted = 0
            while True:
                # Cooperative cancel between DELETE batches. The previous
                # batch's DELETE already landed in FalkorDB, so raising
                # here cannot orphan a Cypher transaction. Without this
                # hook a multi-million-edge purge cannot be cancelled
                # without ``task.cancel()`` interrupting a mid-flight
                # DELETE — same pattern as the materialise path.
                if should_cancel is not None and should_cancel():
                    from backend.app.services.aggregation.cancel import JobCancelled
                    from datetime import datetime, timezone
                    raise JobCancelled(
                        job_id="<provider-cancel>",
                        observed_at=datetime.now(timezone.utc).isoformat(),
                    )

                result = await self._proj_query(
                    f"MATCH ()-[r:AGGREGATED]->() "
                    f"WITH r LIMIT {int(batch_size)} "
                    f"DELETE r "
                    f"RETURN count(r) AS deleted"
                )
                deleted_in_batch = (
                    int(result.result_set[0][0]) if result.result_set else 0
                )
                total_deleted += deleted_in_batch

                if progress_callback is not None:
                    try:
                        await progress_callback(total_deleted)
                    except Exception as cb_exc:
                        # Progress reporting must never abort the actual
                        # deletion — log and keep going.
                        logger.warning(
                            "purge_aggregated_edges progress_callback raised: %s",
                            cb_exc,
                        )

                # Anything less than a full batch means we've drained
                # the AGGREGATED relations.
                if deleted_in_batch < batch_size:
                    break

            # Clean up Redis tracking keys for this graph. Must match the
            # prefix used by on_lineage_edge_written exactly (see
            # docstring). Done after all graph DELETEs succeed so a
            # mid-purge crash can't leave the tracker keys cleared while
            # AGGREGATED edges still exist (which would silently no-op
            # the next materialize run).
            pattern = f"{self._agg_members_prefix()}:*"
            cursor = 0
            cleaned = 0
            while True:
                cursor, keys = await self._redis.scan(cursor, match=pattern, count=500)
                if keys:
                    await self._redis.delete(*keys)
                    cleaned += len(keys)
                if cursor == 0:
                    break

            # Bump the aggregation-state EPOCH — the in-graph _AggMeta
            # FIRST: it is the readers' authoritative source (outranks
            # the Redis marker), so a Redis-only bump is shadowed and the
            # purge stays invisible to meta-driven readers. The regime is
            # KEPT as 'cube': an empty store trivially satisfies the cube
            # contract, which keeps on-demand derivation OFF — re-probing
            # an empty store resolves 'boundary' and the structural
            # reader would then RE-DERIVE the purged cells from raw
            # lineage on the next canvas read (purge-then-resurrect).
            # ``edgeCount = 0`` + ``purgedAt`` make the state inspectable.
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            try:
                await self._proj_query(
                    "MATCH (m:_AggMeta {id: 'singleton'}) "
                    "SET m.edgeCount = 0, m.regime = 'cube', "
                    "m.lastMaterializedAt = $now, m.purgedAt = $now",
                    params={"now": now_iso},
                )
                # Readers cache the resolved meta ~5 min — drop this
                # instance's copy so it answers honestly immediately.
                self._agg_meta_cached = None
            except Exception as exc:
                logger.warning(
                    "purge_aggregated_edges: could not update the in-graph "
                    "_AggMeta epoch: %s", exc,
                )
            # Redis mirror second. ``lastMaterializedAt`` rides on every
            # aggregated-edge response and is the client caches'
            # invalidation signal — without this bump a purge was
            # invisible to every consumer. Best-effort — marker failures
            # must never fail a purge whose deletes already landed.
            try:
                if self._redis is not None:
                    await self._redis.set(
                        self._agg_last_materialized_key(), now_iso,
                    )
                    if hasattr(self, "_agg_regime_key"):
                        await self._redis.set(self._agg_regime_key(), "fine")
            except Exception as exc:
                logger.warning(
                    "purge_aggregated_edges: could not bump the "
                    "aggregation-state epoch marker: %s", exc,
                )

            logger.info(
                "Purged %d AGGREGATED edges and %d Redis tracking keys from %s",
                total_deleted, cleaned, self._graph_name,
            )
            return total_deleted
        except Exception as e:
            logger.error("Failed to purge AGGREGATED edges: %s", e)
            raise

    async def materialize_lineage_for_edge(
        self,
        source_urn: str,
        target_urn: str,
        lineage_edge_type: str,
    ) -> bool:
        """Legacy wrapper — delegates to on_lineage_edge_written."""
        try:
            edge_id = f"{source_urn}|{lineage_edge_type}|{target_urn}"
            await self.on_lineage_edge_written(source_urn, target_urn, edge_id, lineage_edge_type)
            return True
        except Exception as e:
            logger.error(f"Failed to materialize lineage: {e}")
            return False

    async def materialize_aggregated_edges_batch(
        self,
        batch_size: int = 1000,
        containment_edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        last_cursor: Optional[str] = None,
        progress_callback: Optional[Any] = None,
        intra_batch_callback: Optional[Callable[[int], Awaitable[None]]] = None,
        should_cancel: Optional[Callable[[], bool]] = None,
        resume_processed: int = 0,
        resume_created: int = 0,
        tuning: Optional[Dict[str, Any]] = None,
        job_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Materialize :AGGREGATED rollup edges (single resumable pipeline).

        Delegates to ``backend.app.providers.falkordb_materialize`` — see
        that module for the EXTRACT -> COMPUTE -> RECONCILE -> APPLY design,
        the ``v3:`` cursor contract, and the tuning env vars. The legacy
        wipe-first bulk rebuild, epoch-swept streaming rebuild, and
        cursor-paged MERGE loop (with their AGGREGATION_BULK_REBUILD_ENABLED
        / AGGREGATION_STREAMING_REBUILD_ENABLED flags) were removed — this
        is the only strategy. Rollback is a version rollback.
        """
        await self._ensure_connected()
        from backend.app.providers.falkordb_materialize import (
            materialize_aggregated_edges,
        )
        return await materialize_aggregated_edges(
            self,
            batch_size=batch_size,
            containment_edge_types=containment_edge_types,
            lineage_edge_types=lineage_edge_types,
            last_cursor=last_cursor,
            progress_callback=progress_callback,
            intra_batch_callback=intra_batch_callback,
            should_cancel=should_cancel,
            resume_processed=resume_processed,
            resume_created=resume_created,
            tuning=tuning,
            job_id=job_id,
        )

    async def get_aggregated_edges_between(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        granularity: Any,
        containment_edges: List[str],
        lineage_edges: List[str],
        *,
        timeout: Optional[float] = None,
    ) -> AggregatedEdgeResult:
        """Read pre-materialized AGGREGATED edges from the projection graph.

        Pure index lookup — O(|sourceUrns|), sub-millisecond at any scale.
        No live fallback: if materialization hasn't run, returns empty result
        so the caller knows to trigger a backfill.
        """
        from fastapi import HTTPException
        from backend.app.config.resilience import (
            AGGREGATED_EDGE_PAGE_SIZE,
            AGGREGATED_EDGE_RESULT_CAP,
            AGGREGATED_SOURCE_URN_BATCH_SIZE,
        )

        if len(source_urns) > 100_000:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "TOO_MANY_SOURCE_URNS",
                    "limit": 100000,
                    "received": len(source_urns),
                },
            )

        await self._ensure_connected()

        # The Cypher LIMIT is a PAGE size, not the answer size. It is still
        # needed — without it every batch materializes + weight-sorts its
        # FULL match set on the server in one go — but ``_run_batch`` below
        # pages until the match set is exhausted, so bounding per-query
        # server work no longer bounds the data returned. Previously this
        # LIMIT was the answer: anything past 100k rows was dropped, and
        # since an oversized payload is never cached (delete-on-oversize)
        # a >cap model rendered a DIFFERENT arbitrary subset on every open.
        #
        # Anchors are LABEL-QUALIFIED per source-label bucket: without a
        # label the planner has no URN index on this build and falls back
        # to scanning EVERY :AGGREGATED relation with per-row IN-list
        # membership — observed timing out (and returning an empty
        # canvas) at 595k stored cells × 600 visible urns. With the label
        # it is |batch| index seeks + local out-edge expansion.
        def _cypher_for(label: str, *, resume: bool) -> str:
            anchor = f"(s:{label})" if label else "(s)"
            where = ["s.urn IN $sourceUrns"]
            if target_urns:
                where.append("t.urn IN $targetUrns")
            where.append("s.urn <> t.urn")
            if resume:
                # Strictly after the previous page's last row in the total
                # order below. Written out longhand because Cypher has no
                # row-value comparison operator.
                where.append(
                    "(coalesce(r.weight, 0) < $lastWeight "
                    "OR (coalesce(r.weight, 0) = $lastWeight "
                    "AND (s.urn > $lastSourceUrn "
                    "OR (s.urn = $lastSourceUrn AND t.urn > $lastTargetUrn))))"
                )
            return (
                f"MATCH {anchor}-[r:AGGREGATED]->(t) "
                f"WHERE {' AND '.join(where)} "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                # coalesce, not a bare r.weight: a null weight compares as
                # null against every integer, so `weight < $lastWeight` would
                # be null for those rows and every page after the first would
                # skip them permanently. 0 is what the row->model conversion
                # already maps a missing weight to, so payloads are unchanged.
                "coalesce(r.weight, 0) AS weight, r.sourceEdgeTypes AS types "
                # Total order, and the keyset the resume predicate walks.
                # weight is a COUNT, so ties are pervasive and a page
                # boundary lands mid-tie-group; (s.urn, t.urn) is what makes
                # that boundary exact and repeatable across pages.
                "ORDER BY weight DESC, sUrn, tUrn "
                f"LIMIT {AGGREGATED_EDGE_PAGE_SIZE}"
            )

        batch_failed = False

        async def _run_batch(label: str, batch: List[str]) -> list:
            """Read every matching cell for this batch, paging as needed.

            Stops only when the server returns a short page (match set
            exhausted), the read fails, or the runaway guard trips — never
            at a fixed row count that would silently drop the remainder.
            """
            nonlocal batch_failed
            rows: list = []
            last: Optional[list] = None
            while True:
                params: Dict[str, Any] = {"sourceUrns": batch}
                if target_urns:
                    params["targetUrns"] = target_urns
                if last is not None:
                    params["lastWeight"] = int(last[2]) if last[2] else 0
                    params["lastSourceUrn"] = last[0]
                    params["lastTargetUrn"] = last[1]
                try:
                    result = await self._proj_ro_query(
                        _cypher_for(label, resume=last is not None),
                        params=params, timeout=timeout, op="agg.cells",
                    )
                    page = result.result_set or []
                except Exception as e:
                    # Keep the pages already read — they are a correct prefix
                    # of the answer — and let batch_failed drive
                    # degraded/stale so the partial is flagged, not cached
                    # full-TTL as if it were complete.
                    logger.warning(f"AGGREGATED edge read failed: {e}")
                    batch_failed = True
                    return rows
                rows.extend(page)
                if len(page) < AGGREGATED_EDGE_PAGE_SIZE:
                    return rows
                if len(rows) >= AGGREGATED_EDGE_RESULT_CAP:
                    # Not marked degraded: the data is fine, the request is
                    # pathological. Length alone drives truncated=true.
                    logger.warning(
                        "AGGREGATED edge read on %s hit the runaway guard at "
                        "%d rows (AGGREGATED_EDGE_RESULT_CAP) — returning a "
                        "truncated result. Narrow the request or raise the "
                        "guard if the instance has headroom.",
                        self._graph_name, len(rows),
                    )
                    return rows
                last = page[-1]

        batch_size = AGGREGATED_SOURCE_URN_BATCH_SIZE
        runs: List[Tuple[str, List[str]]] = []
        for label, bucket in await self._label_buckets(source_urns):
            for i in range(0, len(bucket), batch_size):
                runs.append((label, bucket[i:i + batch_size]))
        batch_results = await asyncio.gather(*[
            _run_batch(lbl, b) for lbl, b in runs
        ])
        if len(runs) > 1:
            merged: Dict[Tuple[str, str], list] = {}
            for batch_rows in batch_results:
                for row in batch_rows:
                    key = (row[0], row[1])
                    existing = merged.get(key)
                    if existing is None:
                        merged[key] = list(row)
                    else:
                        existing[2] = (int(existing[2]) if existing[2] else 0) + (int(row[2]) if row[2] else 0)
                        ex_types = existing[3] if isinstance(existing[3], list) else ([existing[3]] if existing[3] else [])
                        new_types = row[3] if isinstance(row[3], list) else ([row[3]] if row[3] else [])
                        existing[3] = list(dict.fromkeys([*ex_types, *new_types]))
            rows = list(merged.values())
        else:
            rows = batch_results[0] if batch_results else []

        # Leaf-involving pairs (column→column, column→table, column→domain,
        # …) are no longer materialized — the full cube scales as
        # edges × hierarchy depth and OOMs the instance on large graphs.
        # They are completed here for the requested (bounded) URN sets
        # WITHOUT containment walks: exact typed raw mirrors + Redis
        # ancestor-chain resolution in Python (see
        # _synthesize_ondemand_lineage_pairs). Canonical container pairs
        # come from the materialized rows above with complete weights;
        # mixed-depth container pairs are derived from those cells via
        # the depth-stamp indexes.
        try:
            meta = await self._aggregation_run_meta()
        except Exception as e:
            logger.warning("Failed to resolve aggregation run meta: %s", e)
            meta = AggRunMeta("unknown", 1, None, None)
        raw_rows, mixed_rows, synth_degraded, stale_reason = (
            await self._synthesize_ondemand_lineage_pairs(
                source_urns, target_urns, containment_edges, lineage_edges,
                meta=meta, timeout=timeout,
            )
        )
        if raw_rows or mixed_rows:
            rows = [list(row) for row in rows]
            by_pair = {(row[0], row[1]): row for row in rows}
            # Leaf-involving rows are disjoint from materialized cells by
            # construction — a collision means a stale pre-boundary fine
            # cell still exists (graph not yet re-aggregated); the
            # materialized row wins until reconcile cleans it away.
            for row in raw_rows:
                pair = (row[0], row[1])
                if pair not in by_pair:
                    row = list(row)
                    by_pair[pair] = row
                    rows.append(row)
            # Mixed-level derived rows carry ONLY the strictly-below-the-
            # coarse-endpoint portion — ADD to a materialized canonical
            # row for the same pair (disjoint provenance), else append.
            for row in mixed_rows:
                existing = by_pair.get((row[0], row[1]))
                if existing is None:
                    row = list(row)
                    by_pair[(row[0], row[1])] = row
                    rows.append(row)
                    continue
                existing[2] = (
                    (int(existing[2]) if existing[2] else 0)
                    + (int(row[2]) if row[2] else 0)
                )
                ex_types = existing[3] if isinstance(existing[3], list) else (
                    [existing[3]] if existing[3] else []
                )
                new_types = row[3] if isinstance(row[3], list) else (
                    [row[3]] if row[3] else []
                )
                existing[3] = list(dict.fromkeys([*ex_types, *new_types]))

        # A failed materialized-edge batch is the same "answer is
        # incomplete for this graph state" condition as an on-demand
        # sub-query failure — fold it into the same degraded/stale_reason
        # computation rather than a parallel flag.
        degraded = synth_degraded or batch_failed
        if degraded and not stale_reason:
            stale_reason = "degraded"

        # The legacy single-query read returned rows weight-descending;
        # preserve that contract now that synthesized rows are appended.
        rows = sorted(rows, key=lambda r: -(int(r[2]) if r[2] else 0))
        return self._rows_to_aggregated_result(
            rows, last_materialized_at=meta.last_materialized_at,
            degraded=degraded,
            stale=bool(stale_reason),
            stale_reason=stale_reason,
            stamp_version=meta.stamp_version,
            regime=meta.regime,
        )

    # ------------------------------------------------------------------
    # Helpers for get_aggregated_edges_between
    # ------------------------------------------------------------------

    async def _synthesize_ondemand_lineage_pairs(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        containment_edges: Optional[List[str]],
        lineage_edges: Optional[List[str]],
        *,
        meta: Optional["AggRunMeta"] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[list, list, bool, Optional[str]]:
        """Complete the materialized cells for the requested (bounded) URN
        sets WITHOUT walking containment in Cypher. Returns
        ``(leaf_rows, mixed_rows, degraded, stale_reason)``.

        The previous implementation ran, on EVERY read in boundary regime:
        a per-node inbound path enumeration (``*1..16`` — the depth
        profile), and ``*0..16`` upward-resolution walks for leaf and
        mixed pairs. Measured 10-26s per canvas request on a 7.7M-element
        graph WITH healthy stampVersion=2 cells. All replaced by:

        * leaf detection — single-hop child-count probe (no walk);
        * containment depth — max over the node's own stamped incident
          :AGGREGATED cells (``_frontier_depths_from_stamps``,
          depth-index-backed);
        * upward resolution (leaf far-endpoints and Q3 mixed pairs) —
          READ-THROUGH the Redis ancestor-chain cache (cache hit = free;
          miss computes the chain bounded to this call's far set and
          caches it), resolved in Python. The first browse of a container
          set pays a bounded, one-time ancestor walk; subsequent reads hit
          the cache. This decouples read-cache warming from
          materialization — a cold cache no longer drops pairs or reports
          a stale condition that would (pointlessly) re-trigger a job.

        Regime dispatch (no probes here — see ``_aggregation_run_meta``):
        ``cube``    → exact raw mirror only (cells are complete; anything
                      more double-counts). Not stale.
        ``unknown`` → exact raw mirror + stale "unmaterialized" (the
                      trigger heals the graph).
        ``boundary`` + stampVersion < 2 → exact raw mirror + stale
                      "legacy_cells" (depth-keyed derivation impossible
                      until re-materialization re-stamps).
        ``boundary`` + stampVersion >= 2 → the structural path below.

        Weight semantics preserved from the walk implementation: leaf
        rows are disjoint from materialized cells; mixed rows carry only
        the strictly-below portion and are ADDED to canonical rows.
        Multi-parent chains resolve to every requested ancestor exactly
        once per (pair) — same dedupe the DISTINCT walk applied.
        """
        ltypes = self._alias_rel_types(
            [t for t in (lineage_edges or []) if t and t != "AGGREGATED"]
        )
        if not ltypes or not source_urns:
            return [], [], False, None
        if meta is None:
            meta = await self._aggregation_run_meta()

        if meta.regime != "boundary" or meta.stamp_version < 2:
            rows = await self._synthesize_raw_lineage_pairs(
                source_urns, target_urns, lineage_edges, timeout=timeout,
            )
            reason = None
            if meta.regime == "unknown":
                reason = "unmaterialized"
            elif meta.regime == "boundary" and meta.stamp_version < 2:
                reason = "legacy_cells"
            return rows, [], False, reason

        from backend.app.config.resilience import (
            AGGREGATED_EDGE_RESULT_CAP,
            AGGREGATED_SOURCE_URN_BATCH_SIZE,
        )
        try:
            containment = list(self._alias_rel_types(
                [t for t in (containment_edges or []) if t]
            ) or self._get_containment_edge_types())
        except Exception:
            containment = []
        if not containment:
            rows = await self._synthesize_raw_lineage_pairs(
                source_urns, target_urns, lineage_edges, timeout=timeout,
            )
            return rows, [], False, None
        c_pattern = "|".join(_sanitize_label(t) for t in containment)
        l_pattern = "|".join(_sanitize_label(t) for t in ltypes)
        cap = AGGREGATED_EDGE_RESULT_CAP
        batch = AGGREGATED_SOURCE_URN_BATCH_SIZE
        degraded = {"v": False}

        async def _run(cypher: str, params: Dict[str, Any]) -> list:
            try:
                res = await self._ro_query(cypher, params=params, timeout=timeout, op="agg.synth")
                return res.result_set or []
            except Exception as e:
                degraded["v"] = True
                logger.warning("On-demand lineage pair query failed: %s", e)
                return []

        async def _run_proj(cypher: str, params: Dict[str, Any]) -> list:
            try:
                res = await self._proj_ro_query(cypher, params=params, timeout=timeout, op="agg.synth_anchor")
                return res.result_set or []
            except Exception as e:
                degraded["v"] = True
                logger.warning("On-demand aggregated anchor query failed: %s", e)
                return []

        async def _profile(urns: List[str]) -> Dict[str, Tuple[bool, int]]:
            """urn → (is_container, containment depth). Leaf detection is
            a single-hop child-count probe; depth comes from the node's
            own stamped incident cells (depth-index seek). Nodes with no
            stamped cell get depth 0 — they cannot contribute mixed-depth
            derivation (no cells to derive from), which is exactly the
            correct degradation."""
            out: Dict[str, Tuple[bool, int]] = {}
            uniq = list(dict.fromkeys(u for u in urns if u))
            if not uniq:
                return out
            for label, bucket in await self._label_buckets(uniq):
                anchor = f"(n:{label})" if label else "(n)"
                for i in range(0, len(bucket), batch):
                    for row in await _run(
                        f"MATCH {anchor} WHERE n.urn IN $urns "
                        f"OPTIONAL MATCH (n)-[:{c_pattern}]->(ch) "
                        f"RETURN n.urn, count(ch)",
                        {"urns": bucket[i:i + batch]},
                    ):
                        if row and row[0]:
                            out[str(row[0])] = (int(row[1] or 0) > 0, 0)
            depths = await self._frontier_depths_from_stamps(uniq)
            for u, d in depths.items():
                if u in out:
                    out[u] = (out[u][0], int(d))
            return out

        async def _chain_resolve(
            far_urns: List[str], requested: List[str],
        ) -> Dict[str, List[str]]:
            """far urn → requested urns strictly ABOVE it (self excluded —
            exact matches are handled by callers directly).

            READ-THROUGH the ancestor-chain cache: a cache hit is free; a
            miss computes the chain (bounded to this call's far set) and
            caches it. The previous cache-ONLY read dropped the pair and
            flagged ``chain_cache_miss`` on every miss — and NOTHING on the
            browse path warmed the cache (only trace did; the materializer
            does not), so a browse-only user got a PERPETUAL
            chain_cache_miss that re-triggered a no-op re-materialization
            every few minutes. Read-through warms progressively: the first
            browse of a container set pays a bounded, one-time ancestor
            walk; every subsequent read hits the cache. This is NOT the old
            full-graph synthesis (10-26s) — it is bounded to the visible
            far-endpoints and cached."""
            req = set(requested)
            chains = await self._compute_and_store_ancestors_bulk(far_urns)
            out: Dict[str, List[str]] = {}
            for u, chain in chains.items():
                hits = [a for a in dict.fromkeys(chain or []) if a in req and a != u]
                if hits:
                    out[u] = hits
            return out

        rows: list = []
        mixed_rows: list = []

        if target_urns:
            src_prof = await _profile(source_urns)
            tgt_prof = await _profile(target_urns)
            src_leaves = [
                u for u in source_urns if not src_prof.get(u, (False, 0))[0]
            ]
            tgt_leaves = [
                u for u in target_urns if not tgt_prof.get(u, (False, 0))[0]
            ]
            src_containers = {
                u: src_prof[u][1] for u in source_urns
                if src_prof.get(u, (False, 0))[0]
            }
            tgt_containers = {
                u: tgt_prof[u][1] for u in target_urns
                if tgt_prof.get(u, (False, 0))[0]
            }
            tgt_set = set(target_urns)

            def _merge_rows(acc: Dict[Tuple[str, str], list],
                            x: str, y: str, weight, types) -> None:
                w = int(weight) if weight else 1
                tl = types if isinstance(types, list) else ([types] if types else [])
                cell = acc.get((x, y))
                if cell is None:
                    acc[(x, y)] = [x, y, w, list(tl)]
                else:
                    cell[2] += w
                    cell[3].extend(t for t in tl if t not in cell[3])

            # Q1 — requested LEAF sources: exact typed raw fan-out; far
            # endpoints matched exactly against the target set and/or
            # resolved upward via cached chains. No containment Cypher.
            leaf_acc: Dict[Tuple[str, str], list] = {}
            q1_far: list = []
            for x_label, x_bucket in await self._label_buckets(src_leaves):
                x_anchor = f"(x:{x_label})" if x_label else "(x)"
                for i in range(0, len(x_bucket), batch):
                    q1_far.extend(await _run(
                        f"MATCH {x_anchor}-[r:{l_pattern}]->(t) "
                        f"WHERE x.urn IN $xs "
                        f"RETURN x.urn, t.urn, count(r), "
                        f"collect(DISTINCT type(r)) LIMIT {cap}",
                        {"xs": x_bucket[i:i + batch]},
                    ))
            far_up = await _chain_resolve(
                [row[1] for row in q1_far if row and row[1]], target_urns)
            for row in q1_far:
                if not row or not row[0] or not row[1]:
                    continue
                x, t = str(row[0]), str(row[1])
                if t in tgt_set and x != t:
                    _merge_rows(leaf_acc, x, t, row[2], row[3])
                for y in far_up.get(t, ()):
                    if x != y:
                        _merge_rows(leaf_acc, x, y, row[2], row[3])

            # Q2 — requested LEAF targets: exact typed raw fan-in; sources
            # resolved upward to requested CONTAINERS only (leaf sources
            # were fully covered by Q1 — the two stay disjoint).
            if src_containers and tgt_leaves:
                q2_far: list = []
                for y_label, y_bucket in await self._label_buckets(tgt_leaves):
                    y_anchor = f"(y:{y_label})" if y_label else "(y)"
                    for i in range(0, len(y_bucket), batch):
                        q2_far.extend(await _run(
                            f"MATCH (s)-[r:{l_pattern}]->{y_anchor} "
                            f"WHERE y.urn IN $ys "
                            f"RETURN y.urn, s.urn, count(r), "
                            f"collect(DISTINCT type(r)) LIMIT {cap}",
                            {"ys": y_bucket[i:i + batch]},
                        ))
                src_up = await _chain_resolve(
                    [row[1] for row in q2_far if row and row[1]],
                    list(src_containers))
                for row in q2_far:
                    if not row or not row[0] or not row[1]:
                        continue
                    y, s = str(row[0]), str(row[1])
                    for x in src_up.get(s, ()):
                        if x != y:
                            _merge_rows(leaf_acc, x, y, row[2], row[3])
            rows = list(leaf_acc.values())

            # Q3 — mixed-DEPTH container pairs derived from stored cells
            # (depth-index-anchored), far endpoints resolved via chains.
            if src_containers and tgt_containers:
                mixed_rows = await self._mixed_depth_pairs(
                    src_containers, tgt_containers,
                    cap=cap, batch=batch,
                    run_proj=_run_proj, chain_resolve=_chain_resolve,
                )
        else:
            # Source-only mode: exact typed raw fan-out of requested leaf
            # sources (no target set to resolve upward against).
            src_prof = await _profile(source_urns)
            src_leaves = [
                u for u in source_urns if not src_prof.get(u, (False, 0))[0]
            ]
            for x_label, x_bucket in await self._label_buckets(src_leaves):
                x_anchor = f"(x:{x_label})" if x_label else "(x)"
                for i in range(0, len(x_bucket), batch):
                    rows.extend(await _run(
                        f"MATCH {x_anchor}-[r:{l_pattern}]->(t) "
                        f"WHERE x.urn IN $xs AND t.urn <> x.urn "
                        f"RETURN x.urn AS sUrn, t.urn AS tUrn, "
                        f"count(r) AS weight, "
                        f"collect(DISTINCT type(r)) AS types LIMIT {cap}",
                        {"xs": x_bucket[i:i + batch]},
                    ))

        # Chain resolution is now read-THROUGH (computes + caches on miss),
        # so container roll-up pairs always resolve — there is no
        # chain_cache_miss staleness and nothing to self-heal here. A true
        # sub-query failure is surfaced via ``degraded`` instead.
        return rows, mixed_rows, degraded["v"], None

    async def _mixed_depth_pairs(
        self,
        src_containers: Dict[str, int],
        tgt_containers: Dict[str, int],
        *,
        cap: int,
        batch: int,
        run_proj,
        chain_resolve,
    ) -> list:
        """Derive mixed-DEPTH container pairs (table→domain, domain→table)
        from the materialized canonical cells, keyed on the structural
        ``sourceDepth``/``targetDepth`` stamps — no ontology labels or
        type levels anywhere, so self-nesting ontologies derive
        correctly.

        For each direction: (1) anchor the FINER endpoint's stored
        :AGGREGATED cells at the anchor's own rank
        (``r.targetDepth <= r.sourceDepth`` for fan-out — depth-index-
        backed after WS2), (2) resolve the far endpoints STRICTLY upward
        via the Redis ancestor-chain cache in Python (the previous
        ``*1..hops`` Cypher walk is gone from the read path; a chain
        miss drops the pair and flags ``stale``), (3) join against the
        requested strictly-coarser far side and sum.

        The strictly-upward resolution keeps these sums DISJOINT from any
        directly-materialized canonical cell for the same pair — the
        caller must therefore ADD a derived row's weight to a
        materialized row, not drop it.

        Known bound (multi-parent diamonds only): a raw edge whose far
        endpoint sits under TWO stored reps that both resolve up to the
        same requested coarser node is summed once per rep — mixed-depth
        weights can overcount on such shapes in boundary regime. Cube
        regime (the default within budget) stores these pairs exactly.
        """
        cells: Dict[Tuple[str, str], list] = {}

        def _merge(x: str, y: str, weight, types) -> None:
            w = int(weight) if weight else 1
            tl = types if isinstance(types, list) else ([types] if types else [])
            cell = cells.get((x, y))
            if cell is None:
                cells[(x, y)] = [w, list(tl)]
            else:
                cell[0] += w
                cell[1].extend(t for t in tl if t not in cell[1])

        # Fan-out: requested source containers anchored on their stored
        # at-rank cells; far side resolved up to STRICTLY SHALLOWER
        # requested targets. Anchors grouped by depth so each group joins
        # only its coarser counterparts.
        depths = sorted({d for d in src_containers.values()})
        for dx in depths:
            xs = [u for u, d in src_containers.items() if d == dx]
            ys = [u for u, d in tgt_containers.items() if d < dx]
            if not xs or not ys:
                continue
            fanout = []
            for x_label, x_bucket in await self._label_buckets(xs):
                x_anchor = f"(x:{x_label})" if x_label else "(x)"
                for i in range(0, len(x_bucket), batch):
                    fanout.extend(await run_proj(
                        f"MATCH {x_anchor}-[r:AGGREGATED]->(t2) "
                        f"WHERE x.urn IN $xs AND r.targetDepth <= r.sourceDepth "
                        f"RETURN x.urn, t2.urn, r.weight, r.sourceEdgeTypes "
                        f"LIMIT {cap}",
                        {"xs": x_bucket[i:i + batch]},
                    ))
            up = await chain_resolve(
                [row[1] for row in fanout if row and row[1]], ys)
            for row in fanout:
                for y in up.get(row[1], ()):
                    _merge(row[0], y, row[2], row[3])

        # Fan-in mirror: requested target containers anchored; far side
        # resolved up to strictly shallower requested sources.
        depths = sorted({d for d in tgt_containers.values()})
        for dy in depths:
            ys = [u for u, d in tgt_containers.items() if d == dy]
            xs = [u for u, d in src_containers.items() if d < dy]
            if not xs or not ys:
                continue
            fanin = []
            for y_label, y_bucket in await self._label_buckets(ys):
                y_anchor = f"(y:{y_label})" if y_label else "(y)"
                for i in range(0, len(y_bucket), batch):
                    fanin.extend(await run_proj(
                        f"MATCH (s2)-[r:AGGREGATED]->{y_anchor} "
                        f"WHERE y.urn IN $ys AND r.sourceDepth <= r.targetDepth "
                        f"RETURN y.urn, s2.urn, r.weight, r.sourceEdgeTypes "
                        f"LIMIT {cap}",
                        {"ys": y_bucket[i:i + batch]},
                    ))
            up = await chain_resolve(
                [row[1] for row in fanin if row and row[1]], xs)
            for row in fanin:
                for x in up.get(row[1], ()):
                    _merge(x, row[0], row[2], row[3])

        return [[x, y, w, tl] for (x, y), (w, tl) in cells.items()]

    async def _synthesize_raw_lineage_pairs(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        lineage_edges: Optional[List[str]],
        *,
        timeout: Optional[float] = None,
    ) -> list:
        """Aggregate raw lineage edges between the requested URN sets into
        the same row shape as the AGGREGATED read (sUrn, tUrn, weight,
        types) — one row per (s, t) pair, weight = parallel-edge count.

        This is the read-side replacement for the leaf↔leaf mirror pairs
        the pipeline stopped materializing. Runs on the SOURCE graph
        (raw lineage lives there even in dedicated projection mode) with
        a URN-index-driven MATCH, grouped server-side.
        """
        from backend.app.config.resilience import AGGREGATED_SOURCE_URN_BATCH_SIZE

        ltypes = self._alias_rel_types(
            [t for t in (lineage_edges or []) if t and t != "AGGREGATED"]
        )
        if not ltypes:
            return []

        # Anchors label-qualified per source bucket — an unlabeled
        # ``s.urn IN $list`` is a full scan on builds without a
        # label-less URN index; the "" bucket keeps the unlabeled form.
        def _cypher_for(label: str) -> str:
            anchor = f"(s:{label})" if label else "(s)"
            if target_urns:
                return (
                    f"MATCH {anchor}-[r]->(t) "
                    "WHERE s.urn IN $sourceUrns AND t.urn IN $targetUrns "
                    "AND type(r) IN $ltypes AND s.urn <> t.urn "
                    "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                    "count(r) AS weight, collect(DISTINCT type(r)) AS types"
                )
            return (
                f"MATCH {anchor}-[r]->(t) "
                "WHERE s.urn IN $sourceUrns "
                "AND type(r) IN $ltypes AND s.urn <> t.urn "
                "RETURN s.urn AS sUrn, t.urn AS tUrn, "
                "count(r) AS weight, collect(DISTINCT type(r)) AS types"
            )

        async def _run_batch(label: str, batch: List[str]) -> list:
            params: Dict[str, Any] = {"sourceUrns": batch, "ltypes": list(ltypes)}
            if target_urns:
                params["targetUrns"] = target_urns
            try:
                result = await self._ro_query(
                    _cypher_for(label), params=params, timeout=timeout,
                )
                return result.result_set or []
            except Exception as e:
                logger.warning(f"Raw lineage pair synthesis failed: {e}")
                return []

        batch_size = AGGREGATED_SOURCE_URN_BATCH_SIZE
        runs: List[Tuple[str, List[str]]] = []
        for label, bucket in await self._label_buckets(source_urns):
            for i in range(0, len(bucket), batch_size):
                runs.append((label, bucket[i:i + batch_size]))
        batch_results = await asyncio.gather(*[_run_batch(l, b) for l, b in runs])
        return [row for rows in batch_results for row in rows]

    def _rows_to_aggregated_result(
        self,
        rows: list,
        *,
        last_materialized_at: Optional[str] = None,
        degraded: bool = False,
        stale: bool = False,
        stale_reason: Optional[str] = None,
        stamp_version: Optional[int] = None,
        regime: Optional[str] = None,
    ) -> AggregatedEdgeResult:
        """Convert raw Cypher result rows into AggregatedEdgeResult."""
        from backend.app.config.resilience import AGGREGATED_EDGE_RESULT_CAP
        aggregated = []
        total_edges = 0
        for row in rows:
            s_urn, t_urn, weight, types = row[0], row[1], row[2], row[3]
            w = int(weight) if weight else 1
            edge_types = types if isinstance(types, list) else [str(types)] if types else []
            aggregated.append(AggregatedEdgeInfo(
                id=f"agg-{s_urn}-{t_urn}",
                sourceUrn=s_urn,
                targetUrn=t_urn,
                edgeCount=w,
                edgeTypes=edge_types,
                confidence=1.0,
                sourceEdgeIds=[],
            ))
            total_edges += w
        return AggregatedEdgeResult(
            aggregatedEdges=aggregated,
            totalSourceEdges=total_edges,
            truncated=degraded or len(aggregated) >= AGGREGATED_EDGE_RESULT_CAP,
            lastMaterializedAt=last_materialized_at,
            stale=stale or bool(stale_reason),
            staleReason=stale_reason,
            stampVersion=stamp_version,
            regime=regime,
        )

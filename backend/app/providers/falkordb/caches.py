"""FalkorDB cache-key namespacing and aggregation-regime memoization — ``CacheMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split: the
"URN → label cache (Redis Hash)" comment header through
``_get_cached_label`` (lines 67-290), a single contiguous block that
opened the class body, immediately after the class docstring.

This mixin owns ``_cache_ns`` / ``physical_graph_id`` — the (host, port,
graph_name) namespace every Redis key in the provider hangs off — plus
the urn→label cache and the aggregation-run-metadata / storage-regime
memoization built on top of it. ``physical_graph_id`` is reached from
outside the provider (``app/api/v1/endpoints/graph.py`` via ``getattr``,
and ``app/services/graph_cache.py``, which hashes it into cache keys), so
it stays a public method on the composed class. See carve-protocol.md in
``.superpowers/sdd/2026-08-30-pr1-falkordb-decoupling/`` for why this has
to be a mixin rather than a delegate/helper object.
"""
import os
import time
from typing import Dict, Optional

from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.aggregation import AggRunMeta


class CacheMixin:
    """Redis cache-key namespace for the provider, the urn→label cache,
    and the aggregation-run-metadata / storage-regime memoization built
    on top of it."""

    # ---- URN → label cache (Redis Hash) ----

    @property
    def _cache_ns(self) -> str:
        """Namespace for ALL provider-level Redis cache keys (urn→label,
        ancestor chains, ontology/stats/regime markers, agg-membership).

        Must identify the PHYSICAL graph — (FalkorDB endpoint, graph name)
        — NOT the graph name alone. ``graph_name`` defaults to the literal
        ``"nexus_lineage"`` when unset and the DB uniqueness constraint is
        (workspace, provider, graph_name), so the SAME graph_name can name
        DIFFERENT physical graphs on different FalkorDB instances. Keying
        caches by graph_name alone let a shared ``CACHE_REDIS_URL`` leak
        URN labels / ancestor chains / regime across two tenants' graphs
        that happen to share a name — wrong labels (dropped nodes), wrong
        ancestor trees (cross-tenant rollups). host:port:graph_name keeps
        distinct instances distinct; the same instance+graph legitimately
        shares (it is literally the same physical graph). NOTE this is a
        cache prefix only — the FalkorDB graph SELECTION still uses the
        bare ``self._graph_name``.
        """
        host = getattr(self, "_host", "") or ""
        port = getattr(self, "_port", "") or ""
        return f"{host}:{port}:{self._graph_name}"

    def physical_graph_id(self) -> str:
        """Public read-only accessor for this provider's physical-graph
        identity — the same (host, port, graph_name) triple ``_cache_ns``
        uses. Exposed so callers OUTSIDE this module (the response cache's
        ``CacheScope.graph_ns`` in graph_cache.py) can namespace their own
        cache keys by physical graph without duplicating the host/port/
        graph_name plumbing here."""
        return self._cache_ns

    def _urn_label_key(self) -> str:
        return f"{self._cache_ns}:urn_labels"

    def _agg_last_materialized_key(self) -> str:
        return f"{self._cache_ns}:agg:last_materialized_at"

    def _agg_regime_key(self) -> str:
        return f"{self._cache_ns}:agg:regime"

    def _agg_members_prefix(self) -> str:
        """Prefix for the per-pair agg-membership SETs (aggregation
        bookkeeping). A method so tests can stub it, and so the physical
        namespace stays in one place."""
        return f"{self._cache_ns}:agg_members"

    async def _aggregation_run_meta(self) -> "AggRunMeta":
        """Resolved aggregation-run metadata for the read paths.

        Precedence: the operator's fine-pairs env escape hatch → the
        in-graph ``_AggMeta`` singleton (written atomically by the batch
        pipeline at run end — survives Redis loss and topology splits) →
        the legacy Redis regime marker → a graph probe for non-conforming
        rows (NULL aggKey or NULL level stamps — legacy strategies and
        pre-canonical incremental writers). Cached ~5 minutes.

        ``regime``: 'cube' = every ancestor combination stored (readers
        serve purely from storage; mixed-level derivation MUST stay off
        or every mixed weight double-counts); 'boundary' = canonical
        depth-diagonal only (depth-keyed derivation fills the rest).
        ``stamp_version`` >= 2 means every edge carries
        sourceDepth/targetDepth. ``last_materialized_at`` feeds the
        result payload + the context-engine backfill trigger, so a graph
        that HAS materialized but lost its Redis key no longer
        re-triggers materialization on every empty read."""
        cached = getattr(self, "_agg_meta_cached", None)
        now = time.monotonic()
        if cached and now - cached[1] < 300.0:
            return cached[0]
        meta: Optional[AggRunMeta] = None
        try:
            res = await self._proj_ro_query(
                "MATCH (m:_AggMeta {id: 'singleton'}) "
                "RETURN m.regime, m.stampVersion, m.maxDepth, "
                "m.lastMaterializedAt LIMIT 1",
            )
            rows = res.result_set or []
            if rows and rows[0] and rows[0][0] in ("cube", "boundary"):
                row = rows[0]
                meta = AggRunMeta(
                    str(row[0]),
                    int(row[1]) if row[1] is not None else 1,
                    int(row[2]) if row[2] is not None else None,
                    str(row[3]) if row[3] is not None else None,
                )
        except Exception as e:
            logger.debug("Aggregation _AggMeta read failed: %s", e)
        if meta is None:
            meta = await self._legacy_regime_meta()
        if os.getenv(
            "AGGREGATION_MATERIALIZE_FINE_PAIRS", "false"
        ).strip().lower() in ("1", "true", "yes", "on"):
            # Operator escape hatch forces the cube CONTRACT (mixed-level
            # derivation off) without discarding the resolved timestamp
            # or stamp version.
            #
            # The default here stays "false" even though the pipeline's
            # ``_materialize_fine_pairs_mode`` now defaults to "true", and
            # the asymmetry is deliberate: this is a READ, and every run
            # stamps the regime it actually used onto ``_AggMeta``. An unset
            # env var means "believe the stamp", which is right whichever way
            # the write default points — a graph last built under "auto" that
            # fell back to the diagonal must keep deriving mixed levels. Only
            # an EXPLICIT setting overrides the stamp.
            meta = meta._replace(regime="cube")
        self._agg_meta_cached = (meta, now)
        return meta

    async def _legacy_regime_meta(self) -> "AggRunMeta":
        """Marker fallback for graphs that predate ``_AggMeta``. Stamp
        version 1: depth stamps unknown — depth-keyed readers must not
        trust them and fall back to stored rows only.

        READ PATHS NEVER PROBE: the old non-conforming-row probe scanned
        up to every :AGGREGATED relation (measured 2.0s over 1M cells on
        the 3M graph) once per 5 minutes ON THE READ PATH. Graphs with no
        marker now resolve to regime="unknown" — readers serve stored
        cells + the exact raw mirror with ``stale=true`` and let the
        auto-materialization trigger heal the graph. The probe survives
        only in :meth:`_aggregation_storage_regime` for WRITE-hook
        dispatch (rare, and a wrong guess there risks double-counted
        increments, which staleness signalling cannot excuse)."""
        regime: Optional[str] = None
        last_at: Optional[str] = None
        try:
            if self._redis is not None:
                raw = await self._redis.get(self._agg_regime_key())
                if raw:
                    val = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
                    if val == "boundary":
                        regime = "boundary"
                    elif val == "fine":
                        regime = "cube"
                raw = await self._redis.get(self._agg_last_materialized_key())
                if raw is not None:
                    last_at = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
        except Exception as e:
            logger.debug("Aggregation regime marker read failed: %s", e)
        return AggRunMeta(regime or "unknown", 1, None, last_at)

    async def _probe_nonconforming_cells(self) -> Optional[bool]:
        """One LIMIT-1 scan for rows missing aggKey/level stamps. None =
        probe failed. NOT for read paths — write-hook dispatch only."""
        try:
            res = await self._proj_ro_query(
                "MATCH ()-[r:AGGREGATED]->() "
                "WHERE r.aggKey IS NULL OR r.sourceLevel IS NULL "
                "RETURN 1 LIMIT 1",
                op="agg.regime_probe",
            )
            return bool(res.result_set)
        except Exception as e:
            logger.debug("Aggregation regime probe failed: %s", e)
            return None

    async def _aggregation_storage_regime(self) -> str:
        """Legacy two-value view of ``_aggregation_run_meta``:
        ``'boundary'`` when the stored set is the canonical selection,
        ``'fine'`` when it is (or may be) a full cube.

        WRITE-HOOK consumer: on ``unknown`` (no _AggMeta, no marker) it
        still probes for non-conforming rows — a wrong regime guess here
        double-counts incremental weights, and writes are rare enough
        that the probe is acceptable off the read path. The probe result
        rides the 5-minute meta cache."""
        meta = await self._aggregation_run_meta()
        if meta.regime == "boundary":
            return "boundary"
        if meta.regime == "cube":
            return "fine"
        # unknown → probe once (cached alongside the meta for 5 min).
        cached = getattr(self, "_regime_probe_cached", None)
        now = time.monotonic()
        if cached and now - cached[1] < 300.0:
            found = cached[0]
        else:
            found = await self._probe_nonconforming_cells()
            self._regime_probe_cached = (found, now)
        if found is False:
            return "boundary"
        return "fine"

    def _agg_in_flight_key(self, ds_id: str) -> str:
        return f"materialize:in-flight:{ds_id}"

    def _urn_label_ttl(self) -> int:
        return int(os.getenv("FALKORDB_URN_LABEL_CACHE_TTL_S", "604800"))  # 7d

    async def _cache_urn_label(self, urn: str, label: str) -> None:
        """Store a single urn→label mapping."""
        try:
            key = self._urn_label_key()
            await self._redis.hset(key, urn, label)
            # TTL on EVERY write path (not only warmup): a TTL-less hash is
            # unevictable under volatile-lru, so a fleet of warmed 2M-node
            # graphs would wedge Redis at maxmemory. Refresh-on-write keeps
            # active graphs warm and lets idle ones expire.
            await self._redis.expire(key, self._urn_label_ttl())
        except Exception:
            pass  # best-effort

    async def _cache_urn_labels_bulk(self, mapping: Dict[str, str]) -> None:
        """Bulk-store urn→label mappings via pipeline."""
        if not mapping:
            return
        try:
            pipe = self._redis.pipeline(transaction=False)
            key = self._urn_label_key()
            for urn, label in mapping.items():
                pipe.hset(key, urn, label)
            pipe.expire(key, self._urn_label_ttl())  # keep the hash evictable
            await pipe.execute()
        except Exception:
            pass  # best-effort

    async def _get_cached_label(self, urn: str) -> Optional[str]:
        """Look up the label for a URN from Redis cache."""
        try:
            return await self._redis.hget(self._urn_label_key(), urn)
        except Exception:
            return None

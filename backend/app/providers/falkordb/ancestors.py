"""FalkorDB ancestor-chain computation and caching — ``AncestorMixin``.

Carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split:
``_ancestors_cache_key`` through ``_compute_ancestor_chains_bulk_cypher``
(lines 1458-1723), a single contiguous block.

This mixin resolves and caches the upward containment chain for a URN.
``_ancestors_cache_key`` scopes the Redis Hash by a fingerprint of the
resolved containment types, so a containment reclassification routes
reads to a fresh cache namespace with no manual invalidation —
``tests/test_falkordb_ancestors_cache_reset.py`` pins that behaviour and
builds the provider via ``FalkorDBProvider.__new__``, so nothing here may
assume ``__init__`` ran. See ``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2 for why this has
to be a mixin rather than a delegate/helper object.
"""
import asyncio
import json
import os
from typing import Dict, List

from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.rowmap import _sanitize_label


class AncestorMixin:
    """Ancestor-chain computation and Redis caching, scoped by a
    fingerprint of the resolved containment-type configuration."""

    def _ancestors_cache_key(self) -> str:
        """Return the Redis Hash key for ancestor chains in this graph,
        scoped by the resolved containment-types fingerprint.

        Different containment configurations resolve to different
        ancestor chains for the same URN, so they must live in
        different cache namespaces. Without this scoping, a prior job
        that ran with empty ``containment_edge_types`` would cache
        ``"[]"`` for every URN and every subsequent job (with proper
        types) would silently see cache hits and produce only
        leaf-to-leaf AGGREGATED edges instead of propagating up the
        containment tree.

        The fingerprint is a short SHA1 over the sorted, upper-cased
        type names. Empty / unset → a stable empty-set fingerprint
        that flat-graph aggregations reuse safely. Identical
        configurations (across jobs, across caller paths) reuse the
        same key — full intra- and cross-job caching preserved.
        """
        import hashlib

        types = getattr(self, "_resolved_containment_types", None) or set()
        if not isinstance(types, (set, frozenset, list, tuple)):
            types = set()
        normalised = ",".join(sorted(t.upper() for t in types))
        digest = hashlib.sha1(normalised.encode("utf-8")).hexdigest()[:12]
        return f"{self._cache_ns}:ancestors:{digest}"

    async def _get_ancestor_chain(self, urn: str) -> List[str]:
        """Get pre-computed ancestor chain from Redis Hash, or compute + cache it.

        Returns list of URNs from immediate parent to root (ordered).
        The cache key includes a containment-types fingerprint so a
        change to the resolved containment configuration cannot return
        a stale chain from a prior config (see ``_ancestors_cache_key``).
        """
        cache_key = self._ancestors_cache_key()
        try:
            raw = await self._redis.execute_command("HGET", cache_key, urn)
            if raw:
                return json.loads(raw)
        except Exception:
            pass

        # Cache miss — compute from graph and store
        ancestors = await self._compute_ancestor_chain(urn)
        try:
            await self._redis.execute_command(
                "HSET", cache_key, urn, json.dumps(ancestors)
            )
            # TTL so the ancestors hash stays evictable (see _cache_urn_label).
            await self._redis.expire(cache_key, self._ancestor_cache_ttl())
        except Exception as e:
            logger.debug(f"Failed to cache ancestor chain for {urn}: {e}")
        return ancestors

    async def _compute_ancestor_chain(self, urn: str) -> List[str]:
        """Single Cypher query to walk containment edges upward (1 query instead of N).

        Variable-length depth bound is the number of entity-type levels
        in the resolved ontology (clamped to a 10 floor for safety on
        cold caches). This is tighter and more correct than the legacy
        hardcoded ``*1..10`` for shallow ontologies, and extends to
        deeper ones without code edits.
        """
        # Delegates to the label-driven bulk path — the previous
        # unlabeled ``WHERE child.urn = $urn`` was a full node scan per
        # call on servers without unlabeled-index support.
        chains = await self._compute_ancestor_chains_bulk_cypher([urn])
        return chains.get(urn, [])

    async def _compute_and_store_ancestors_bulk(
        self,
        urns: List[str],
    ) -> Dict[str, List[str]]:
        """Compute and cache ancestor chains for multiple URNs at once.

        Uses Redis pipeline for batch HGET/HSET and a single bulk Cypher
        (``UNWIND $urns AS u``) to compute every missing chain in one
        round-trip per chunk, eliminating the per-URN compile + send +
        receive overhead that previously dominated this path on large
        outer batches. Cache namespace is scoped by containment-types
        fingerprint (see ``_ancestors_cache_key``) so a config change
        cannot leak stale chains from a prior configuration.

        On bulk-Cypher failure, falls back to the per-URN path with
        bounded concurrency so a single planner hiccup doesn't fail the
        whole outer batch.
        """
        cache_key = self._ancestors_cache_key()
        result: Dict[str, List[str]] = {}

        if not urns:
            return result

        # First, try to fetch all from cache in one pipeline
        try:
            pipe = self._redis.pipeline(transaction=False)
            for u in urns:
                pipe.execute_command("HGET", cache_key, u)
            cached = await pipe.execute()

            missing_urns = []
            for i, u in enumerate(urns):
                if cached[i]:
                    try:
                        result[u] = json.loads(cached[i])
                    except Exception:
                        missing_urns.append(u)
                else:
                    missing_urns.append(u)
        except Exception:
            missing_urns = list(urns)

        if missing_urns:
            try:
                computed = await self._compute_ancestor_chains_bulk_cypher(missing_urns)
            except Exception as exc:
                logger.warning(
                    "Bulk ancestor Cypher failed for %d urns (%s); "
                    "falling back to per-URN computation.",
                    len(missing_urns), exc,
                )
                _MAX_ANCESTOR_CONCURRENCY = 4
                sem = asyncio.Semaphore(_MAX_ANCESTOR_CONCURRENCY)

                async def _compute_with_sem(urn: str) -> tuple[str, list]:
                    async with sem:
                        try:
                            return urn, await self._compute_ancestor_chain(urn)
                        except Exception as e:
                            logger.warning(
                                "Failed to compute ancestor chain for %s: %s", urn, e,
                            )
                            return urn, []

                pairs = await asyncio.gather(
                    *(_compute_with_sem(u) for u in missing_urns),
                )
                computed = {u: chain for u, chain in pairs}

            for u in missing_urns:
                result[u] = computed.get(u, [])

            # Batch-store all computed chains in one pipeline.
            #
            # The cache is an OPTIMIZATION, never a hard dependency. There is no
            # cache client when CACHE_REDIS_URL is unset OR when the dedicated
            # cache Redis is simply DOWN (``build_cache_client`` returns None by
            # construction — it never co-locates the cache on FalkorDB). Guard
            # the write: this line used to raise AttributeError on a None client
            # and, because the raise escaped the whole method, it THREW AWAY the
            # chains that had just been computed successfully above. Callers saw
            # `truncated: ancestors_failed` and a trace with NO containment tree
            # — i.e. a cache outage silently broke the graph read path, the exact
            # inverse of the decoupling's intent.
            if self._redis is not None:
                store_pipe = self._redis.pipeline(transaction=False)
                for u in missing_urns:
                    store_pipe.execute_command(
                        "HSET", cache_key, u, json.dumps(result.get(u, [])),
                    )
                # TTL so the ancestors hash stays evictable (see _cache_urn_label).
                store_pipe.expire(cache_key, self._ancestor_cache_ttl())
                try:
                    await store_pipe.execute()
                except Exception as e:
                    logger.debug(f"Failed to batch-store ancestor chains: {e}")

        return result

    def _ancestor_cache_ttl(self) -> int:
        return int(os.getenv("FALKORDB_ANCESTOR_CACHE_TTL_S", "604800"))  # 7d

    async def _compute_ancestor_chains_bulk_cypher(
        self,
        urns: List[str],
    ) -> Dict[str, List[str]]:
        """Compute ancestor chains for many URNs in a single Cypher.

        Preserves the longest-path semantics of
        ``_compute_ancestor_chain``: each URN's chain is the ordered
        ``[parent, grandparent, ...]`` along the longest containment
        path, matching what callers that depend on parent-before-
        grandparent ordering already expect.

        Internally chunked to bound the per-query parameter size; the
        planner sees one set of bound variables per chunk and only one
        round-trip is paid per chunk regardless of how many URNs miss
        the cache. This is the fix for the per-URN scan amplification
        documented in the aggregation hardening plan.
        """
        out: Dict[str, List[str]] = {u: [] for u in urns}
        if not urns:
            return out

        containment = list(self._get_containment_edge_types())
        if not containment:
            # Flat graph — no ancestors for any URN.
            return out

        containment_cypher = "|".join(_sanitize_label(t) for t in containment)
        max_depth = self._containment_hop_bound()

        # Keep parameter lists bounded so a single misconfigured outer
        # batch (e.g. 10k URNs) doesn't generate a single oversized
        # query plan that itself spikes provider CPU. The default is tuned
        # to cut per-page round-trips (each page resolves ~2×batch_size URNs);
        # override via FALKORDB_ANCESTOR_CHUNK_SIZE.
        chunk_size = int(os.getenv("FALKORDB_ANCESTOR_CHUNK_SIZE", "2000"))

        # LABEL-DRIVEN anchoring. An unlabeled ``MATCH (child) WHERE
        # child.urn IN $urns`` is a FULL node scan per chunk on FalkorDB
        # versions without unlabeled-index support (observed: 1776-urn
        # chunk timing out on a 1M-node graph, then degrading to 1776
        # per-URN full scans). Every ontology label has a URN index, so
        # each chunk is classified per label (indexed IN lookups) and
        # the path expansion anchors on ``(child:Label)`` — index seeks
        # end to end. URNs matching no ontology label sit outside the
        # containment hierarchy and keep their pre-initialized [] chain.
        def _chain_cypher(label_clause: str) -> str:
            return (
                f"MATCH (child{label_clause}) WHERE child.urn IN $urns "
                f"OPTIONAL MATCH path = (child)<-[:{containment_cypher}*1..{max_depth}]-(a) "
                "WITH child.urn AS u, "
                "     [n IN nodes(path)[1..] | n.urn] AS chain_candidate, "
                "     coalesce(length(path), 0) AS plen "
                "ORDER BY u, plen DESC "
                "WITH u, collect(chain_candidate) AS candidates "
                "RETURN u, coalesce(candidates[0], []) AS chain"
            )

        for i in range(0, len(urns), chunk_size):
            chunk = urns[i : i + chunk_size]
            # Bucket via the urn→label cache (per-label bootstrap on miss)
            # instead of the previous per-label MEMBERSHIP query + chain
            # query run SEQUENTIALLY per ontology label (2·L round trips
            # per chunk — the dominant sequential amplifier of trace
            # hydration). One chain query per non-empty bucket, GATHERED;
            # the unresolved-label residue keeps the unlabeled fallback.
            buckets = await self._label_buckets(chunk)

            async def _chain_for(label: str, bucket: List[str]) -> list:
                clause = f":{label}" if label else ""
                try:
                    res = await self._ro_query(
                        _chain_cypher(clause), params={"urns": bucket},
                        op="trace.chains",
                    )
                    return res.result_set or []
                except Exception as exc:
                    logger.warning(
                        "ancestor chain bucket (%s, %d urns) failed: %s",
                        label or "<unlabeled>", len(bucket), exc,
                    )
                    return []

            for rows in await asyncio.gather(*[
                _chain_for(lbl, bucket) for lbl, bucket in buckets
            ]):
                for row in rows:
                    # Drop None entries (node lacked .urn) so callers
                    # don't defend against them.
                    out[row[0]] = [c for c in (row[1] or []) if c]

        return out

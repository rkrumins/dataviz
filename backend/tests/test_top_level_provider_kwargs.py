"""Unit tests for the ``query_timeout`` / ``known_total_count`` kwargs added
to ``get_top_level_or_orphan_nodes`` on FalkorDBProvider and ContextEngine.

No live FalkorDB required — ``_ro_query`` is monkeypatched (same pattern as
``test_falkordb_failloud.py``).
"""
from __future__ import annotations

import pytest

from backend.app.config import resilience
from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import OntologyMetadata, TopLevelNodesResult


def _make_provider():
    p = FalkorDBProvider(host="x", graph_name="g")
    p._SCHEMA_CACHE_TTL = 0  # skip the redis cache read/write path

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    # Empty containment set = flat graph (a valid resolved state); keeps
    # `_get_containment_edge_types()` from raising ProviderConfigurationError.
    p._resolved_containment_types = set()
    p._resolved_containment_types_set = True
    return p


class _Result:
    def __init__(self, result_set):
        self.result_set = result_set


def _recording_ro_query(calls):
    """Records (cypher, params, timeout) for every call; count query
    returns a total of 7 so tests can distinguish "count ran" from not."""
    async def _ro_query(cypher, params=None, **kw):
        calls.append((cypher, params, kw.get("timeout")))
        if "count(" in cypher.lower():
            return _Result([[7]])
        return _Result([])
    return _ro_query


# ── Provider-level: timeout propagation ─────────────────────────────

@pytest.mark.asyncio
async def test_default_timeouts_page_and_count_budgets(monkeypatch):
    """Page gets the full budget; the count gets its own (shorter)
    best-effort budget."""
    p = _make_provider()
    calls = []
    monkeypatch.setattr(p, "_ro_query", _recording_ro_query(calls))
    await p.get_top_level_or_orphan_nodes(include_child_count=False)
    assert len(calls) == 2
    assert calls[0][2] == resilience.FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS
    assert calls[1][2] == resilience.FALKORDB_TOP_LEVEL_COUNT_TIMEOUT_SECS


@pytest.mark.asyncio
async def test_query_timeout_override_propagates_to_both_queries(monkeypatch):
    p = _make_provider()
    calls = []
    monkeypatch.setattr(p, "_ro_query", _recording_ro_query(calls))
    await p.get_top_level_or_orphan_nodes(include_child_count=False, query_timeout=99)
    assert len(calls) == 2
    assert calls[0][2] == 99
    assert calls[1][2] == 99


# ── Provider-level: ordering defense against the FalkorDB aggregating
#    ORDER-BY quirk (page rows arrive scrambled) ───────────────────────

def _scrambled_ro_query(rows, total):
    """Page query returns ``rows`` verbatim (deliberately NOT sorted, as
    FalkorDB does across an aggregating RETURN); the count query returns
    ``total``. Distinguished by ``count(n)`` which only the count query uses."""
    async def _ro_query(cypher, params=None, **kw):
        if "count(n)" in cypher:
            return _Result([[total]])
        return _Result(rows)
    return _ro_query


@pytest.mark.asyncio
async def test_scrambled_page_rows_sorted_and_cursor_is_page_max(monkeypatch):
    p = _make_provider()
    p._resolved_containment_types = {"HAS"}  # aggregating include_child_count branch
    calls = []
    scrambled = [
        [{"urn": "urn:3", "entityType": "layer", "displayName": "Web Analytics"}, 5],
        [{"urn": "urn:1", "entityType": "layer", "displayName": "Alpha"}, 1],
        [{"urn": "urn:4", "entityType": "layer", "displayName": "Mango"}, 3],
        [{"urn": "urn:2", "entityType": "layer", "displayName": "Beta"}, 2],
    ]

    async def _ro_query(cypher, params=None, **kw):
        calls.append(cypher)
        return await _scrambled_ro_query(scrambled, 4)(cypher, params, **kw)

    monkeypatch.setattr(p, "_ro_query", _ro_query)
    result = await p.get_top_level_or_orphan_nodes(
        root_entity_types=["layer"], limit=4, include_child_count=True,
    )

    names = [n.display_name for n in result.nodes]
    assert names == ["Alpha", "Beta", "Mango", "Web Analytics"]
    # next_cursor is the page maximum → keyset pagination never skips/overlaps.
    # Cursors are opaque k1: keyset tokens (displayName + urn tiebreaker) since
    # the duplicate-displayName paging fix; decode to assert the content.
    from backend.app.providers.falkordb_provider import _decode_keyset_cursor
    cursor_name, cursor_urn = _decode_keyset_cursor(result.next_cursor)
    assert cursor_name == "Web Analytics"
    assert cursor_name == max(names)
    assert cursor_urn == "urn:3"          # the unique tiebreaker rides along
    # childCount survives the reorder (attached per-node, order-independent).
    by_name = {n.display_name: n.child_count for n in result.nodes}
    assert by_name["Alpha"] == 1 and by_name["Web Analytics"] == 5
    # The Cypher fix: aggregation is re-projected through a WITH before ORDER BY.
    page_cypher = next(c for c in calls if "OPTIONAL MATCH" in c)
    # The keyset ordering now sorts by (displayName, urn) directly — the
    # load-bearing property is unchanged: aggregation is re-projected through
    # a WITH before ORDER BY, so the count survives the reorder.
    assert "WITH n, count(child) as childCount ORDER BY" in page_cypher


# ── Provider-level: count query is best-effort; page is not ─────────

@pytest.mark.asyncio
async def test_count_timeout_degrades_to_null_total(monkeypatch):
    """A count-query timeout must NOT fail the request: the page is
    returned intact with total_count=None (has_more stays page-derived)."""
    import asyncio

    p = _make_provider()

    async def _ro_query(cypher, params=None, **kw):
        if "count(" in cypher.lower():
            raise asyncio.TimeoutError()
        return _Result([
            [{"urn": "urn:1", "entityType": "layer", "displayName": "Alpha"}, 0],
        ])

    monkeypatch.setattr(p, "_ro_query", _ro_query)
    result = await p.get_top_level_or_orphan_nodes(include_child_count=False, limit=1)
    assert result.total_count is None
    assert [n.display_name for n in result.nodes] == ["Alpha"]
    assert result.has_more is True  # len(nodes) >= limit


@pytest.mark.asyncio
async def test_page_timeout_still_raises_with_budget_in_message(monkeypatch):
    """A page-query timeout is fatal (GraphCache stale-fallback handles
    it), and the re-raised error names the budget that fired instead of
    serializing to an empty string."""
    import asyncio

    p = _make_provider()

    async def _ro_query(cypher, params=None, **kw):
        raise asyncio.TimeoutError()

    monkeypatch.setattr(p, "_ro_query", _ro_query)
    with pytest.raises(asyncio.TimeoutError) as exc_info:
        await p.get_top_level_or_orphan_nodes(include_child_count=False)
    assert "provider budget" in str(exc_info.value)
    assert str(int(resilience.FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS)) in str(exc_info.value)


@pytest.mark.asyncio
async def test_count_transient_error_still_raises(monkeypatch):
    """Non-timeout count failures (connection refused etc.) keep the old
    fail-loud behavior — only the timeout path degrades."""
    p = _make_provider()

    async def _ro_query(cypher, params=None, **kw):
        if "count(" in cypher.lower():
            raise ConnectionError("refused")
        return _Result([])

    monkeypatch.setattr(p, "_ro_query", _ro_query)
    with pytest.raises(ConnectionError):
        await p.get_top_level_or_orphan_nodes(include_child_count=False)


# ── Provider-level: known_total_count skips the count query ────────

@pytest.mark.asyncio
async def test_known_total_count_skips_count_query(monkeypatch):
    p = _make_provider()
    calls = []
    monkeypatch.setattr(p, "_ro_query", _recording_ro_query(calls))
    result = await p.get_top_level_or_orphan_nodes(
        include_child_count=False, known_total_count=42,
    )
    assert len(calls) == 1  # only the page query ran
    assert result.total_count == 42


# ── Engine-level: pass-through + TypeError fallback ─────────────────

def _ontology_meta() -> OntologyMetadata:
    return OntologyMetadata(
        containmentEdgeTypes=[], lineageEdgeTypes=[], edgeTypeMetadata={},
        entityTypeHierarchy={}, rootEntityTypes=[],
    )


class _OldSignatureProvider:
    """Mimics DraftOverlayProvider / VersionedBranchProvider: fixed
    keyword-only signature, no query_timeout/known_total_count."""

    def __init__(self):
        self.calls = []

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return _ontology_meta()

    async def get_top_level_or_orphan_nodes(
        self, *, root_entity_types=None, entity_types=None, search_query=None,
        limit: int = 100, cursor=None, include_child_count: bool = True,
    ) -> TopLevelNodesResult:
        self.calls.append({"limit": limit})
        return TopLevelNodesResult(nodes=[], totalCount=0, hasMore=False)


class _NewSignatureProvider(_OldSignatureProvider):
    """Accepts the new kwargs (e.g. FalkorDBProvider)."""

    async def get_top_level_or_orphan_nodes(
        self, *, root_entity_types=None, entity_types=None, search_query=None,
        limit: int = 100, cursor=None, include_child_count: bool = True,
        query_timeout=None, known_total_count=None,
    ) -> TopLevelNodesResult:
        self.calls.append(
            {"query_timeout": query_timeout, "known_total_count": known_total_count}
        )
        return TopLevelNodesResult(
            nodes=[], totalCount=known_total_count or 0, hasMore=False,
        )


@pytest.mark.asyncio
async def test_engine_retries_without_extra_kwargs_on_old_provider():
    """Old fixed-signature provider raises TypeError on the new kwargs;
    the engine must retry once without them rather than propagating it."""
    provider = _OldSignatureProvider()
    engine = ContextEngine(provider=provider)
    result = await engine.get_top_level_or_orphan_nodes(known_total_count=1)
    assert result.total_count == 0  # old provider never saw known_total_count
    assert len(provider.calls) == 1  # only the successful retry call landed


@pytest.mark.asyncio
async def test_engine_passes_new_kwargs_to_new_provider():
    provider = _NewSignatureProvider()
    engine = ContextEngine(provider=provider)
    result = await engine.get_top_level_or_orphan_nodes(
        known_total_count=1, query_timeout=5,
    )
    assert result.total_count == 1
    assert provider.calls[0]["query_timeout"] == 5
    assert provider.calls[0]["known_total_count"] == 1


# ── Server TIMEOUT_MAX clamp + socket-timeout floor ──────────────────

from backend.app.providers.falkordb_provider import _clamp_db_timeout_ms


def test_clamp_db_timeout_ms_cancels_server_side_first_and_never_exceeds_the_cap():
    assert _clamp_db_timeout_ms(30, 180_000) == 29_500
    assert _clamp_db_timeout_ms(600, 180_000) == 180_000
    assert _clamp_db_timeout_ms(0.1, 180_000) == 500          # never below the floor
    assert _clamp_db_timeout_ms(600, 0) == 599_500             # 0 = no cap


def test_db_timeout_ms_uses_the_env_mirror_until_a_node_has_been_read(monkeypatch):
    """FalkorDB rejects (never runs) a query whose TIMEOUT exceeds the
    server's TIMEOUT_MAX — an over-budget caller (the collector's 600s
    materialization) must degrade to TIMEOUT_MAX, not fail instantly. Until
    a node has been read, the deployment's mirror is the cap."""
    monkeypatch.setattr(resilience, "FALKORDB_SERVER_TIMEOUT_MAX_MS", 180_000)
    p = _make_provider()
    assert p._server_timeout_cap_ms() == 180_000
    assert p._db_timeout_ms(600) == 180_000
    # Budgets under the cap keep the -500ms DB-cancels-first offset.
    assert p._db_timeout_ms(30) == 29_500
    monkeypatch.setattr(resilience, "FALKORDB_SERVER_TIMEOUT_MAX_MS", 0)
    assert p._db_timeout_ms(600) == 599_500


def test_a_cap_read_from_the_node_wins_over_the_env_mirror(monkeypatch):
    """The store's TIMEOUT_MAX can be raised at runtime from Infrastructure;
    the clamp must follow the node, not a stale env value — and the LOWEST
    known node governs, since the node that receives a query rejects it and
    a dedicated projection may live on a different node."""
    monkeypatch.setattr(resilience, "FALKORDB_SERVER_TIMEOUT_MAX_MS", 180_000)
    p = _make_provider()
    p.note_server_limits("10.0.0.1:6379", timeout_max_ms=300_000, query_mem_capacity=2 ** 30, thread_count=4)
    assert p._server_timeout_cap_ms() == 300_000
    assert p._db_timeout_ms(600) == 300_000
    assert p.server_query_mem_capacity() == 2 ** 30
    p.note_server_limits("10.0.0.2:6379", timeout_max_ms=120_000, query_mem_capacity=2 ** 29)
    assert p._server_timeout_cap_ms() == 120_000
    assert p.server_query_mem_capacity() == 2 ** 29
    # None never overwrites a known value; an unknown endpoint is ignored.
    p.note_server_limits("10.0.0.2:6379", timeout_max_ms=None)
    p.note_server_limits("unknown", timeout_max_ms=1_000)
    assert p._server_timeout_cap_ms() == 120_000
    assert p.server_limits_for("10.0.0.1:6379") == {
        "timeout_max_ms": 300_000, "query_mem_capacity": 2 ** 30, "thread_count": 4,
    }
    # A node reporting no cap (unlimited reads as None) leaves the env mirror in force.
    q = _make_provider()
    q.note_server_limits("10.0.0.3:6379", timeout_max_ms=None, thread_count=8)
    assert q._server_timeout_cap_ms() == 180_000 and q.server_query_mem_capacity() is None


def test_graph_socket_timeout_is_floored_above_the_largest_query_the_app_may_send(monkeypatch):
    """The graph-pool socket timeout must exceed the longest query the
    server may legitimately run, or the socket recv timeout kills long
    queries mid-flight. The cap can be raised at runtime up to the per-query
    knob maximum (600 s) after the pool is built, so the floor is that
    maximum — or a larger env cap — plus 15 s, including when the env says
    no cap at all (a 10 s socket used to kill any query over 10 s there).
    Per-call asyncio.wait_for budgets keep hang detection tight."""
    monkeypatch.setenv("FALKORDB_SOCKET_TIMEOUT", "10")
    monkeypatch.setattr(resilience, "FALKORDB_SERVER_TIMEOUT_MAX_MS", 180_000)
    assert _make_provider()._graph_socket_timeout() == pytest.approx(615.0)
    monkeypatch.setattr(resilience, "FALKORDB_SERVER_TIMEOUT_MAX_MS", 900_000)
    assert _make_provider()._graph_socket_timeout() == pytest.approx(915.0)
    monkeypatch.setattr(resilience, "FALKORDB_SERVER_TIMEOUT_MAX_MS", 0)
    assert _make_provider()._graph_socket_timeout() == pytest.approx(615.0)
    # A larger configured socket timeout is kept as it is.
    monkeypatch.setenv("FALKORDB_SOCKET_TIMEOUT", "1000")
    assert _make_provider()._graph_socket_timeout() == pytest.approx(1000.0)

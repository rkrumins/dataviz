"""The versioning subsystem's READS go out as ``GRAPH.RO_QUERY``.

``-NOREPLICAS Not enough good replicas to write`` is a per-command refusal: a
master running with ``min-replicas-to-write`` rejects every command the module
flags as a write while it is short of in-sync replicas. ``GRAPH.QUERY`` is
write-flagged whatever the Cypher inside it says, so a projection probe, a
reconcile count and a ``/graph/neighbors`` lookup — all pure ``MATCH … RETURN``
— were refused alongside the writes, and operators saw the raw NOREPLICAS text
in the UI during an hour-long node restart. ``GRAPH.RO_QUERY`` is not.

It is NOT a routing change. redis-py auto-routes only the commands in its own
read table and no ``GRAPH.*`` command is in it (see the note on the cluster
client in ``falkordb_connection``), so these still go to the primary that owns
the key and read exactly what the writes beside them just wrote. Only
``FalkorDBProvider`` targets a replica deliberately, through its own routing.

What this file pins: the helper sends the right command, a client without
``ro_query`` still works, and nothing sent read-only contains a write clause.
"""
from __future__ import annotations

import ast
import asyncio
import inspect
import pathlib

import pytest

from backend.app.services.versioning import bootstrap_worker as bw
from backend.app.services.versioning import projection as proj
from backend.app.services.versioning import reconcile as rec

#: Everything FalkorDB refuses inside a RO_QUERY.
WRITE_CLAUSES = (
    "CREATE", "MERGE", "SET ", "DELETE", "REMOVE", "DROP", "SET\n",
)


def _run(coro):
    return asyncio.run(coro)


class _Res:
    result_set = [[1]]


class _Recorder:
    """A graph handle that says which command each query arrived on."""

    def __init__(self):
        self.calls: list = []

    async def query(self, cypher, params=None, timeout=None):
        self.calls.append(("query", cypher))
        return _Res()

    async def ro_query(self, cypher, params=None, timeout=None):
        self.calls.append(("ro_query", cypher))
        return _Res()


class _QueryOnly:
    """An older client, or a test fake: no ``ro_query`` at all."""

    def __init__(self):
        self.calls: list = []

    async def query(self, cypher, params=None, timeout=None):
        self.calls.append(("query", cypher))
        return _Res()


class _NoTimeoutKwarg:
    """The client shape ``_q``'s TypeError fallback exists for."""

    def __init__(self):
        self.calls: list = []

    async def query(self, cypher, params=None):
        self.calls.append(("query", cypher))
        return _Res()

    async def ro_query(self, cypher, params=None):
        self.calls.append(("ro_query", cypher))
        return _Res()


# ── the helper ───────────────────────────────────────────────────────────


def test_read_only_sends_ro_query_and_a_write_does_not():
    rec_ = _Recorder()
    _run(proj._q(rec_, "MATCH (n) RETURN count(n)", read_only=True))
    _run(proj._q(rec_, "MERGE (m:_GVRollupMeta {id: 'meta'}) SET m.seq = 1"))
    assert [c[0] for c in rec_.calls] == ["ro_query", "query"]


def test_a_client_without_ro_query_is_unchanged():
    """A test fake or an older library must not start raising AttributeError
    because a call site asked for the read-only command."""
    old = _QueryOnly()
    _run(proj._q(old, "MATCH (n) RETURN count(n)", read_only=True))
    assert old.calls == [("query", "MATCH (n) RETURN count(n)")]


def test_the_timeout_less_fallback_still_covers_the_read_only_call():
    """``_q`` retries without ``timeout`` for clients that do not take it.
    That fallback has to follow whichever command was chosen, not snap back
    to the writing one."""
    plain = _NoTimeoutKwarg()
    _run(proj._q(plain, "MATCH (n) RETURN 1", read_only=True))
    assert plain.calls == [("ro_query", "MATCH (n) RETURN 1")]


def test_reconciles_bounded_query_is_read_only():
    """Every reconcile query goes through this one helper, so it is the only
    place that has to be right."""
    rec_ = _Recorder()
    _run(rec._bounded_query(rec_, "MATCH (n) RETURN count(n) AS c"))
    assert rec_.calls == [("ro_query", "MATCH (n) RETURN count(n) AS c")]


class _EmptyKey(_Recorder):
    """The graph key does not exist. ``GRAPH.RO_QUERY`` raises on that;
    ``GRAPH.QUERY`` instantiates the key and answers from the empty graph."""

    async def ro_query(self, cypher, params=None, timeout=None):
        self.calls.append(("ro_query", cypher))
        raise RuntimeError("Invalid graph operation on empty key")


def test_a_read_of_a_graph_that_does_not_exist_still_answers():
    """A never-projected or just-evicted graph is a real state: reconcile
    reports on one and the projector's own verify counts one. Before this,
    both got zero rows; a bare RO_QUERY would raise instead, and reconcile
    would fail on the graph it exists to describe."""
    key = _EmptyKey()
    res = _run(proj._q(key, "MATCH (n) RETURN count(n) AS c", read_only=True))
    assert [c[0] for c in key.calls] == ["ro_query", "query"]
    # And it is the STATEMENT that is re-sent, not a guessed empty result:
    # an aggregate answers [[0]], which every caller here indexes.
    assert res.result_set[0][0] == 1


def test_only_a_read_forgives_an_empty_key():
    """A write that meets an empty key must still raise — the projector's
    full-seed drop handler keys on exactly that error to tell a fresh graph
    from a wipe that genuinely failed."""
    key = _EmptyKey()

    async def _raise(cypher, params=None, timeout=None):
        key.calls.append(("query", cypher))
        raise RuntimeError("Invalid graph operation on empty key")

    key.query = _raise
    with pytest.raises(RuntimeError):
        _run(proj._q(key, "MERGE (n:X {id: 1})"))
    assert [c[0] for c in key.calls] == ["query"]


def test_any_other_error_from_a_read_is_not_retried():
    """The retry is for one specific, benign state. A refused or broken query
    must not be sent twice."""
    boom = _Recorder()

    async def _raise(cypher, params=None, timeout=None):
        boom.calls.append(("ro_query", cypher))
        raise RuntimeError("NOREPLICAS Not enough good replicas to write.")

    boom.ro_query = _raise
    with pytest.raises(RuntimeError):
        _run(proj._q(boom, "MATCH (n) RETURN 1", read_only=True))
    assert [c[0] for c in boom.calls] == ["ro_query"]


def test_the_pre_drop_probe_stays_write_flagged():
    """``_project_graph_locked`` proves the node will take the DROP and the
    MERGEs that follow before it drops anything — 'dropping against an
    unreachable/misrouted instance would WIPE the read cache with no way to
    repair it'. Only a write-flagged command proves that: under
    ``min-replicas-to-write`` a read is answered while the drop right after
    it is refused. RO_QUERY would also RAISE here, because a fresh graph's
    first seed is precisely when the key does not exist yet."""
    src = inspect.getsource(proj.FalkorProjector._project_graph_locked)
    assert 'await _q(client, "RETURN 1", timeout_ms=_READ_TIMEOUT_MS)' in src
    assert 'read_only=True)' not in src


def test_the_bootstrap_count_stays_write_flagged():
    """Phase 1 counts, and GRAPH.QUERY instantiates the key while doing it —
    which is what leaves the later read-only phases a graph to read."""
    src = inspect.getsource(bw.BootstrapRunner._count)
    assert "read_only=True" not in src


def test_the_resilient_wrapper_falls_back_for_an_old_graph():
    """``ResilientGraph`` defines ``ro_query`` unconditionally, so a caller
    guarding with ``getattr(handle, 'ro_query', None)`` is inspecting the
    WRAPPER, not the graph inside it. Without this the guard passes and the
    call raises AttributeError from a layer that does not treat it as
    retryable."""
    from backend.app.providers.falkordb_connection import ResilientGraph

    class _OldGraph:
        def __init__(self):
            self.calls = []

        async def query(self, cypher, params=None, timeout=None):
            self.calls.append(("query", cypher))
            return _Res()

    inner = _OldGraph()
    handle = ResilientGraph(None, None, "g", inner)
    assert _run(proj._q(handle, "MATCH (n) RETURN 1", read_only=True))
    assert inner.calls == [("query", "MATCH (n) RETURN 1")]


# ── the call sites ───────────────────────────────────────────────────────


def _read_only_cyphers(module) -> list:
    """Every string literal handed to a ``_q(..., read_only=True)`` call in
    this module's source. Cypher built from a constant or an f-string is not
    resolvable here and is covered by the constant check below."""
    tree = ast.parse(inspect.getsource(module))
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "_q"):
            continue
        if not any(k.arg == "read_only" and getattr(k.value, "value", False) is True
                   for k in node.keywords):
            continue
        arg = node.args[1] if len(node.args) > 1 else None
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            out.append(arg.value)
    return out


@pytest.mark.parametrize("module", [proj, bw])
def test_no_read_only_call_site_carries_a_write_clause(module):
    """FalkorDB refuses a RO_QUERY that writes, so a mislabelled call site is
    not a slow path — it is a failed query."""
    literals = _read_only_cyphers(module)
    for cypher in literals:
        upper = cypher.upper()
        for clause in WRITE_CLAUSES:
            assert clause not in upper, (module.__name__, cypher)
    # A resolver that silently matched nothing would pass this for ever.
    assert len(_read_only_cyphers(proj)) >= 2


@pytest.mark.parametrize("name", [
    "_MAX_NODE_ID", "_COUNT_EDGES_IN_WINDOW", "_SCAN_NODES", "_SCAN_EDGES",
    "_SAMPLE_NODES",
])
def test_the_bootstrap_scan_constants_only_read(name):
    """These are the cypher the read-only bootstrap sites actually send —
    ``_BACKFILL_NODES`` next to them carries a SET and is NOT in this list."""
    upper = getattr(bw, name).upper()
    for clause in WRITE_CLAUSES:
        assert clause not in upper, (name, upper)


def test_the_backfill_is_still_a_write():
    """The guard above is only meaningful if it would catch a write — this is
    the neighbour that must keep failing it."""
    assert "SET " in bw._BACKFILL_NODES.upper()


@pytest.mark.parametrize("name", ["_SCAN_NODES", "_SCAN_EDGES"])
def test_the_reconcile_scan_constants_only_read(name):
    upper = getattr(rec, name).upper()
    for clause in WRITE_CLAUSES:
        assert clause not in upper, (name, upper)


def test_the_neighbours_endpoint_reads_read_only():
    """Both statements in ``_falkor_neighbors`` are pure MATCH/RETURN, and it
    is the one FalkorDB read a logged-in user triggers directly."""
    from backend.app.api.v1.endpoints.versioning import _falkor_neighbors

    class _Neighbours(_Recorder):
        async def ro_query(self, cypher, params=None, timeout=None):
            self.calls.append(("ro_query", cypher))

            class _Empty:
                result_set = []

            return _Empty()

    graph = _Neighbours()
    _run(_falkor_neighbors(graph, urn="gv:1", depth=2, direction="out",
                           edge_types=None, limit=50))
    assert graph.calls and all(c[0] == "ro_query" for c in graph.calls)


def test_the_neighbours_endpoint_still_works_without_ro_query():
    from backend.app.api.v1.endpoints.versioning import _falkor_neighbors

    class _Old(_QueryOnly):
        async def query(self, cypher, params=None, timeout=None):
            self.calls.append(("query", cypher))

            class _Empty:
                result_set = []

            return _Empty()

    graph = _Old()
    _run(_falkor_neighbors(graph, urn="gv:1", depth=1, direction="both",
                           edge_types=["OWNS"], limit=10))
    assert graph.calls and all(c[0] == "query" for c in graph.calls)


def test_only_the_helper_talks_to_falkordb_directly():
    """A new module reaching for ``client.query(...)`` itself is how this
    regresses — it would be write-flagged again, and nothing here would say
    so. ``_q`` is the single seam, so that is where the only raw call lives."""
    root = pathlib.Path(inspect.getfile(proj)).parent
    offenders = []
    for path in sorted(root.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for parent in ast.walk(tree):
            if not isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(parent):
                # An attribute LOAD, not just a call: ``_q`` picks the method
                # up by name before calling it, and a module doing the same
                # would slip past a call-only check.
                if isinstance(node, ast.Attribute) and node.attr in ("query", "ro_query"):
                    offenders.append(f"{path.name}:{parent.name}")
    # ``_send`` is ``_q``'s own inner helper — the retry that re-sends an
    # empty-key read as GRAPH.QUERY — so both names are the one seam.
    assert sorted(set(offenders)) == ["projection.py:_q", "projection.py:_send"], \
        sorted(set(offenders))

"""Label-index creation tied to onboarding.

Covers:
- ``AggregationService._ensure_indices_for_skip`` — a skipped aggregation must
  still ensure the per-label indexes (with the assigned ontology's entity type
  ids), otherwise the first read pays the DDL + cold-scan cost.
- ``FalkorDBProvider.ensure_indices`` failure accounting — real failures are
  reported in ONE warning instead of being silently swallowed; "already
  indexed" replies count as success; the method never raises.
"""
import asyncio
import json
import logging

from backend.app.services.aggregation.service import AggregationService


def _run(coro):
    return asyncio.run(coro)


# ── skip → ensure_indices ────────────────────────────────────────────────


class _FakeProvider:
    def __init__(self):
        self.calls = []

    async def ensure_indices(self, entity_type_ids):
        self.calls.append(list(entity_type_ids))


class _FakeRegistry:
    def __init__(self, provider):
        self._provider = provider

    async def get_provider_for_workspace(self, workspace_id, session, data_source_id=None):
        return self._provider


class _Row:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _FakeSession:
    """session.get keyed by ORM class name."""

    def __init__(self, rows):
        self._rows = rows

    async def get(self, orm, key):
        return self._rows.get(orm.__name__)


def test_skip_path_ensures_indices_with_ontology_labels():
    provider = _FakeProvider()
    svc = AggregationService(
        dispatcher=None, registry=_FakeRegistry(provider), session_factory=None,
    )
    session = _FakeSession({
        "WorkspaceDataSourceORM": _Row(id="ds1", ontology_id="bp_1"),
        "OntologyORM": _Row(
            id="bp_1",
            entity_type_definitions=json.dumps({"table": {}, "job": {}}),
        ),
    })
    _run(svc._ensure_indices_for_skip("ds1", "ws1", session))
    assert provider.calls == [["table", "job"]]


def test_skip_path_without_ontology_uses_defaults_only():
    provider = _FakeProvider()
    svc = AggregationService(
        dispatcher=None, registry=_FakeRegistry(provider), session_factory=None,
    )
    session = _FakeSession({
        "WorkspaceDataSourceORM": _Row(id="ds1", ontology_id=None),
    })
    _run(svc._ensure_indices_for_skip("ds1", "ws1", session))
    assert provider.calls == [[]]


def test_skip_path_tolerates_provider_without_ensure_indices():
    class _Bare:
        pass

    svc = AggregationService(
        dispatcher=None, registry=_FakeRegistry(_Bare()), session_factory=None,
    )
    _run(svc._ensure_indices_for_skip("ds1", "ws1", _FakeSession({})))


# ── ensure_indices failure accounting ────────────────────────────────────


class _FailingGraph:
    def __init__(self, error):
        self._error = error
        self.queries = []

    async def query(self, cypher, timeout=None):
        self.queries.append(cypher)
        raise RuntimeError(self._error)


def _bare_provider(graph):
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = object.__new__(FalkorDBProvider)
    p._graph = graph
    return p


def test_ensure_indices_reports_real_failures_once(caplog):
    graph = _FailingGraph("connection reset")
    provider = _bare_provider(graph)
    with caplog.at_level(logging.WARNING, logger="backend.app.providers.falkordb_provider"):
        _run(provider.ensure_indices(["table"]))
    warnings = [r for r in caplog.records if "ensure_indices" in r.getMessage()]
    assert len(warnings) == 1
    assert "failed" in warnings[0].getMessage()
    assert len(graph.queries) > 0  # every statement attempted, none raised out


def test_ensure_indices_treats_already_indexed_as_success(caplog):
    graph = _FailingGraph("Attribute 'urn' is already indexed")
    provider = _bare_provider(graph)
    with caplog.at_level(logging.WARNING, logger="backend.app.providers.falkordb_provider"):
        _run(provider.ensure_indices([]))
    warnings = [r for r in caplog.records if "ensure_indices" in r.getMessage()]
    assert warnings == []

"""A graph we cannot prove is unreferenced is a graph we will not delete.

Cleanup exists because background index DDL used to resurrect any graph an
operator deleted out of band, minting it empty. That is fixed at the source;
these endpoints deal with the phantoms already resident. The costs here are
not symmetric — refusing to drop leaks a graph, dropping wrongly destroys a
customer's data — so every one of these pins a refusal.
"""
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import insights
from backend.app.services import orphan_graphs


class _Graph:
    def __init__(self, rows, *, on_delete=None):
        self._rows = rows
        self._on_delete = on_delete
        self.deleted = False

    async def ro_query(self, _cypher, *a, **kw):
        return SimpleNamespace(result_set=self._rows)

    async def delete(self):
        if self._on_delete is not None:
            self._on_delete(self)
        self.deleted = True


def _wire(monkeypatch, *, keys, non_empty=(), referenced=None, refs_raise=False):
    """Fake the instance and the reference sets. Returns the graph handles so a
    test can assert which of them were dropped."""
    graphs = {
        name: _Graph([[1]] if name in non_empty else [])
        for name in keys
    }

    async def fake_cfg(_provider_id, *_a, **_kw):
        return SimpleNamespace(mode="standalone", host="h", port=6379)

    async def fake_list(_cfg, **_kw):
        return set(keys)

    async def fake_refs(_provider_id):
        if refs_raise:
            raise RuntimeError("graphver engine unreachable")
        return dict(referenced or {})

    async def fake_get_graph(_cfg, name):
        return graphs[name]

    monkeypatch.setattr(
        orphan_graphs, "_referenced_names", fake_refs,
    )
    monkeypatch.setattr(
        "backend.app.providers.falkor_graph_registry.resolve_provider_conn_config",
        fake_cfg,
    )
    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.list_graph_keys_for_config",
        fake_list,
    )
    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.graph_clients",
        lambda: SimpleNamespace(get_graph=fake_get_graph),
    )
    return graphs


def _by_name(candidates):
    return {c.name: c for c in candidates}


# ── the scan ─────────────────────────────────────────────────────────────


async def test_an_empty_unreferenced_graph_is_the_only_deletable_kind(monkeypatch):
    _wire(monkeypatch, keys=["phantom"])
    found = _by_name(await orphan_graphs.scan_orphan_graphs("p1"))
    assert found["phantom"].deletable is True
    assert found["phantom"].empty is True


@pytest.mark.parametrize(
    "why", ["catalog_item", "data_source", "data_source_dedicated", "projection_state"],
)
async def test_a_referenced_graph_is_protected_whatever_names_it(monkeypatch, why):
    _wire(monkeypatch, keys=["mine"], referenced={"mine": [why]})
    found = _by_name(await orphan_graphs.scan_orphan_graphs("p1"))
    assert found["mine"].deletable is False
    assert why in found["mine"].verdict


async def test_a_referenced_graph_is_never_even_probed(monkeypatch):
    """The referenced ones are the big ones, and no probe result could change
    the verdict."""
    graphs = _wire(monkeypatch, keys=["mine"], referenced={"mine": ["data_source"]})
    probed = []
    graphs["mine"].ro_query = lambda *a, **kw: probed.append(1)
    await orphan_graphs.scan_orphan_graphs("p1")
    assert probed == []


async def test_a_dedicated_projection_is_protected_with_its_source(monkeypatch):
    """``{graph}_proj`` is derived — no table names it, so nothing else would."""
    _wire(monkeypatch, keys=["mine_proj"], referenced={"mine": ["data_source"]})
    found = _by_name(await orphan_graphs.scan_orphan_graphs("p1"))
    assert found["mine_proj"].deletable is False
    assert "derived_projection" in found["mine_proj"].verdict


async def test_an_unreferenced_graph_with_data_is_protected(monkeypatch):
    """Unregistered is not the same as disposable."""
    _wire(monkeypatch, keys=["stranger"], non_empty=["stranger"])
    found = _by_name(await orphan_graphs.scan_orphan_graphs("p1"))
    assert found["stranger"].deletable is False
    assert found["stranger"].empty is False


async def test_a_graph_we_could_not_probe_is_protected(monkeypatch):
    graphs = _wire(monkeypatch, keys=["unreadable"])

    async def boom(*_a, **_kw):
        raise RuntimeError("connection reset")

    graphs["unreadable"].ro_query = boom
    found = _by_name(await orphan_graphs.scan_orphan_graphs("p1"))
    assert found["unreadable"].deletable is False
    assert found["unreadable"].empty is None


async def test_the_scan_reports_protected_keys_too(monkeypatch):
    """A list of only the deletable ones asks the operator to trust a filter
    they cannot see."""
    _wire(monkeypatch, keys=["phantom", "mine"], referenced={"mine": ["data_source"]})
    found = await orphan_graphs.scan_orphan_graphs("p1")
    assert sorted(c.name for c in found) == ["mine", "phantom"]


# ── the delete ───────────────────────────────────────────────────────────


async def test_a_dry_run_deletes_nothing(monkeypatch):
    graphs = _wire(monkeypatch, keys=["phantom"])
    results = await orphan_graphs.delete_orphan_graphs(
        "p1", ["phantom"], dry_run=True,
    )
    assert graphs["phantom"].deleted is False
    assert "dry run" in results[0].verdict


async def test_an_explicit_delete_drops_only_what_was_named(monkeypatch):
    graphs = _wire(monkeypatch, keys=["phantom", "other"])
    results = await orphan_graphs.delete_orphan_graphs(
        "p1", ["phantom"], dry_run=False,
    )
    assert graphs["phantom"].deleted is True
    assert graphs["other"].deleted is False
    assert [r.verdict for r in results] == ["dropped"]


async def test_a_name_that_became_referenced_is_refused_at_delete_time(monkeypatch):
    """The preview is not trusted: a graph can be registered between looking
    and deciding."""
    graphs = _wire(monkeypatch, keys=["mine"], referenced={"mine": ["catalog_item"]})
    results = await orphan_graphs.delete_orphan_graphs(
        "p1", ["mine"], dry_run=False,
    )
    assert graphs["mine"].deleted is False
    assert results[0].verdict.startswith("PROTECTED")


async def test_one_refusal_does_not_abort_the_rest(monkeypatch):
    graphs = _wire(
        monkeypatch, keys=["phantom", "mine"], referenced={"mine": ["data_source"]},
    )
    results = await orphan_graphs.delete_orphan_graphs(
        "p1", ["mine", "phantom"], dry_run=False,
    )
    assert graphs["phantom"].deleted is True
    assert [r.name for r in results] == ["mine", "phantom"]


async def test_a_name_that_is_gone_is_skipped_not_invented(monkeypatch):
    _wire(monkeypatch, keys=["phantom"])
    results = await orphan_graphs.delete_orphan_graphs(
        "p1", ["vanished"], dry_run=False,
    )
    assert results[0].verdict.startswith("skipped")


# ── the endpoints ────────────────────────────────────────────────────────


class _Session:
    async def execute(self, _stmt):
        return SimpleNamespace(scalar_one_or_none=lambda: "p1")


async def test_an_unreadable_reference_set_refuses_to_report_orphans(monkeypatch):
    """Degrading to "we saw no references" is how a bug erases a customer's
    graphs. It must fail loud instead."""
    _wire(monkeypatch, keys=["phantom"], refs_raise=True)
    with pytest.raises(Exception) as exc:
        await insights.list_orphan_graphs(provider_id="p1", session=_Session())
    assert getattr(exc.value, "status_code", None) == 503


async def test_an_unreadable_reference_set_refuses_to_delete(monkeypatch):
    _wire(monkeypatch, keys=["phantom"], refs_raise=True)
    body = insights.OrphanCleanupRequest(names=["phantom"], dry_run=False)
    with pytest.raises(Exception) as exc:
        await insights.cleanup_orphan_graphs(
            provider_id="p1", body=body, session=_Session(),
        )
    assert getattr(exc.value, "status_code", None) == 503


def test_cleanup_requires_explicit_names():
    """There is no "delete everything you found" form, and dry-run is the
    default — the destructive call is the one you ask for twice."""
    with pytest.raises(Exception):
        insights.OrphanCleanupRequest(names=[])
    assert insights.OrphanCleanupRequest(names=["x"]).dry_run is True

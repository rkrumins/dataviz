"""Tests for `_view_export_scope` — the export-scope reader, now backed
entirely by the view's stored ``config`` (canonical reference-layout
``assignments`` map via ``parse_reference_layout``), with the
``context_models`` lookup dropped (Task 2, phase 2 of the view-config
consolidation).

It fails closed: a view that places nothing reports ``holds_nothing``, and
its export is refused — planned, streamed, started or run by the worker —
whatever kind of view it is; a view that can't be read fails the export.
Neither is ever widened to the whole data source. An empty ``keep`` exports
nothing at all.

A view package's data takes its scope from the version it packages
(``export_scope_of`` over the sealed definition), never the view as it is
now, and fails closed: a version that places nothing is refused rather than
exported as the whole data source.
"""
from __future__ import annotations

import contextlib
import inspect
import json
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.versioning import _view_export_scope
from backend.app.db.models import ViewORM, WorkspaceORM


async def _seed_workspace(session: AsyncSession, name: str = "WS") -> WorkspaceORM:
    ws = WorkspaceORM(name=name)
    session.add(ws)
    await session.flush()
    return ws


async def _seed_view(
    session: AsyncSession, workspace: WorkspaceORM, *, config: dict | None = None,
) -> ViewORM:
    view = ViewORM(
        name="Test View",
        workspace_id=workspace.id,
        view_type="reference",
        config=json.dumps(config if config is not None else {}),
    )
    session.add(view)
    await session.flush()
    return view


@pytest.fixture(autouse=True)
def _route_worker_session_to_test_db(monkeypatch, db_session: AsyncSession):
    """`_view_export_scope` runs in the import/export worker's
    background context and opens its own session via
    `backend.app.db.engine.get_async_session`. Route that to this test's
    in-memory ``db_session`` so the resolver reads what each test seeds
    (no fixture ever seeds a ``context_models`` row — proving the resolver
    doesn't need one)."""
    @contextlib.asynccontextmanager
    async def _fake_get_async_session():
        yield db_session

    monkeypatch.setattr(
        "backend.app.db.engine.get_async_session", _fake_get_async_session,
    )


class TestResolveExportViewScope:
    def test_no_context_models_dependency(self):
        """Structural guard: the resolver must not reference ContextModelORM
        or context_model at all — the context_models table is no longer
        consulted for export scope."""
        source = inspect.getsource(_view_export_scope)
        assert "ContextModelORM" not in source
        assert "context_model" not in source

    async def test_canonical_assignments_map(self, db_session: AsyncSession):
        ws = await _seed_workspace(db_session)
        view = await _seed_view(db_session, ws, config={
            "layout": {
                "referenceLayout": {
                    "layers": [{"id": "source"}],
                    "assignments": {
                        "urn:a": {"layerId": "source", "inheritsChildren": True},
                        "urn:b": {"layerId": "source", "inheritsChildren": False},
                    },
                },
            },
        })

        scope = await _view_export_scope(ws.id, None, view.id)

        assert scope is not None
        assert sorted(scope["assigned_urns"]) == ["urn:a", "urn:b"]
        assert scope["inherit_urns"] == ["urn:a"]
        assert scope["containment_types"] == []

    async def test_legacy_entity_assignments_shape(self, db_session: AsyncSession):
        """Legacy per-layer entityAssignments (pre-canonicalization views)
        still resolve correctly — up-converted by parse_reference_layout."""
        ws = await _seed_workspace(db_session)
        view = await _seed_view(db_session, ws, config={
            "referenceLayout": {
                "layers": [
                    {"id": "source", "entityAssignments": [
                        {"urn": "urn:legacy-a"},
                        {"urn": "urn:legacy-b", "inheritsChildren": False},
                    ]},
                ],
            },
        })

        scope = await _view_export_scope(ws.id, None, view.id)

        assert scope is not None
        assert sorted(scope["assigned_urns"]) == ["urn:legacy-a", "urn:legacy-b"]
        assert scope["inherit_urns"] == ["urn:legacy-a"]

    async def test_a_view_that_places_nothing_holds_nothing(self, db_session: AsyncSession):
        """Fails closed: a view with no explicit assignments reports that it
        holds nothing — never a scope of the whole data source."""
        ws = await _seed_workspace(db_session)
        view = await _seed_view(db_session, ws, config={"referenceLayout": {"layers": []}})

        scope = await _view_export_scope(ws.id, None, view.id)
        assert scope == {"holds_nothing": True}

    async def test_a_list_view_with_no_members_yet_holds_nothing(self, db_session: AsyncSession):
        ws = await _seed_workspace(db_session)
        view = await _seed_view(db_session, ws, config={
            "membership": {"v": 1, "mode": "live"},
            "layout": {"referenceLayout": {"layers": [{"id": "source"}], "assignments": {}}}})

        assert await _view_export_scope(ws.id, None, view.id) == {"holds_nothing": True}

    async def test_missing_view_returns_none(self, db_session: AsyncSession):
        ws = await _seed_workspace(db_session)

        scope = await _view_export_scope(ws.id, None, "does-not-exist")
        assert scope is None

    async def test_branch_effective_scope_uses_overlay(self, db_session: AsyncSession):
        """A draft export (branch_id) scopes to the draft's OWN assignments
        (base ⊕ overlay); no branch / no overlay falls back to the base."""
        from backend.app.db.models import ViewLayoutOverlayORM

        ws = await _seed_workspace(db_session)
        view = await _seed_view(db_session, ws, config={
            "layout": {
                "referenceLayout": {
                    "layers": [{"id": "source"}],
                    "assignments": {
                        "urn:base": {"layerId": "source", "inheritsChildren": True},
                    },
                },
            },
        })
        db_session.add(ViewLayoutOverlayORM(
            view_id=view.id, branch_id="br_draft",
            reference_layout=json.dumps({
                "layers": [{"id": "source"}],
                "assignments": {
                    "urn:draft": {"layerId": "source", "inheritsChildren": True},
                },
            }),
            entity_scope=None,
            fork_base_layout=json.dumps({}), fork_base_entity_scope=None,
        ))
        await db_session.flush()

        base = await _view_export_scope(ws.id, None, view.id)
        draft = await _view_export_scope(ws.id, None, view.id, "br_draft")
        other = await _view_export_scope(ws.id, None, view.id, "br_none")

        assert base["assigned_urns"] == ["urn:base"]
        assert draft["assigned_urns"] == ["urn:draft"]     # overlay wins
        assert other["assigned_urns"] == ["urn:base"]      # no overlay → base

    async def test_malformed_config_fails_closed(self, db_session: AsyncSession):
        """A view row whose config isn't valid JSON raises: the export it
        scopes fails, never widened to the whole data source."""
        ws = await _seed_workspace(db_session)
        view = ViewORM(
            name="Bad Config View", workspace_id=ws.id, view_type="reference",
            config="not json",
        )
        db_session.add(view)
        await db_session.flush()

        with pytest.raises(ValueError):
            await _view_export_scope(ws.id, None, view.id)

    def test_the_worker_resolves_the_scope_failing_closed(self):
        from backend.app.api.v1.endpoints import versioning

        assert versioning.get_import_export_service()._scope_resolver is _view_export_scope


# ── An export of a view that holds nothing is refused, never the whole data source ──


def _snap(nodes=(), edges=()):
    """A snapshot faked at its read boundary (as in test_export_plan_budget.py)."""
    from backend.app.services.versioning.import_export.snapshot import Winner

    by = {"node": {eid: Winner(eid, True, f"v_{eid}", "g1", f"h_{eid}", urn=f"urn:{eid}",
                               entity_type="Table", payload=json.dumps({"entityType": "Table"}))
                   for eid in nodes},
          "edge": {eid: Winner(eid, True, f"v_{eid}", "g1", f"h_{eid}", source_id=s, target_id=t,
                               edge_type="LINEAGE", payload=json.dumps({"edgeType": "LINEAGE"}))
                   for eid, s, t in edges}}

    class _Snap:
        page_size = 2
        as_of_seq, branch_id = 7, None

        async def head_counts(self):
            return {"node": len(by["node"]), "edge": len(by["edge"])}

        async def iter_live(self, kind, payload=False, limit=None):
            rows = sorted(by[kind].values(), key=lambda w: w.entity_id)
            for i in range(0, len(rows), self.page_size):
                yield rows[i:i + self.page_size]

        async def lookup_live(self, kind, entity_ids, payload=False):
            return {eid: by[kind][eid] for eid in entity_ids if eid in by[kind]}

        async def nodes_by_urn(self, urns):
            return {w.urn: w.entity_id for w in by["node"].values() if w.urn in set(urns)}

        async def containment_descendants(self, roots, containment_types):
            return set()

    return _Snap()


async def test_an_empty_keep_exports_nothing_not_everything():
    from backend.app.services.versioning.import_export import stream

    snap = _snap(["a", "b", "c"], [("ab", "a", "b")])
    nothing = stream.Selection.of(keep=set())
    assert [r async for page in stream.record_pages(snap, nothing) for r in page] == []
    assert [b async for b in stream.native_pages(snap, nothing)] == []
    assert await stream.count(snap, nothing) == {"nodes": 0, "edges": 0, "exact": True}
    # Without a view, everything — the difference ``None`` makes.
    assert await stream.count(snap, stream.Selection.of()) == {"nodes": 3, "edges": 1, "exact": True}


class TestARouteRefusesAViewThatHoldsNothing:
    """Plan, stream and start answer 422 ``view_holds_nothing`` for an
    ordinary view that places nothing and a list view with no members alike."""

    @pytest.fixture(params=["placed_nothing", "list_view_no_members"])
    async def view(self, request, monkeypatch, db_session):
        from backend.app.api.v1.endpoints import versioning
        from backend.app.services.versioning.import_export import snapshot as snapshot_module

        async def _allowed(*args, **kwargs):
            return None

        async def _open(**kwargs):
            raise AssertionError("refused before anything is read")

        monkeypatch.setattr(versioning, "_check_export_access", _allowed)
        monkeypatch.setattr(snapshot_module, "open_snapshot", _open)
        ws = await _seed_workspace(db_session)
        config = {"layout": {"referenceLayout": {"layers": [{"id": "source"}], "assignments": {}}}}
        if request.param == "list_view_no_members":
            config["membership"] = {"v": 1, "mode": "live"}
        return ws, await _seed_view(db_session, ws, config=config)

    @staticmethod
    def _refused(exc_info):
        from backend.app.services.versioning.import_export.service import VIEW_HOLDS_NOTHING

        assert exc_info.value.status_code == 422
        assert exc_info.value.detail == {"reason": "view_holds_nothing", "message": VIEW_HOLDS_NOTHING}
        assert "Export the whole data source instead" in VIEW_HOLDS_NOTHING

    async def _call(self, route, ws, view, **extra):
        return await route(ws_id=ws.id, graph_id="g1", format="ndjson", as_of_seq=None, view_id=view.id,
                           branch_id=None, ids=None, types=None, user=None, claims=None, viewer=None,
                           meta={"data_source_id": None}, session=None, svc=None, **extra)

    async def test_the_plan(self, view):
        from fastapi import HTTPException

        from backend.app.api.v1.endpoints import versioning

        with pytest.raises(HTTPException) as exc_info:
            await self._call(versioning.plan_export, *view)
        self._refused(exc_info)

    async def test_the_stream(self, view):
        from fastapi import HTTPException

        from backend.app.api.v1.endpoints import versioning

        with pytest.raises(HTTPException) as exc_info:
            await self._call(versioning.stream_export, *view, props=None, filename=None)
        self._refused(exc_info)

    async def test_the_start(self, view):
        from fastapi import HTTPException

        from backend.app.api.v1.endpoints import versioning

        class _IE:
            async def find_job(self, **kwargs):
                return None

            async def create_export_job(self, **kwargs):
                raise AssertionError("no job is made for a view that holds nothing")

        with pytest.raises(HTTPException) as exc_info:
            await self._call(versioning.create_export, *view, props=None, idempotency_key=None,
                             filename=None, ie=_IE())
        self._refused(exc_info)


class TestTheWorkerFailsClosed:
    """A job queued before its view emptied (or whose view went, or can't be
    read) fails — it never exports the whole data source in the view's name."""

    @pytest.fixture
    def run(self, monkeypatch):
        from backend.app.services.versioning import db as ver_db
        from backend.app.services.versioning.import_export import service as service_mod

        row = SimpleNamespace(workspace_id="ws", data_source_id="ds", scope_view_id="v1",
                              branch_id=None, field_scope={})

        @contextlib.asynccontextmanager
        async def session():
            class _S:
                async def get(self, _orm, _key):
                    return row
            yield _S()

        exported = []

        class _Worker:
            def __init__(self, _svc, _store, scope=None, options=None, package=None):
                exported.append(scope)

            async def run(self, _job_id, lease=None):
                return {"nodes": 0}

        monkeypatch.setattr(ver_db, "graphver_session", session)
        monkeypatch.setattr(service_mod, "ExportWorker", _Worker)

        async def _run(resolver):
            svc = service_mod.ImportExportService(versioning=object(), store=object(), scope_resolver=resolver)
            return await svc.run_export("xjob_1", lease=object())
        return _run, exported

    async def test_a_view_that_holds_nothing_fails_the_job(self, run):
        from backend.app.services.versioning.import_export.service import VIEW_HOLDS_NOTHING

        _run, exported = run

        async def resolver(*_args):
            return {"holds_nothing": True}

        with pytest.raises(ValueError) as exc_info:
            await _run(resolver)
        assert str(exc_info.value) == VIEW_HOLDS_NOTHING and exported == []

    async def test_a_view_gone_fails_the_job(self, run):
        _run, exported = run

        async def resolver(*_args):
            return None

        with pytest.raises(LookupError, match="nothing was exported"):
            await _run(resolver)
        assert exported == []

    async def test_a_scope_that_cannot_be_read_fails_the_job(self, run):
        _run, exported = run

        async def resolver(*_args):
            raise RuntimeError("management DB down")

        with pytest.raises(RuntimeError, match="management DB down"):
            await _run(resolver)
        assert exported == []

    async def test_a_view_that_places_something_exports_its_scope(self, run):
        _run, exported = run
        scope = {"assigned_urns": ["urn:a"], "inherit_urns": [], "containment_types": []}

        async def resolver(*_args):
            return scope

        assert await _run(resolver) == {"nodes": 0}
        assert exported == [scope]


# ── A view package's data: scoped by the version it holds, failing closed ──────


_PLACED = {"layout": {"referenceLayout": {
    "layers": [{"id": "source"}],
    "assignments": {"urn:sealed": {"layerId": "source", "inheritsChildren": True},
                    "urn:pseudo": {"logicalNodeId": "ln1"}},
}}}


def test_the_scope_of_a_design_is_its_placements():
    from backend.app.api.v1.endpoints.versioning import export_scope_of

    assert export_scope_of(_PLACED, ["CONTAINS"]) == {
        "assigned_urns": ["urn:sealed"], "inherit_urns": ["urn:sealed", "urn:pseudo"],
        "containment_types": ["CONTAINS"]}
    assert export_scope_of({"layout": {"referenceLayout": {"layers": []}}}, []) is None


class TestPackageScope:
    async def _build(self, monkeypatch, db_session, sealed_definition, current_config):
        from types import SimpleNamespace

        from backend.app.services.view_transfer import export, package

        ws = await _seed_workspace(db_session)
        view = await _seed_view(db_session, ws, config=current_config)
        asked = []

        async def export_views(session, requests, *, actor=None, message=None):
            asked.append([(row.id, number, may_seal) for row, number, may_seal in requests])
            return {"bundleHash": "sha256:b"}, [SimpleNamespace(definition=sealed_definition)]

        async def containment(_session, _ws, _ds):
            return ["CONTAINS"]

        monkeypatch.setattr(export, "export_views", export_views)
        monkeypatch.setattr("backend.app.api.v1.endpoints.versioning._live_containment_types", containment)
        options = {"scope": "view", "views": [{"viewId": view.id, "version": 4}], "actor": "usr_1"}
        bundle, scope = await package.build_bundle(db_session, options, ws.id, "ds1")
        assert asked == [[(view.id, 4, False)]], "the version sealed for it, never sealed again"
        return scope

    async def test_the_data_follows_the_sealed_version_not_the_view_now(self, monkeypatch, db_session):
        scope = await self._build(monkeypatch, db_session, _PLACED, current_config={"layout": {
            "referenceLayout": {"layers": [{"id": "source"}],
                                "assignments": {"urn:moved-on": {"layerId": "source"}}}}})
        assert scope["assigned_urns"] == ["urn:sealed"] and scope["containment_types"] == ["CONTAINS"]

    async def _build_with_members(self, monkeypatch, db_session, sealed, current, members):
        """``_build``, the view's members in its member table (its versions never hold them)."""
        from backend.app.db.repositories import view_members_repo, view_membership_repo

        original = _seed_view

        async def seeded(session, workspace, *, config=None):
            view = await original(session, workspace, config=config)
            state = await view_membership_repo.ensure(session, view)
            state.epoch = state.members_epoch = 3
            await view_members_repo.insert(session, [
                {"view_id": view.id, "epoch": 3, "urn": urn, "layer_id": "source", "sort_key": urn, "ord": i,
                 "label": "", "label_ord": i, "whole": whole, "covered": False}
                for i, (urn, whole) in enumerate(sorted(members.items()))])
            await view_members_repo.insert(session, [   # an answer since replaced: not the view's
                {"view_id": view.id, "epoch": 2, "urn": "urn:old", "layer_id": "source", "sort_key": "o",
                 "ord": 0, "label": "", "label_ord": 0, "whole": False, "covered": False}])
            return view

        monkeypatch.setitem(globals(), "_seed_view", seeded)
        return await self._build(monkeypatch, db_session, sealed, current_config=current)

    async def test_an_auto_updating_view_packages_the_members_it_holds_now(self, monkeypatch, db_session):
        # Its versions hold its design, not its members (those follow its query, in a table of
        # their own), so its package's data is the members it holds now, beside what the version
        # itself places.
        live = {"membership": {"v": 1, "mode": "live"}}
        always = {"urn:always": {"layerId": "source", "inheritsChildren": False}}
        sealed = {**live, "layout": {"referenceLayout": {"layers": [{"id": "source"}], "assignments": always}}}
        scope = await self._build_with_members(monkeypatch, db_session, sealed, sealed,
                                               {"urn:member": False, "urn:whole": True})
        assert sorted(scope["assigned_urns"]) == ["urn:always", "urn:member", "urn:whole"]
        assert scope["inherit_urns"] == ["urn:whole"]

    async def test_an_auto_updating_view_with_only_members_is_not_refused(self, monkeypatch, db_session):
        live = {"membership": {"v": 1, "mode": "live"}}
        sealed = {**live, "layout": {"referenceLayout": {"layers": [{"id": "source"}], "assignments": {}}}}
        scope = await self._build_with_members(monkeypatch, db_session, sealed, sealed, {"urn:member": False})
        assert scope["assigned_urns"] == ["urn:member"]

    async def test_a_snapshot_packages_the_members_it_holds(self, monkeypatch, db_session):
        # A snapshot's members are data too: frozen in its member table, never in its versions.
        snapshot = {"membership": {"v": 1, "mode": "snapshot"}}
        sealed = {**snapshot, "layout": {"referenceLayout": {"layers": [{"id": "source"}], "assignments": {}}}}
        scope = await self._build_with_members(monkeypatch, db_session, sealed, sealed, {"urn:frozen": False})
        assert scope["assigned_urns"] == ["urn:frozen"]

    async def test_a_version_that_places_nothing_fails_closed(self, monkeypatch, db_session):
        from backend.app.services.view_transfer.package import NO_PLACEMENTS

        with pytest.raises(ValueError, match="Package the whole data source"):
            await self._build(monkeypatch, db_session, {"layout": {"referenceLayout": {"layers": []}}},
                              current_config=_PLACED)
        assert "no entities" in NO_PLACEMENTS

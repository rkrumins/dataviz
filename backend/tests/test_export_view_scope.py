"""Tests for `_resolve_export_view_scope` — the export-scope reader, now backed
entirely by the view's stored ``config`` (canonical reference-layout
``assignments`` map via ``parse_reference_layout``), with the
``context_models`` lookup dropped (Task 2, phase 2 of the view-config
consolidation).

A view package's data takes its scope from the version it packages
(``export_scope_of`` over the sealed definition), never the view as it is
now, and fails closed: a version that places nothing is refused rather than
exported as the whole data source.
"""
from __future__ import annotations

import contextlib
import inspect
import json

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.versioning import _resolve_export_view_scope
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
    """`_resolve_export_view_scope` runs in the import/export worker's
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
        source = inspect.getsource(_resolve_export_view_scope)
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

        scope = await _resolve_export_view_scope(ws.id, None, view.id)

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

        scope = await _resolve_export_view_scope(ws.id, None, view.id)

        assert scope is not None
        assert sorted(scope["assigned_urns"]) == ["urn:legacy-a", "urn:legacy-b"]
        assert scope["inherit_urns"] == ["urn:legacy-a"]

    async def test_no_assignments_returns_none(self, db_session: AsyncSession):
        """Fail-open: a view with no explicit assignments exports the whole
        data source."""
        ws = await _seed_workspace(db_session)
        view = await _seed_view(db_session, ws, config={"referenceLayout": {"layers": []}})

        scope = await _resolve_export_view_scope(ws.id, None, view.id)
        assert scope is None

    async def test_missing_view_returns_none(self, db_session: AsyncSession):
        ws = await _seed_workspace(db_session)

        scope = await _resolve_export_view_scope(ws.id, None, "does-not-exist")
        assert scope is None

    async def test_missing_workspace_or_view_id_short_circuits(self):
        assert await _resolve_export_view_scope(None, None, "v1") is None
        assert await _resolve_export_view_scope("ws1", None, None) is None

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

        base = await _resolve_export_view_scope(ws.id, None, view.id)
        draft = await _resolve_export_view_scope(ws.id, None, view.id, "br_draft")
        other = await _resolve_export_view_scope(ws.id, None, view.id, "br_none")

        assert base["assigned_urns"] == ["urn:base"]
        assert draft["assigned_urns"] == ["urn:draft"]     # overlay wins
        assert other["assigned_urns"] == ["urn:base"]      # no overlay → base

    async def test_malformed_config_fails_open(self, db_session: AsyncSession):
        """A view row whose config isn't valid JSON must not raise — it
        fails open to `None` (whole-DS export), matching the resolver's
        broad try/except contract."""
        ws = await _seed_workspace(db_session)
        view = ViewORM(
            name="Bad Config View", workspace_id=ws.id, view_type="reference",
            config="not json",
        )
        db_session.add(view)
        await db_session.flush()

        scope = await _resolve_export_view_scope(ws.id, None, view.id)
        assert scope is None


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

    async def test_a_version_that_places_nothing_fails_closed(self, monkeypatch, db_session):
        from backend.app.services.view_transfer.package import NO_PLACEMENTS

        with pytest.raises(ValueError, match="Package the whole data source"):
            await self._build(monkeypatch, db_session, {"layout": {"referenceLayout": {"layers": []}}},
                              current_config=_PLACED)
        assert "no entities" in NO_PLACEMENTS

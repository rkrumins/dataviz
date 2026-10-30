"""A fork's data source, without a database server: the schema and what a fork's row takes from
its parent.

A fork of a versioned graph is a row in ``workspace_data_sources`` of its own, keyed by the fork
graph's ``dsfork_…`` id. It names the data source it was forked from, never a FalkorDB graph
(``ck_ds_fork_no_key``), and takes its parent's governing settings. The fork route, the reads and
the lifecycle run against Postgres in ``tests/integration/test_fork_data_sources.py``.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services import fork_sources

_REVISION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261030_1200_ds_fork_of.py"


def _migration():
    spec = importlib.util.spec_from_file_location(_REVISION.stem, _REVISION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_fork_column_is_declared_and_migrated():
    table = WorkspaceDataSourceORM.__table__
    column = table.c.fork_of_data_source_id
    (fk,) = column.foreign_keys
    assert column.nullable and fk.target_fullname == "workspace_data_sources.id"
    assert fk.ondelete == "RESTRICT"
    assert any(i.name == "idx_ds_fork_of" and [c.name for c in i.columns] == ["fork_of_data_source_id"]
               for i in table.indexes)
    check = next(c for c in table.constraints if getattr(c, "name", "") == "ck_ds_fork_no_key")
    assert str(check.sqltext) == "fork_of_data_source_id IS NULL OR graph_name IS NULL"
    migration = _migration()
    assert migration.revision == _REVISION.stem and len(migration.revision) <= 32
    assert migration.down_revision == "20261030_1100_gv_fork_bases"


def test_a_fork_row_takes_its_parents_governing_settings():
    parent = SimpleNamespace(
        id="ds_parent", workspace_id="ws_1", provider_id="prov_1", label=None, graph_name="sales",
        ontology_id="ont_1", is_restricted=True, access_level="admin", identity_property="id",
        name_property="title", draft_default_visibility="private", draft_levels="any",
        review_self_approval=False, review_self_merge=True)
    row = fork_sources.fork_row(parent, ds_id="dsfork_abc", name="Plan", parent_graph_id="g_1",
                                actor="u_1")
    assert (row.id, row.workspace_id, row.provider_id) == ("dsfork_abc", "ws_1", "prov_1")
    assert row.label == "sales · Plan" and row.graph_name is None and not row.is_primary
    assert row.fork_of_data_source_id == "ds_parent" and row.source_mode == "managed"
    assert json.loads(row.extra_config)["origin"] == {
        "kind": "fork", "parentDataSourceId": "ds_parent", "parentGraphId": "g_1"}
    assert {c: getattr(row, c) for c in fork_sources.GOVERNING} == {
        c: getattr(parent, c) for c in fork_sources.GOVERNING}


# ── governing settings follow the parent ─────────────────────────────────────────────────────
import time  # noqa: E402

import pytest  # noqa: E402

from backend.app.db.models import (  # noqa: E402
    OntologyORM, ProviderORM, ViewORM, WorkspaceORM)
from backend.app.services.feature_flags import feature_flags  # noqa: E402
from backend.app.services.permission_service import PermissionClaims  # noqa: E402
from backend.tests.test_views_scoping_regressions import _auth, _user  # noqa: E402

WS = "ws_f"
_DS = f"/api/v1/admin/workspaces/{WS}/data-sources"
_POLICY = f"/api/v1/{WS}/versioning/data-sources"


@pytest.fixture
def versioning_on():
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    yield
    feature_flags.invalidate()


@pytest.fixture
async def forks(db_session):
    """``ds_parent`` in ``ws_f``, its fork ``dsfork_a``, and ``dsfork_b``, a fork of that."""
    db_session.add_all([
        WorkspaceORM(id=WS, name="Forks", publish_policy="open"),
        ProviderORM(id="prov_f", name="Prod", provider_type="falkordb"),
        OntologyORM(id="ont_1", name="One"), OntologyORM(id="ont_2", name="Two"),
    ])
    await db_session.flush()
    parent = WorkspaceDataSourceORM(id="ds_parent", workspace_id=WS, provider_id="prov_f",
                                    graph_name="sales", label="Sales", ontology_id="ont_1")
    db_session.add(parent)
    await db_session.flush()
    a = fork_sources.fork_row(parent, ds_id="dsfork_a", name="A", parent_graph_id="g_p", actor="u")
    db_session.add(a)
    await db_session.flush()
    db_session.add(fork_sources.fork_row(a, ds_id="dsfork_b", name="B", parent_graph_id="g_a",
                                         actor="u"))
    await db_session.commit()


async def _rows(db_session, *ids):
    out = []
    for ds_id in ids:
        row = await db_session.get(WorkspaceDataSourceORM, ds_id)
        await db_session.refresh(row)
        out.append(row)
    return out


async def test_a_parents_settings_reach_its_forks_and_theirs(test_client, db_session, forks,
                                                             versioning_on):
    r = await test_client.put(f"{_DS}/ds_parent", json={
        "ontologyId": "ont_2", "isRestricted": True, "identityProperty": "key",
        "nameProperty": "title", "label": "Revenue"})
    assert r.status_code == 200, r.text
    r = await test_client.put(f"{_POLICY}/ds_parent/drafts-policy", json={
        "defaultVisibility": "private", "levels": "private_only", "selfApproval": False,
        "selfMerge": False})
    assert r.status_code == 200, r.text
    parent, a, b = await _rows(db_session, "ds_parent", "dsfork_a", "dsfork_b")
    for fork in (a, b):
        assert {c: getattr(fork, c) for c in fork_sources.GOVERNING} == {
            c: getattr(parent, c) for c in fork_sources.GOVERNING}
        assert fork.ontology_id == "ont_2" and fork.draft_levels == "private_only"
    assert (a.label, b.label) == ("Sales · A", "Sales · A · B")       # a label is a row's own


@pytest.mark.parametrize("field, value", [
    ("ontologyId", "ont_2"), ("isRestricted", True), ("identityProperty", "key"),
    ("nameProperty", "title")])
async def test_a_forks_governing_settings_are_its_parents(test_client, db_session, forks, field,
                                                          value):
    r = await test_client.put(f"{_DS}/dsfork_b", json={field: value, "label": "Mine"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["type"] == "fork_settings_follow_parent"
    (b,) = await _rows(db_session, "dsfork_b")
    assert b.label == "Sales · A · B" and b.ontology_id == "ont_1"      # nothing was written


async def test_a_fork_keeps_its_own_label_and_drafts_policy_follows_too(test_client, db_session,
                                                                      forks, versioning_on):
    # The edit form sends the ontology the source already has: not a change.
    r = await test_client.put(f"{_DS}/dsfork_a", json={"label": "Q3 plan", "ontologyId": "ont_1"})
    assert r.status_code == 200, r.text
    assert r.json()["label"] == "Q3 plan"
    r = await test_client.put(f"{_POLICY}/dsfork_a/drafts-policy", json={"selfMerge": False})
    assert r.status_code == 409 and r.json()["detail"]["type"] == "fork_settings_follow_parent"
    r = await test_client.put(f"{_POLICY}/dsfork_a/drafts-policy", json={"levels": "inherit"})
    assert r.status_code == 200, r.text                                  # already inherited
    (a,) = await _rows(db_session, "dsfork_a")
    assert a.review_self_merge is None


_CREATOR = _user("usr_fork_creator")
_PUBLISHER = _user("usr_fork_publisher")
_MEMBER = ("workspace:view:create", "workspace:view:edit", "workspace:view:delete",
           "workspace:view:read")


async def test_a_view_on_a_fork_of_a_restricted_source_publishes_as_on_its_parent(
        test_client, db_session, forks):
    """The parent is restricted; the fork's own row says otherwise (a copy that has not caught
    up): the parent decides. Someone holding the publish permission publishes a view on the fork;
    someone without it is held back by the source, as on the parent."""
    parent, b = await _rows(db_session, "ds_parent", "dsfork_b")
    parent.is_restricted, b.is_restricted = True, False
    for vid, creator in (("view_f_member", _CREATOR.id), ("view_f_publisher", _PUBLISHER.id)):
        db_session.add(ViewORM(id=vid, name=vid, workspace_id=WS, data_source_id="dsfork_b",
                               visibility="workspace", created_by=creator))
    await db_session.commit()
    member = PermissionClaims(sid="s_m", ws_perms={WS: _MEMBER})
    publisher = PermissionClaims(sid="s_p", ws_perms={WS: (*_MEMBER, "workspace:view:publish")})
    with _auth(user=_CREATOR, claims=member):
        r = await test_client.put("/api/v1/views/view_f_member/visibility",
                                  json={"visibility": "enterprise"})
    assert r.status_code == 403 and "workspace:view:publish" in r.text, r.text
    with _auth(user=_PUBLISHER, claims=publisher):
        r = await test_client.put("/api/v1/views/view_f_publisher/visibility",
                                  json={"visibility": "enterprise"})
    assert r.status_code == 200, r.text

"""A semantic layer has an owner now: the org (as every layer was) or a workspace — a Playground
maker's own layer, or one that moved into a workspace with its graph.

* **The owner rule.** A Playground maker edits, publishes, deletes, imports into, exports and reads
  the history of their own layer whatever the semantic-layer switches say. Another member, someone
  who manages layers elsewhere, and an API key are refused (403 ``layer_not_yours``, or 404 for a
  layer they can't see); a Playground admin may, a platform admin is held to the org's rules.
* **Org layers keep today's rules**: ``workspace:ontology:manage`` and the switches.
* **Who sees what.** A member sees approved org-wide layers, their own (drafts too), those shared
  with the Playground and the starters — never another member's private layer, an org draft, a
  workspace's own layer or the system's.
* **What each may do** is on each layer (``access``), from the same rules.
* **Who did what** is recorded: ``created_by``, ``updated_by``, ``published_by``, ``deleted_by``.
* **Approving** a workspace's published layer makes it an org layer, for the org's editors only.
* The migration adds the two columns and the index, and takes them away again.
"""
from __future__ import annotations

import contextlib
import importlib.util
import json
import time
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import OntologyORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services import playground_layers
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import KeyScope, PermissionClaims
from backend.auth_service.interface import User

PG, TEAM, LAB = "ws_play", "ws_team", "ws_lab"
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)
EDITOR_PERMS = MEMBER_PERMS + ("workspace:ontology:manage",)
ADMIN_PERMS = EDITOR_PERMS + ("workspace:admin", "workspace:datasource:publish")


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name=uid[4:].title(), last_name="T", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


ADA, BEN, CY = _user("usr_ada"), _user("usr_ben"), _user("usr_cy")
#: A Playground member, publishing nowhere and managing no semantic layer.
MEMBER = PermissionClaims(sid="s_m", ws_perms={PG: MEMBER_PERMS})
#: A Playground member who also manages semantic layers in Team, and administers the Lab.
TEAM_EDITOR = PermissionClaims(sid="s_t", ws_perms={PG: MEMBER_PERMS, TEAM: EDITOR_PERMS, LAB: ADMIN_PERMS})
PG_ADMIN = PermissionClaims(sid="s_a", ws_perms={PG: MEMBER_PERMS + ("workspace:admin",)})
PLATFORM_ADMIN = PermissionClaims(sid="s_p", global_perms=("system:admin",))
KEY = PermissionClaims(sid="s_k", ws_perms={PG: MEMBER_PERMS}, key_scope=KeyScope(key_id="key_1"))

ONT = "/api/v1/admin/ontologies"
LAYERS = "/api/v1/playground/layers"
#: A layer's body as the editor saves it: one entity type.
TYPES = {"entityTypeDefinitions": {"table": {"name": "Table", "plural_name": "Tables"}},
         "relationshipTypeDefinitions": {}}


@contextlib.contextmanager
def acting(user: User, claims: PermissionClaims):
    from backend.app.main import app

    async def _u():
        return user

    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _u
    app.dependency_overrides[get_optional_user] = _u
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v


def set_flags(**values) -> None:
    feature_flags._cache = dict(feature_flags._cache or {}, **values)
    feature_flags._cache_ts = time.monotonic()


SWITCHES_OFF = dict(semanticLayerEditMode=False, semanticLayerNonAdminEditing=False,
                    semanticLayerImportEnabled=False, semanticLayerExportEnabled=False,
                    semanticLayerVersionHistory=False)


def org_layer(oid: str, *, published=True, scope="universal", owner=None, system=False, **kw) -> OntologyORM:
    return OntologyORM(id=oid, schema_id=oid, name=kw.pop("name", oid), version=1, is_published=published,
                       scope=scope, owner_workspace_id=owner, is_system=system,
                       entity_type_definitions=json.dumps(kw.pop("entities", {"table": {"name": "Table"}})),
                       relationship_type_definitions=json.dumps(kw.pop("rels", {})), **kw)


@pytest.fixture
async def world(db_session, monkeypatch):
    """The Playground (with a starter), Team and the Lab; an approved org layer, an org draft, the
    system layer, a Team-scoped layer and an old per-graph import model. The Playground is on; the
    read caches a layer's change bumps are in memory (there is no Redis here)."""
    from backend.app.api.v1.endpoints import workspaces
    from backend.app.services import graph_cache, resolved_ontology_cache

    async def _bumped(*_args, **_kwargs):
        return None

    monkeypatch.setattr(resolved_ontology_cache, "bump_scopes", _bumped)
    monkeypatch.setattr(resolved_ontology_cache, "bump_ontology_generation", _bumped)
    monkeypatch.setattr(graph_cache, "bump_aggregated_generations", _bumped)
    monkeypatch.setattr(graph_cache, "purge_aggregated_lkg", _bumped)
    monkeypatch.setattr(graph_cache, "invalidate_hierarchy_reads", _bumped)
    monkeypatch.setattr(workspaces, "enqueue_stats_job_safe", _bumped)
    set_flags(playgroundEnabled=True)
    db_session.add_all([
        ProviderORM(id="prov_sandbox", name="Sandbox", provider_type="falkordb", host="sandbox", port=6379),
        WorkspaceORM(id=PG, name="Playground", kind="playground", request_policy="open", publish_policy="request",
                     playground_settings=json.dumps({"sandboxProviderId": "prov_sandbox",
                                                     "starterOntologyIds": ["ont_starter"]})),
        WorkspaceORM(id=TEAM, name="Team"),
        WorkspaceORM(id=LAB, name="Lab"),
    ])
    await db_session.flush()
    db_session.add_all([
        org_layer("ont_approved", name="Approved"),
        org_layer("ont_starter", name="Starter", scope="workspace"),
        org_layer("ont_org_draft", published=False),
        org_layer("ont_system", system=True),
        org_layer("ont_team_scoped", scope="workspace"),
        org_layer("bp_import_abc123", name="Someone's file"),
        WorkspaceDataSourceORM(id="ds_team", workspace_id=TEAM, provider_id="prov_sandbox",
                               graph_name="team", label="Team graph", ontology_id="ont_team_scoped",
                               created_by=CY.id),
    ])
    await db_session.commit()
    yield db_session


async def make_layer(client: AsyncClient, user=ADA, claims=MEMBER, *, name="Mine", source=None, publish=False,
                     shared=False) -> dict:
    """A layer of ``user``'s own, through the Playground."""
    with acting(user, claims):
        r = await client.post(LAYERS, json={"name": name, "from": source or {"layer": {"name": name, **TYPES}}})
        assert r.status_code == 201, r.text
        made = r.json()
        if publish:
            r = await client.post(f"{ONT}/{made['id']}/publish")
            assert r.status_code == 200, r.text
            made = r.json()
        if shared:
            r = await client.post(f"{LAYERS}/{made['id']}/share", json={"shared": True})
            assert r.status_code == 200, r.text
            made = r.json()
    return made


def refusal(r) -> str:
    detail = r.json().get("detail")
    if isinstance(detail, dict):
        return detail.get("type") or detail.get("error") or ""
    return str(detail)


async def fresh(session, oid: str) -> OntologyORM:
    return (await session.execute(select(OntologyORM).where(OntologyORM.id == oid)
                                  .execution_options(populate_existing=True))).scalar_one()


# ── The owner rule ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_owner_edits_publishes_and_deletes_their_layer_with_the_switches_off(
        test_client: AsyncClient, world):
    made = await make_layer(test_client)
    set_flags(**SWITCHES_OFF)
    lid = made["id"]
    with acting(ADA, MEMBER):
        renamed = await test_client.put(f"{ONT}/{lid}", json={"name": "Renamed", **TYPES})
        exported = await test_client.get(f"{ONT}/{lid}/export")
        # Through the import gate (a file that changes nothing: an import that changes something
        # records an audit action the audit table doesn't allow yet, whoever imports).
        imported = await test_client.post(f"{ONT}/{lid}/import", json=exported.json())
        published = await test_client.post(f"{ONT}/{lid}/publish")
        version = await test_client.post(f"{ONT}/{lid}/new-version")
        versions = await test_client.get(f"{ONT}/{lid}/versions")
        audit = await test_client.get(f"{ONT}/{lid}/audit")
        deleted = await test_client.delete(f"{ONT}/{version.json()['id']}")
        restored = await test_client.post(f"{ONT}/{version.json()['id']}/restore")
    for r in (renamed, exported, imported, published, versions, audit, restored):
        assert r.status_code == 200, r.text
    assert version.status_code == 201 and deleted.status_code == 204, (version.text, deleted.text)
    assert published.json()["access"] == {"canEdit": True, "canPublish": True, "canDelete": True, "canClone": True,
                                          "canShare": True, "canAssign": True, "isOwn": True}
    assert [v["version"] for v in versions.json()] == [2, 1]
    # Who did what, on every write.
    first, second = await fresh(world, lid), await fresh(world, version.json()["id"])
    assert (first.created_by, first.updated_by, first.published_by) == (ADA.id, ADA.id, ADA.id)
    assert (second.created_by, second.deleted_by, second.updated_by) == (ADA.id, None, ADA.id)
    assert (second.owner_workspace_id, second.owner_visibility, second.scope) == (PG, "private", "workspace")
    actors = {e["actor"] for e in audit.json()}
    assert actors == {ADA.id}


@pytest.mark.asyncio
async def test_export_and_history_stay_switched_off_for_everyone_else(test_client: AsyncClient, world):
    shared = await make_layer(test_client, name="Shared", publish=True, shared=True)
    set_flags(semanticLayerExportEnabled=False, semanticLayerVersionHistory=False)
    with acting(BEN, MEMBER):
        others = [await test_client.get(f"{ONT}/{shared['id']}{path}") for path in ("/export", "/versions", "/audit")]
    with acting(BEN, TEAM_EDITOR):
        org = [await test_client.get(f"{ONT}/ont_team_scoped{path}") for path in ("/export", "/versions", "/audit")]
    with acting(ADA, MEMBER):
        own = [await test_client.get(f"{ONT}/{shared['id']}{path}") for path in ("/export", "/versions", "/audit")]
    assert [(r.status_code, refusal(r)) for r in others + org] == [(403, "feature_disabled")] * 6
    assert [r.status_code for r in own] == [200, 200, 200]


@pytest.mark.asyncio
async def test_a_layer_in_use_is_not_deleted(test_client: AsyncClient, world):
    made = await make_layer(test_client, publish=True)
    world.add(WorkspaceDataSourceORM(id="ds_ada", workspace_id=PG, provider_id="prov_sandbox", graph_name="a",
                                     label="Ada's", ontology_id=made["id"], created_by=ADA.id))
    await world.commit()
    with acting(ADA, MEMBER):
        r = await test_client.delete(f"{ONT}/{made['id']}")
        got = await test_client.get(f"{ONT}/{made['id']}")
    assert r.status_code == 409
    assert got.json()["access"]["canDelete"] is False and got.json()["access"]["canEdit"] is True


@pytest.mark.asyncio
async def test_nobody_else_changes_it(test_client: AsyncClient, world):
    private = await make_layer(test_client, name="Private")
    shared = await make_layer(test_client, name="Shared", publish=True, shared=True)
    body = {"name": "Not yours", **TYPES}
    with acting(BEN, MEMBER):
        hidden = await test_client.put(f"{ONT}/{private['id']}", json=body)
        not_yours = await test_client.put(f"{ONT}/{shared['id']}", json=body)
        not_publish = await test_client.post(f"{ONT}/{shared['id']}/new-version")
    # Managing semantic layers somewhere else gives no say over a Playground member's.
    with acting(BEN, TEAM_EDITOR):
        editor = await test_client.put(f"{ONT}/{shared['id']}", json=body)
    # A person, never a key — even the maker's own.
    with acting(ADA, KEY):
        key = await test_client.put(f"{ONT}/{private['id']}", json=body)
    assert hidden.status_code == 404
    assert (not_yours.status_code, refusal(not_yours)) == (403, "layer_not_yours")
    assert (not_publish.status_code, refusal(not_publish)) == (403, "layer_not_yours")
    assert (editor.status_code, refusal(editor)) == (403, "layer_not_yours")
    assert key.status_code == 403
    assert (await fresh(world, shared["id"])).name == "Shared"


@pytest.mark.asyncio
async def test_a_playground_admin_may_and_a_platform_admin_keeps_the_org_rules(test_client: AsyncClient, world):
    made = await make_layer(test_client)
    with acting(CY, PG_ADMIN):
        admin = await test_client.put(f"{ONT}/{made['id']}", json={"name": "Tidied"})
    set_flags(semanticLayerEditMode=False)
    with acting(CY, PLATFORM_ADMIN):
        # The platform admin is a maker too while the Playground is on …
        platform = await test_client.put(f"{ONT}/{made['id']}", json={"name": "Tidied again"})
    set_flags(playgroundEnabled=False)
    with acting(CY, PLATFORM_ADMIN):
        # … and held to the org's switches once it is off.
        off = await test_client.put(f"{ONT}/{made['id']}", json={"name": "Not now"})
    assert admin.status_code == 200, admin.text
    assert platform.status_code == 200, platform.text
    assert (off.status_code, refusal(off)) == (403, "feature_disabled")


@pytest.mark.asyncio
async def test_with_the_playground_off_its_makers_change_nothing(test_client: AsyncClient, world):
    made = await make_layer(test_client)
    set_flags(playgroundEnabled=False)
    with acting(ADA, MEMBER):
        r = await test_client.put(f"{ONT}/{made['id']}", json={"name": "Later"})
        read = await test_client.get(f"{ONT}/{made['id']}")
    assert (r.status_code, refusal(r)) == (403, "layer_not_yours")
    assert read.status_code == 200 and read.json()["access"]["canEdit"] is False


@pytest.mark.asyncio
async def test_org_layers_keep_todays_rules(test_client: AsyncClient, world):
    body = {"name": "Team's, renamed"}
    with acting(ADA, MEMBER):
        member = await test_client.put(f"{ONT}/ont_team_scoped", json=body)
    with acting(BEN, TEAM_EDITOR):
        editor = await test_client.put(f"{ONT}/ont_team_scoped", json=body)
    set_flags(semanticLayerEditMode=False)
    with acting(BEN, TEAM_EDITOR):
        frozen = await test_client.put(f"{ONT}/ont_team_scoped", json=body)
        publish = await test_client.post(f"{ONT}/ont_org_draft/publish")    # not visible to them
    set_flags(semanticLayerEditMode=True, semanticLayerNonAdminEditing=False)
    with acting(BEN, TEAM_EDITOR):
        admins_only = await test_client.put(f"{ONT}/ont_team_scoped", json=body)
    assert (member.status_code, refusal(member)) == (403, "missing_permission")
    assert editor.status_code == 200, editor.text
    assert editor.json()["updatedBy"] == BEN.id
    assert (frozen.status_code, refusal(frozen)) == (403, "feature_disabled")
    assert publish.status_code == 404
    assert (admins_only.status_code, refusal(admins_only)) == (403, "feature_disabled")


@pytest.mark.asyncio
async def test_an_org_layer_records_who_made_and_published_it(test_client: AsyncClient, world):
    from tests.conftest import _FAKE_USER
    made = await test_client.post(ONT, json={"name": "Org layer", **TYPES})
    published = await test_client.post(f"{ONT}/{made.json()['id']}/publish")
    deleted = await test_client.delete(f"{ONT}/{made.json()['id']}")
    assert made.status_code == 201 and published.status_code == 200 and deleted.status_code == 204
    row = await fresh(world, made.json()["id"])
    assert (row.created_by, row.published_by, row.deleted_by) == (_FAKE_USER.id,) * 3
    assert (row.owner_workspace_id, row.scope) == (None, "universal")


@pytest.mark.asyncio
async def test_restoring_takes_seeing_the_layer(test_client: AsyncClient, world):
    world.add(org_layer("ont_gone", deleted_at="2026-11-20T00:00:00+00:00"))
    await world.commit()
    with acting(BEN, TEAM_EDITOR):
        r = await test_client.post(f"{ONT}/ont_gone/restore")
    assert r.status_code == 404
    assert (await fresh(world, "ont_gone")).deleted_at is not None


# ── Who sees what ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_member_sees_their_own_shared_and_approved_layers_and_nothing_private_of_others(
        test_client: AsyncClient, world):
    mine = await make_layer(test_client, name="Mine")
    bens_private = await make_layer(test_client, BEN, name="Ben's private", publish=True)
    bens_shared = await make_layer(test_client, BEN, name="Ben's shared", publish=True, shared=True)
    bens_shared_draft = await make_layer(test_client, BEN, name="Ben's shared draft", shared=True)
    with acting(ADA, MEMBER):
        seen = {o["id"] for o in (await test_client.get(ONT)).json()}
        private = await test_client.get(f"{ONT}/{bens_private['id']}")
    with acting(ADA, PermissionClaims(sid="s_x", ws_perms={TEAM: MEMBER_PERMS})):
        outside = {o["id"] for o in (await test_client.get(ONT)).json()}
    assert seen == {mine["id"], bens_shared["id"], "ont_approved", "ont_starter"}
    assert bens_shared_draft["id"] not in seen
    assert private.status_code == 404
    # Someone outside the Playground sees what their workspaces use, as before.
    assert outside == {"ont_team_scoped"}


@pytest.mark.asyncio
async def test_a_graph_keeps_its_layer_visible_to_those_who_read_it(test_client: AsyncClient, world):
    bens = await make_layer(test_client, BEN, name="Ben's", publish=True)
    world.add(WorkspaceDataSourceORM(id="ds_ben", workspace_id=PG, provider_id="prov_sandbox", graph_name="b",
                                     label="Ben's", ontology_id=bens["id"], created_by=BEN.id))
    await world.commit()
    with acting(ADA, MEMBER):
        r = await test_client.get(f"{ONT}/{bens['id']}")
    assert r.status_code == 200
    assert r.json()["access"] == {"canEdit": False, "canPublish": False, "canDelete": False, "canClone": True,
                                  "canShare": False, "canAssign": False, "isOwn": False}


@pytest.mark.asyncio
async def test_each_layer_says_what_its_reader_may_do(test_client: AsyncClient, world):
    with acting(ADA, MEMBER):
        member = (await test_client.get(f"{ONT}/ont_approved")).json()["access"]
    with acting(BEN, TEAM_EDITOR):
        editor = (await test_client.get(f"{ONT}/ont_team_scoped")).json()["access"]
    set_flags(semanticLayerEditMode=False)
    with acting(BEN, TEAM_EDITOR):
        frozen = (await test_client.get(f"{ONT}/ont_team_scoped")).json()["access"]
    with acting(ADA, KEY):
        key = (await test_client.get(f"{ONT}/ont_approved")).json()["access"]
    nothing = {"canEdit": False, "canPublish": False, "canDelete": False, "canClone": False,
               "canShare": False, "canAssign": False, "isOwn": False}
    assert member == nothing and key == nothing
    # In use by Team's graph: not deletable.
    assert editor == {**nothing, "canEdit": True, "canPublish": True, "canClone": True, "canAssign": True}
    assert frozen == {**nothing, "canPublish": True, "canClone": True, "canAssign": True}


# ── Approving a workspace's layer for everyone ───────────────────────────

@pytest.mark.asyncio
async def test_approving_a_workspaces_layer_makes_it_the_orgs(test_client: AsyncClient, world):
    world.add_all([
        org_layer("ont_lab", scope="workspace", owner=LAB),
        OntologyORM(id="ont_lab_v2", schema_id="ont_lab", name="ont_lab", version=2, is_published=False,
                    scope="workspace", owner_workspace_id=LAB, owner_visibility=None),
        org_layer("ont_lab_draft", published=False, scope="workspace", owner=LAB),
        WorkspaceDataSourceORM(id="ds_lab", workspace_id=LAB, provider_id="prov_sandbox", graph_name="lab",
                               label="Lab graph", ontology_id="ont_lab", created_by=ADA.id),
        WorkspaceDataSourceORM(id="ds_lab2", workspace_id=LAB, provider_id="prov_sandbox", graph_name="lab2",
                               label="Lab draft graph", ontology_id="ont_lab_draft", created_by=ADA.id),
    ])
    await world.commit()
    with acting(ADA, MEMBER):
        member = await test_client.post(f"{ONT}/ont_lab/approve")
    with acting(BEN, TEAM_EDITOR):
        approved = await test_client.post(f"{ONT}/ont_lab/approve")
        org = await test_client.post(f"{ONT}/ont_approved/approve")
        draft = await test_client.post(f"{ONT}/ont_lab_draft/approve")
    assert member.status_code == 403
    assert approved.status_code == 200, approved.text
    assert (approved.json()["scope"], approved.json()["ownerWorkspaceId"]) == ("universal", None)
    assert [(r.scope, r.owner_workspace_id) for r in (await fresh(world, "ont_lab"), await fresh(world, "ont_lab_v2"))] \
        == [("universal", None), ("universal", None)]
    assert (org.status_code, refusal(org)) == (409, "not_owned")
    assert (draft.status_code, refusal(draft)) == (409, "not_published")
    # Approved for everyone: on offer to every Playground member.
    assert "ont_lab" in await playground_layers.offered_ontology_ids(world, MEMBER, BEN.id)


# ── The migration ────────────────────────────────────────────────────────

_MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261129_1000_ontology_owner.py"


def _migration():
    spec = importlib.util.spec_from_file_location(_MIGRATION.stem, _MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(engine, step: str) -> None:
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            getattr(_migration(), step)()


def test_the_revision_follows_the_merge_and_fits():
    mig = _migration()
    assert mig.revision == _MIGRATION.stem and len(mig.revision) <= 32
    assert mig.down_revision == "20261128_1000_merge_reusable"


def test_the_migration_adds_the_owner_and_takes_it_away_again():
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE workspaces (id TEXT PRIMARY KEY)"))
        conn.execute(sa.text("CREATE TABLE ontologies (id TEXT PRIMARY KEY, name TEXT)"))
        conn.execute(sa.text("INSERT INTO ontologies VALUES ('o1', 'Kept')"))

    def shape():
        inspector = sa.inspect(engine)
        return ({c["name"] for c in inspector.get_columns("ontologies")},
                {i["name"] for i in inspector.get_indexes("ontologies")})

    _run(engine, "upgrade")
    _run(engine, "upgrade")                          # guarded: a second run changes nothing
    columns, indexes = shape()
    assert {"owner_workspace_id", "owner_visibility"} <= columns
    assert "idx_ontologies_owner_workspace" in indexes
    _run(engine, "downgrade")
    columns, indexes = shape()
    assert columns == {"id", "name"} and "idx_ontologies_owner_workspace" not in indexes
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT name FROM ontologies")).scalar_one() == "Kept"


def test_the_model_and_the_migration_agree():
    columns = OntologyORM.__table__.columns
    assert columns["owner_workspace_id"].nullable and columns["owner_visibility"].nullable
    [fk] = columns["owner_workspace_id"].foreign_keys
    assert (fk.target_fullname, fk.ondelete) == ("workspaces.id", "SET NULL")
    assert "idx_ontologies_owner_workspace" in {i.name for i in OntologyORM.__table__.indexes}

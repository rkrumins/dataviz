"""Who may create a semantic layer, who may change which one, and what the trail says about it.

* **Creating** a layer — a blank draft, a clone, a file imported as new — needs
  ``workspace:ontology:create`` on top of manage, and the ``semanticLayerCreation`` switch, which
  stops admins too. Importing into an existing layer and changing one are not creating.
* **Changing a layer** takes managing layers where it matters: in a workspace one of whose data
  sources uses it (or that owns it), or — while nothing uses it — being the one who made it.
  Holding manage in some other workspace is no longer enough. Each layer says so (``access``).
* **A creator sees their new draft**, which no data source uses yet.
* **The trail** names what happened — ``cloned``, ``versioned``, ``approved`` — and who did it,
  and every change is in the platform's Activity log too.
* The migration brings the permission to every role that manages layers today, and takes it away
  again.
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
from backend.app.db.models import (
    OntologyAuditLogORM,
    OntologyORM,
    OutboxEventORM,
    ProviderORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.activity import catalogue
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

ONT = "/api/v1/admin/ontologies"
A, B = "ws_a", "ws_b"
READS = ("workspace:ontology:read", "workspace:datasource:read")
MANAGES = READS + ("workspace:ontology:manage",)
CREATES = MANAGES + ("workspace:ontology:create",)
BODY = {"name": "Fresh", "entityTypeDefinitions": {"table": {"name": "Table"}}, "relationshipTypeDefinitions": {}}
#: The test client's signed-in administrator.
ME = "usr_test000000"


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name=uid[4:].title(), last_name="T", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


DEE, EVE = _user("usr_dee"), _user("usr_eve")
#: A data engineer in A who reads B.
ENGINEER = PermissionClaims(sid="s_dee", ws_perms={A: CREATES, B: READS})
#: Manages layers in A, but may not start new ones.
KEEPER = PermissionClaims(sid="s_keep", ws_perms={A: MANAGES})


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


def refusal(r) -> str:
    detail = r.json().get("detail")
    return (detail.get("type") or detail.get("error") or "") if isinstance(detail, dict) else str(detail)


def layer(oid: str, **kw) -> OntologyORM:
    return OntologyORM(id=oid, schema_id=kw.pop("schema_id", oid), name=kw.pop("name", oid),
                       version=kw.pop("version", 1), is_published=kw.pop("published", True),
                       entity_type_definitions=json.dumps({"table": {"name": "Table"}}),
                       relationship_type_definitions="{}", **kw)


@pytest.fixture
async def estate(db_session, monkeypatch):
    """Workspaces A and B; ``ont_a`` used by A's source, ``ont_b`` used only by B's, a published
    ``ont_shared`` used by both. The read caches a layer's change bumps are in memory."""
    from backend.app.services import graph_cache, resolved_ontology_cache

    async def _nothing(*_args, **_kwargs):
        return None

    for module, name in ((resolved_ontology_cache, "bump_scopes"), (graph_cache, "bump_aggregated_generations"),
                         (graph_cache, "purge_aggregated_lkg")):
        monkeypatch.setattr(module, name, _nothing)
    db_session.add_all([
        ProviderORM(id="prov_1", name="Graph", provider_type="falkordb", host="g", port=6379),
        WorkspaceORM(id=A, name="Alpha"),
        WorkspaceORM(id=B, name="Beta"),
    ])
    await db_session.flush()
    db_session.add_all([
        layer("ont_a", name="Alpha layer", published=False),
        layer("ont_b", name="Beta layer"),
        layer("ont_shared", name="Shared layer"),
        WorkspaceDataSourceORM(id="ds_a", workspace_id=A, provider_id="prov_1", graph_name="a", label="A",
                               ontology_id="ont_a"),
        WorkspaceDataSourceORM(id="ds_b", workspace_id=B, provider_id="prov_1", graph_name="b", label="B",
                               ontology_id="ont_b"),
        WorkspaceDataSourceORM(id="ds_bs", workspace_id=B, provider_id="prov_1", graph_name="bs", label="BS",
                               ontology_id="ont_shared"),
        WorkspaceDataSourceORM(id="ds_as", workspace_id=A, provider_id="prov_1", graph_name="as", label="AS",
                               ontology_id="ont_shared"),
    ])
    await db_session.commit()
    yield db_session


async def _actions(session, schema_id: str) -> list[tuple[str, str]]:
    return [tuple(r) for r in (await session.execute(
        select(OntologyAuditLogORM.action, OntologyAuditLogORM.actor)
        .where(OntologyAuditLogORM.schema_id == schema_id).order_by(OntologyAuditLogORM.created_at)
    )).all()]


async def _events(session, event_type: str) -> list[dict]:
    rows = (await session.execute(select(OutboxEventORM).where(OutboxEventORM.event_type == event_type))).scalars()
    return [json.loads(r.payload) for r in rows]


# ── Creating ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_with_creation_off_nobody_starts_a_layer_and_everything_else_goes_on(
        test_client: AsyncClient, estate):
    set_flags(semanticLayerCreation=False)
    created = await test_client.post(ONT, json=BODY)
    imported = await test_client.post(f"{ONT}/import", json=BODY)
    cloned = await test_client.post(f"{ONT}/ont_b/clone")
    for r in (created, imported, cloned):
        assert (r.status_code, refusal(r)) == (403, "feature_disabled"), r.text
        assert r.json()["detail"]["feature"] == "semanticLayerCreation"
    # Not creating: changing a layer, importing into one, starting its next version.
    assert (await test_client.put(f"{ONT}/ont_a", json={"name": "Renamed"})).status_code == 200
    into = await test_client.post(f"{ONT}/ont_a/import", json={**BODY, "name": "Renamed", "description": "More"})
    assert into.status_code == 200, into.text
    assert (await test_client.post(f"{ONT}/ont_b/new-version")).status_code == 201
    # And each layer says it can't be cloned.
    assert (await test_client.get(f"{ONT}/ont_b")).json()["access"]["canClone"] is False


@pytest.mark.asyncio
async def test_creating_takes_the_create_permission_as_well_as_manage(test_client: AsyncClient, estate):
    with acting(EVE, KEEPER):
        refused = [await test_client.post(ONT, json=BODY), await test_client.post(f"{ONT}/import", json=BODY),
                   await test_client.post(f"{ONT}/ont_a/clone")]
        editing = await test_client.put(f"{ONT}/ont_a", json={"name": "Still theirs to change"})
        access = (await test_client.get(f"{ONT}/ont_a")).json()["access"]
    for r in refused:
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["permission"] == "workspace:ontology:create"
    assert editing.status_code == 200, editing.text
    assert access["canEdit"] is True and access["canClone"] is False
    with acting(EVE, PermissionClaims(sid="s_r", ws_perms={A: READS})):
        reader = await test_client.post(ONT, json=BODY)
    # A reader lacks the more basic of the two, and is told that one.
    assert reader.json()["detail"]["permission"] == "workspace:ontology:manage"
    with acting(DEE, ENGINEER):
        made = await test_client.post(ONT, json=BODY)
        clone = await test_client.post(f"{ONT}/ont_a/clone")
    assert made.status_code == 201 and clone.status_code == 201, (made.text, clone.text)


@pytest.mark.asyncio
async def test_a_creator_sees_their_new_draft_and_nobody_else_is_shown_it(test_client: AsyncClient, estate):
    with acting(DEE, ENGINEER):
        made = (await test_client.post(ONT, json=BODY)).json()
        got = await test_client.get(f"{ONT}/{made['id']}")
        listed = {o["id"] for o in (await test_client.get(ONT)).json()}
        renamed = await test_client.put(f"{ONT}/{made['id']}", json={"name": "Mine, renamed"})
    with acting(EVE, PermissionClaims(sid="s_eve", ws_perms={A: CREATES})):
        other = await test_client.get(f"{ONT}/{made['id']}")
    assert got.status_code == 200, got.text
    assert made["id"] in listed
    assert got.json()["access"]["canEdit"] is True and got.json()["access"]["canDelete"] is True
    assert renamed.status_code == 200, renamed.text
    assert other.status_code == 404


# ── Which layer a person may change ──────────────────────────────────────

@pytest.mark.asyncio
async def test_managing_layers_in_one_workspace_changes_none_used_only_by_another(
        test_client: AsyncClient, estate):
    with acting(DEE, ENGINEER):
        seen = await test_client.get(f"{ONT}/ont_b")
        refused = [
            await test_client.put(f"{ONT}/ont_b", json={"name": "Not yours"}),
            await test_client.post(f"{ONT}/ont_b/new-version"),
            await test_client.post(f"{ONT}/ont_b/import", json={**BODY, "name": "Not yours"}),
            await test_client.delete(f"{ONT}/ont_b"),
        ]
        own = await test_client.put(f"{ONT}/ont_a", json={"name": "Alpha, renamed"})
        shared = await test_client.post(f"{ONT}/ont_shared/new-version")
        cloned = await test_client.post(f"{ONT}/ont_b/clone")       # a copy is theirs
    assert seen.status_code == 200
    assert seen.json()["access"] == {"canEdit": False, "canPublish": False, "canDelete": False, "canClone": True,
                                     "canShare": False, "canAssign": True, "isOwn": False}
    for r in refused:
        assert (r.status_code, refusal(r)) == (403, "layer_not_manageable"), r.text
    assert (await estate.get(OntologyORM, "ont_b")).name == "Beta layer"
    assert own.status_code == 200, own.text
    assert shared.status_code == 201, shared.text
    assert cloned.status_code == 201, cloned.text
    # Publishing answers to the same rule: B's draft is not theirs to publish.
    estate.add(layer("ont_b_draft", published=False))
    estate.add(WorkspaceDataSourceORM(id="ds_b2", workspace_id=B, provider_id="prov_1", graph_name="b2",
                                      label="B2", ontology_id="ont_b_draft"))
    await estate.commit()
    with acting(DEE, ENGINEER):
        publish = await test_client.post(f"{ONT}/ont_b_draft/publish")
    assert (publish.status_code, refusal(publish)) == (403, "layer_not_manageable")


@pytest.mark.asyncio
async def test_an_unused_layer_is_its_makers_and_a_platform_admin_changes_any(test_client: AsyncClient, estate):
    with acting(DEE, ENGINEER):
        made = (await test_client.post(ONT, json=BODY)).json()
    # Eve, who manages layers in A too, can't even see Dee's unused draft.
    with acting(EVE, PermissionClaims(sid="s_eve", ws_perms={A: CREATES})):
        hidden = await test_client.put(f"{ONT}/{made['id']}", json={"name": "Eve's now"})
    admin = await test_client.put(f"{ONT}/ont_b", json={"name": "Tidied by an admin"})
    assert hidden.status_code == 404
    assert admin.status_code == 200, admin.text


# ── The trail ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_the_trail_names_who_did_what(test_client: AsyncClient, estate):
    estate.add(layer("ont_src", name="Source", description="Where it starts", evolution_policy="deprecate"))
    estate.add(layer("ont_lab", owner_workspace_id=A, scope="workspace"))
    await estate.commit()

    clone = (await test_client.post(f"{ONT}/ont_src/clone")).json()
    version = (await test_client.post(f"{ONT}/ont_src/new-version")).json()
    approved = await test_client.post(f"{ONT}/ont_lab/approve")
    published = await test_client.post(f"{ONT}/{clone['id']}/publish")
    # A published layer's content is never rewritten: saving some starts its next version.
    saved = await test_client.put(f"{ONT}/{clone['id']}", json={
        "entityTypeDefinitions": {"table": {"name": "Table"}, "view": {"name": "View"}}})
    assert approved.status_code == 200 and published.status_code == 200 and saved.status_code == 200

    # A clone is a layer of its own that remembers what it was copied from.
    assert (clone["description"], clone["evolutionPolicy"]) == ("Where it starts", "deprecate")
    assert await _actions(estate, clone["id"]) == [("cloned", ME), ("published", ME), ("versioned", ME)]
    assert ("versioned", ME) in await _actions(estate, "ont_src")
    assert version["schemaId"] == "ont_src"
    assert await _actions(estate, "ont_lab") == [("approved", ME)]
    [entry] = (await test_client.get(f"{ONT}/{clone['id']}/audit", params={"action": "cloned"})).json()
    assert entry["summary"].startswith('Cloned from "Source" v1')


@pytest.mark.asyncio
async def test_every_change_is_in_the_activity_log_as_whoever_made_it(test_client: AsyncClient, estate):
    made = (await test_client.post(ONT, json=BODY)).json()
    await test_client.post(f"{ONT}/{made['id']}/publish")
    await test_client.post(f"{ONT}/ont_b/clone")
    assert (await test_client.delete(f"{ONT}/{made['id']}")).status_code == 204
    assert (await test_client.post(f"{ONT}/{made['id']}/restore")).status_code == 200

    [created] = await _events(estate, "ontology.layer.created")
    assert (created["actor_id"], created["target_type"], created["target_id"], created["target_label"]) == (
        ME, "ontology", made["id"], "Fresh")
    assert created["details"] == {"version": 1}
    [cloned] = await _events(estate, "ontology.layer.cloned")
    assert cloned["details"]["fromId"] == "ont_b"
    for kind in ("published", "deleted", "restored"):
        assert len(await _events(estate, f"ontology.layer.{kind}")) == 1, kind

    read = catalogue.project(event_type="ontology.layer.cloned", payload=cloned, event_version=2)
    assert read["category"] == "content" and read["audience"] == "platform"
    assert catalogue.summarize("ontology.layer.cloned", cloned) == (
        "info", "Cloned semantic layer Beta layer (copy) v1, from Beta layer v1")
    assert catalogue.severity_of("ontology.layer.deleted") == "warning"


# ── The migration ────────────────────────────────────────────────────────

_MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261201_1000_ontology_create.py"


def _migration():
    spec = importlib.util.spec_from_file_location(_MIGRATION.stem, _MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_revision_follows_the_head_and_fits():
    mig = _migration()
    assert mig.revision == _MIGRATION.stem and len(mig.revision) <= 32
    assert mig.down_revision == "20261130_1100_merge_watch_told"


def test_the_migration_keeps_creating_with_everyone_who_could_and_takes_it_away_again():
    from backend.app.db.models import Base, PermissionORM, RoleORM, RolePermissionORM

    mig = _migration()

    def run(conn, step):
        with Operations.context(MigrationContext.configure(conn)):
            getattr(mig, step)()

    def holders(conn) -> set[str]:
        return set(conn.execute(sa.text(
            "SELECT role_name FROM role_permissions WHERE permission_id = :p"), {"p": mig._PERMISSION}).scalars())

    with sa.create_engine("sqlite://").connect() as conn:
        Base.metadata.create_all(conn, tables=[PermissionORM.__table__, RoleORM.__table__,
                                               RolePermissionORM.__table__])
        for perm in ("workspace:ontology:manage", "workspace:ontology:read"):
            conn.execute(sa.text("INSERT INTO permissions (id, description, category) VALUES (:p, 'x', 'workspace')"),
                         {"p": perm})
        roles = {"org_admin": True, "super_admin": True, "workspace_data_engineer": True,
                 "workspace_steward": True, "layer_keepers": False, "layer_readers": False}
        for name, system in roles.items():
            conn.execute(sa.text("INSERT INTO roles (name, scope_type, is_system, created_at, updated_at) "
                                 "VALUES (:n, 'global', :s, 'now', 'now')"), {"n": name, "s": system})
        # An administrator gave the steward manage; a custom role manages layers, another reads them.
        for name, perm in (("workspace_steward", "workspace:ontology:manage"),
                           ("layer_keepers", "workspace:ontology:manage"),
                           ("layer_readers", "workspace:ontology:read")):
            conn.execute(sa.text("INSERT INTO role_permissions (role_name, permission_id) VALUES (:n, :p)"),
                         {"n": name, "p": perm})

        run(conn, "upgrade")
        run(conn, "upgrade")
        assert holders(conn) == {"org_admin", "super_admin", "workspace_data_engineer", "workspace_steward",
                                 "layer_keepers"}
        assert conn.execute(sa.text("SELECT category FROM permissions WHERE id = :p"),
                            {"p": mig._PERMISSION}).scalar_one() == "workspace"

        run(conn, "downgrade")
        assert holders(conn) == set()
        assert conn.execute(sa.text("SELECT count(*) FROM permissions WHERE id = :p"),
                            {"p": mig._PERMISSION}).scalar_one() == 0


def test_the_model_allows_every_action_the_trail_writes():
    check = next(c for c in OntologyAuditLogORM.__table__.constraints if c.name == "ck_oal_action_enum")
    for action in ("created", "updated", "published", "deleted", "restored", "cloned", "imported",
                   "versioned", "approved"):
        assert f"'{action}'" in str(check.sqltext)
    allowed = _migration()._NEW
    assert all(f"'{a}'" in allowed for a in ("versioned", "approved", "imported", "cloned"))

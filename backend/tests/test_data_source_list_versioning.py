"""A workspace's data sources as a script that follows its graphs reads them: narrowed to one
provider, and — when asked — with each one's version control from the version store.

``include=versioning`` is opt-in, so the app's own call never waits on that store. When it is
asked for, the answer carries the facts or is a 503 to retry — never a list with them quietly
missing, which a script would read as "nothing is versioned".
"""
import pytest
from sqlalchemy.exc import OperationalError

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM

LIST = "/api/v1/admin/workspaces/ws_a/data-sources"
HEAD = {"graph_id": "graph_a", "kind": "manual", "main_head_commit_seq": 7,
        "main_head_commit_id": "cmt_7", "main_head_committed_at": "2026-10-20T09:00:00+00:00"}


@pytest.fixture
async def estate(db_session):
    """``ws_a``: ``ds_a`` and ``ds_c`` on ``prov_a``, ``ds_b`` on ``prov_b``, one in the trash."""
    db_session.add_all([
        WorkspaceORM(id="ws_a", name="Lineage"),
        ProviderORM(id="prov_a", name="Primary store", provider_type="falkordb"),
        ProviderORM(id="prov_b", name="Second store", provider_type="falkordb"),
        WorkspaceDataSourceORM(id="ds_a", workspace_id="ws_a", provider_id="prov_a",
                               graph_name="orders", is_primary=True),
        WorkspaceDataSourceORM(id="ds_b", workspace_id="ws_a", provider_id="prov_b",
                               graph_name="payments"),
        WorkspaceDataSourceORM(id="ds_c", workspace_id="ws_a", provider_id="prov_a",
                               graph_name="customers"),
        WorkspaceDataSourceORM(id="ds_trashed", workspace_id="ws_a", provider_id="prov_a",
                               graph_name="archive", deleted_at="2026-10-01T00:00:00+00:00"),
    ])
    await db_session.commit()


class _Versioning:
    def __init__(self, heads=None, fail=None):
        self.heads, self.fail, self.calls = heads or {}, fail, []

    async def main_heads(self, *, workspace_id, data_source_ids):
        self.calls.append((workspace_id, list(data_source_ids)))
        if self.fail:
            raise self.fail
        return {ds: head for ds, head in self.heads.items() if ds in data_source_ids}


@pytest.fixture
def versioning():
    from backend.app.main import app

    def use(**kw):
        svc = _Versioning(**kw)
        app.dependency_overrides[get_versioning_service] = lambda: svc
        return svc

    yield use
    app.dependency_overrides.pop(get_versioning_service, None)


async def test_without_include_the_version_store_is_not_asked(test_client, estate, versioning):
    svc = versioning(heads={"ds_a": HEAD})
    r = await test_client.get(LIST)
    assert r.status_code == 200, r.text
    assert [d["id"] for d in r.json()] == ["ds_a", "ds_b", "ds_c"]
    assert all(d["versioning"] is None for d in r.json())
    assert svc.calls == []


async def test_include_versioning_tells_versioned_from_external(test_client, estate, versioning):
    svc = versioning(heads={"ds_a": HEAD})
    r = await test_client.get(LIST, params={"include": "versioning"})
    assert r.status_code == 200, r.text
    by_id = {d["id"]: d["versioning"] for d in r.json()}
    assert by_id["ds_a"] == {
        "enabled": True, "graphId": "graph_a", "kind": "manual", "mainHeadCommitSeq": 7,
        "mainHeadCommitId": "cmt_7", "mainHeadCommittedAt": "2026-10-20T09:00:00+00:00",
    }
    assert by_id["ds_b"] == {
        "enabled": False, "graphId": None, "kind": None, "mainHeadCommitSeq": None,
        "mainHeadCommitId": None, "mainHeadCommittedAt": None,
    }
    assert svc.calls == [("ws_a", ["ds_a", "ds_b", "ds_c"])]       # one batched read


async def test_a_provider_narrows_the_list(test_client, estate, versioning):
    versioning(heads={"ds_a": HEAD})
    r = await test_client.get(LIST, params={"providerId": "prov_a", "include": "versioning"})
    assert r.status_code == 200, r.text
    assert [(d["id"], d["providerId"], d["graphName"]) for d in r.json()] == [
        ("ds_a", "prov_a", "orders"), ("ds_c", "prov_a", "customers")]
    assert [d["versioning"]["enabled"] for d in r.json()] == [True, False]


async def test_an_unknown_provider_is_an_empty_list(test_client, estate, versioning):
    svc = versioning()
    r = await test_client.get(LIST, params={"providerId": "prov_none", "include": "versioning"})
    assert r.status_code == 200 and r.json() == []
    assert svc.calls == []


async def test_an_unreadable_version_store_is_a_503_to_retry(test_client, estate, versioning):
    versioning(fail=OperationalError("SELECT 1", {}, ConnectionRefusedError("refused")))
    r = await test_client.get(LIST, params={"include": "versioning"})
    assert r.status_code == 503, r.text
    assert r.headers["Retry-After"] == "5"
    assert r.json()["detail"]["code"] == "DB_UNAVAILABLE"

    # …while the plain list doesn't depend on that store at all.
    assert (await test_client.get(LIST)).status_code == 200


async def test_only_versioning_can_be_included(test_client, estate, versioning):
    versioning()
    assert (await test_client.get(LIST, params={"include": "stats"})).status_code == 422

"""``/{ws_id}/graph/member-sets`` — the routes around member sets.

Their switches, how a set is found, continued and refused, its pages, and its download:
a link for one person and one purpose, cells that never run as formulas, its edges.
(The stepping itself is ``test_member_sets.py``.)
"""
import csv
import io
import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

from backend.app.api.v1.endpoints import graph as graph_mod
from backend.app.api.v1.endpoints import graph_member_sets
from backend.app.services.feature_flags import feature_flags
from backend.app.services.search_downloads import MEMBER_SET, mint_download_token
from backend.common.models.graph import GraphNode
from backend.tests.fixtures.membership_graph import FakeEngine

BASE = "/api/v1/test-ws/graph/member-sets"
URL = f"{BASE}?viewId=v1"
LINEAGE = {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": "all"}}


def _flags(**values):
    feature_flags._cache = {**(feature_flags._cache or {}), **values}
    feature_flags._cache_ts = time.monotonic()


class ScopedEngine(FakeEngine):
    """The fake graph, read in a workspace — as every request on these routes is."""
    _workspace_id = "test-ws"
    _data_source_id = "ds1"
    _branch_id = None


class FormulaNames(ScopedEngine):
    """A graph whose entities are named like spreadsheet formulas."""

    async def get_nodes_query(self, query):
        return [GraphNode(urn=u, displayName="=HYPERLINK(\"http://x\")", entityType="@thing")
                for u in query.urns if u in self.all]


class NoWalk(ScopedEngine):
    async def trace_closure(self, req):
        raise NotImplementedError("provider does not support trace_closure")


@pytest.fixture()
def data_version(monkeypatch):
    version = {"now": "7.g"}

    async def current(engine):
        return version["now"]

    monkeypatch.setattr(graph_member_sets, "_search_data_version", current)
    return version


@pytest.fixture()
def client(test_client: AsyncClient, db_session, data_version, monkeypatch):
    """The test client, its graph reads answered by ``client.engine``."""
    from backend.app.db.engine import get_graph_read_db_session
    from backend.app.main import app

    state = SimpleNamespace(engine=ScopedEngine())

    async def engine_dep():
        state.engine._db_session = db_session
        return state.engine

    async def engine_call(**_):
        return await engine_dep()

    async def read_session():
        yield db_session

    @asynccontextmanager
    async def rows_session():
        yield db_session

    app.dependency_overrides[graph_mod.get_context_engine] = engine_dep
    app.dependency_overrides[get_graph_read_db_session] = read_session
    app.dependency_overrides[graph_member_sets.row_sessions] = lambda: rows_session
    monkeypatch.setattr(graph_member_sets, "get_context_engine", engine_call)
    test_client.state = state
    yield test_client
    for dep in (graph_mod.get_context_engine, get_graph_read_db_session, graph_member_sets.row_sessions):
        app.dependency_overrides.pop(dep, None)


async def resolve(client, spec, **body):
    return await client.post(URL, json={"spec": spec, "waitMs": 30_000, **body})


def rows(text):
    return list(csv.reader(io.StringIO(text)))


# ── Switches ────────────────────────────────────────────────────────────────


async def test_the_export_switch_gates_every_route(client):
    _flags(graphExportEnabled=False)
    for resp in (
        await resolve(client, LINEAGE),
        await client.get(f"{BASE}/ms_x/members"),
        await client.get(f"{BASE}/ms_x/download", params={"token": "t"}),
    ):
        assert resp.status_code == 403
        assert resp.json()["detail"]["feature"] == "graphExportEnabled"


async def test_lineage_answers_to_the_trace_switch(client):
    _flags(traceEnabled=False)
    lineage = await resolve(client, LINEAGE)
    assert lineage.status_code == 403
    assert lineage.json()["detail"]["feature"] == "traceEnabled"
    inside = await resolve(client, {"seeds": {"urns": ["dom"]}, "expand": {"children": 1}})
    assert inside.status_code == 200


# ── A set: resolved, listed, downloaded ─────────────────────────────────────


async def test_a_set_is_resolved_listed_and_downloaded(client):
    resp = await resolve(client, LINEAGE, includeEdges=True)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["status"], body["stage"]) == ("complete", "done")
    assert body["counts"] == {"seeds": 1, "inside": 0, "upstream": 3, "downstream": 0,
                              "partnerInside": 0, "total": 4}
    assert body["setId"].startswith("ms_") and len(body["specHash"]) == 32
    assert body["dataVersion"] == "7.g" and body["truncated"] == [] and body["downloadToken"]
    assert body["progress"]["steps"] > 0 and body["completedAt"] and body["expiresAt"]

    first = (await client.get(f"{BASE}/{body['setId']}/members", params={"limit": 2})).json()
    rest = (await client.get(f"{BASE}/{body['setId']}/members", params={"after": first["next"]})).json()
    assert [m["urn"] for m in first["members"] + rest["members"]] == ["col_a1", "src1", "src2", "src3"]
    assert rest.get("next") is None
    assert first["members"][1] == {"urn": "src1", "via": "upstream", "hops": 1, "hopsUp": 1,
                                   "hopsDown": None, "name": "src1", "type": "thing",
                                   "nearestSeed": "col_a1"}
    seeds = (await client.get(f"{BASE}/{body['setId']}/members", params={"via": "seed"})).json()
    assert [m["urn"] for m in seeds["members"]] == ["col_a1"]

    url, token = f"{BASE}/{body['setId']}/download", body["downloadToken"]
    file = await client.get(url, params={"token": token})
    assert file.status_code == 200, file.text
    assert file.headers["content-type"].startswith("text/csv")
    assert "attachment" in file.headers["content-disposition"]
    table = rows(file.text)
    assert table[0] == ["urn", "name", "type", "qualifiedName", "via", "hops", "hopsUp", "hopsDown",
                        "nearestSeed", "parentUrn", "parentName", "parentType", "path", "pathUrns"]
    # Where it sits: col_a1 is in tbl_a, in dom; src1 is at the top of the graph.
    assert table[1] == ["col_a1", "col_a1", "thing", "", "seed", "", "0", "", "col_a1",
                        "tbl_a", "tbl_a", "thing", "dom / tbl_a", "dom; tbl_a"]
    assert table[2] == ["src1", "src1", "thing", "", "upstream", "1", "1", "", "col_a1", "", "", "", "", ""]

    lines = (await client.get(url, params={"token": token, "format": "ndjson",
                                           "columns": "entityType,missing"})).text.splitlines()
    assert json.loads(lines[3])["urn"] == "src3" and json.loads(lines[3])["entityType"] == "thing"
    assert json.loads(lines[3])["missing"] is None
    seed = json.loads(lines[0])
    assert (seed["path"], seed["pathUrns"], seed["parentType"]) == (["dom", "tbl_a"], ["dom", "tbl_a"], "thing")
    assert json.loads(lines[1])["path"] == [] and json.loads(lines[1])["parentUrn"] is None

    doc = (await client.get(url, params={"token": token, "format": "json"})).json()
    assert doc["meta"]["setId"] == body["setId"] and doc["meta"]["includeEdges"] is True
    assert len(doc["nodes"]) == 4 and len(doc["edges"]) == 3


async def test_where_a_member_sits_is_blank_when_the_graph_cannot_say(client):
    """A reader with no containment walk: the file still downloads, its parent and
    path cells empty rather than wrong."""
    client.state.engine = ScopedEngine(chains=False)
    body = (await resolve(client, {"seeds": {"urns": ["col_a1"]}})).json()
    table = rows((await client.get(f"{BASE}/{body['setId']}/download",
                                   params={"token": body["downloadToken"]})).text)
    assert table[1][9:] == ["", "", "", "", ""]
    lineage = (await resolve(client, LINEAGE, includeEdges=True)).json()
    edges = rows((await client.get(f"{BASE}/{lineage['setId']}/download",
                                   params={"token": lineage["downloadToken"], "part": "edges"})).text)
    into_seed = next(e for e in edges[1:] if e[:2] == ["src1", "col_a1"])
    # Each end's name and type are the set's own; where it sits, the graph couldn't say.
    assert into_seed[3:5] == ["src1", "thing"] and into_seed[10:12] == ["col_a1", "thing"]
    assert into_seed[12:] == ["", "", "", "", ""]


END = ["Name", "Type", "ParentUrn", "ParentName", "ParentType", "Path", "PathUrns"]


async def test_edges_are_their_own_part(client):
    """Each flow with both its ends — what each is, and where it sits — so it reads
    without a join; ``source, target, type`` first, as before."""
    body = (await resolve(client, LINEAGE, includeEdges=True)).json()
    url, token = f"{BASE}/{body['setId']}/download", body["downloadToken"]
    edges = rows((await client.get(url, params={"token": token, "part": "edges"})).text)
    assert edges[0] == ["source", "target", "type", *(f"source{c}" for c in END), *(f"target{c}" for c in END)]
    assert sorted(tuple(e[:3]) for e in edges[1:]) == [("src1", "col_a1", "FLOWS_TO"), ("src2", "src1", "FLOWS_TO"),
                                                       ("src3", "src2", "FLOWS_TO")]
    into_seed = next(e for e in edges[1:] if e[:2] == ["src1", "col_a1"])
    # src1 is at the top of the graph; col_a1 is in tbl_a, in dom.
    assert into_seed[3:] == ["src1", "thing", "", "", "", "", "",
                             "col_a1", "thing", "tbl_a", "tbl_a", "thing", "dom / tbl_a", "dom; tbl_a"]
    lines = (await client.get(url, params={"token": token, "part": "edges", "format": "ndjson"})).text.splitlines()
    flow = next(json.loads(line) for line in lines if json.loads(line)["target"] == "col_a1")
    assert (flow["targetPath"], flow["targetPathUrns"], flow["sourcePath"]) == (["dom", "tbl_a"], ["dom", "tbl_a"], [])
    doc = (await client.get(url, params={"token": token, "format": "json"})).json()
    assert next(e for e in doc["edges"] if e["target"] == "col_a1")["targetParentName"] == "tbl_a"
    refused = await client.get(url, params={"token": token, "part": "edges", "format": "json"})
    assert refused.status_code == 422


async def test_csv_cells_never_run_as_formulas(client):
    client.state.engine = FormulaNames()
    body = (await resolve(client, {"seeds": {"urns": ["col_a1"]}})).json()
    file = await client.get(f"{BASE}/{body['setId']}/download", params={"token": body["downloadToken"]})
    row = rows(file.text)[1]
    assert row[1] == "'=HYPERLINK(\"http://x\")" and row[2] == "'@thing"


# ── Finding, continuing and refusing a set ──────────────────────────────────


async def test_a_set_takes_as_many_requests_as_it_takes(client):
    started = (await client.post(URL, json={"spec": LINEAGE, "waitMs": 0})).json()
    assert (started["status"], started["stage"]) == ("running", "seeds")
    assert started.get("downloadToken") is None

    shared = (await client.post(URL, json={"spec": LINEAGE, "waitMs": 0})).json()
    assert shared["setId"] == started["setId"]            # everyone asking shares one set

    done = (await resolve(client, LINEAGE, setId=started["setId"])).json()
    assert done["setId"] == started["setId"] and done["status"] == "complete"


async def test_a_set_the_data_moved_past_finishes_for_those_following_it(client, data_version):
    first = (await client.post(URL, json={"spec": LINEAGE, "waitMs": 0})).json()
    data_version["now"] = "8.g"
    followed = (await resolve(client, LINEAGE, setId=first["setId"])).json()
    assert followed["setId"] == first["setId"] and followed["dataVersion"] == "7.g"
    fresh = (await client.post(URL, json={"spec": LINEAGE, "waitMs": 0})).json()
    assert fresh["setId"] != first["setId"] and fresh["dataVersion"] == "8.g"


async def test_a_set_no_longer_kept_is_gone(client):
    resp = await resolve(client, LINEAGE, setId="ms_nothing")
    assert resp.status_code == 404
    assert resp.json()["detail"]["reason"] == "set_expired"
    listed = await client.get(f"{BASE}/ms_nothing/members")
    assert listed.status_code == 404


async def test_a_set_id_is_one_questions(client):
    first = (await client.post(URL, json={"spec": LINEAGE, "waitMs": 0})).json()
    other = {"seeds": {"urns": ["col_a1"]}, "expand": {"upstream": 1}}
    resp = await resolve(client, other, setId=first["setId"])
    assert resp.status_code == 409
    assert resp.json()["detail"]["reason"] == "set_mismatch"
    with_edges = await resolve(client, LINEAGE, setId=first["setId"], includeEdges=True)
    assert with_edges.status_code == 409


async def test_a_graph_without_the_walk_says_so_every_time(client):
    client.state.engine = NoWalk()
    assert (await resolve(client, LINEAGE)).status_code == 501
    assert (await resolve(client, LINEAGE)).status_code == 501   # a failed set is asked afresh


# ── A download link: one set, one person, one purpose ───────────────────────


async def test_a_download_link_is_for_the_person_it_was_issued_to(client):
    from backend.auth_service.core import config as auth_config

    body = (await resolve(client, LINEAGE)).json()
    url = f"{BASE}/{body['setId']}/download"
    someone_else = mint_download_token(body["setId"], "k", "usr_other", auth_config.JWT_SECRET_KEY,
                                       purpose=MEMBER_SET)
    resp = await client.get(url, params={"token": someone_else})
    assert resp.status_code == 403 and resp.json()["detail"]["reason"] == "link_expired"
    another_set = await client.get(f"{BASE}/ms_other/download", params={"token": body["downloadToken"]})
    assert another_set.status_code == 403


async def test_a_download_link_opens_only_what_it_was_issued_for(client):
    from backend.auth_service.core import config as auth_config

    body = (await resolve(client, LINEAGE)).json()
    ms = await graph_member_sets.sets.get(client.state.engine._db_session, body["setId"])
    principal = "usr_test000000"
    search_token = mint_download_token(body["setId"], ms.key, principal, auth_config.JWT_SECRET_KEY)
    resp = await client.get(f"{BASE}/{body['setId']}/download", params={"token": search_token})
    assert resp.status_code == 403

    # ... and a member set's link opens no search export.
    with pytest.raises(HTTPException) as exc:
        await graph_mod.search_export_download(
            session_id=body["setId"], token=body["downloadToken"], ws_id="test-ws",
            session=None, gate=None, user=SimpleNamespace(id=principal))
    assert exc.value.status_code == 403

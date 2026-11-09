"""The change-list routes (``/graphs/{gid}/diff/*``) and the history calendar, against a fake
service: what an origin is (a draft, or two revisions of main — exactly one), what reaches the
service, and the shapes the Changes list, the revision summary and the canvas read.

What the service computes is covered against Postgres in
``integration/test_versioning_change_index.py``."""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.services.versioning.change_index import ChangeOrigin
from backend.app.services.versioning.errors import ChangeListBusy

BASE = "/api/v1/ws1/versioning/graphs/g1"
NONE = {"added": 0, "modified": 0, "removed": 0}


def _summary(origin: ChangeOrigin, **extra) -> dict:
    return {"origin": origin.as_dict(), "counts": {**NONE, "added": 2},
            "entityCounts": {**NONE, "added": 1}, "edgeCounts": {**NONE, "added": 1},
            "structureCounts": NONE, "impact": {"Table": 1},
            "byType": [{"kind": "node", "type": "Table", **NONE, "added": 1}],
            "total": 2, "listed": 2, "approximate": False, "tooLarge": None, "window": None,
            **extra}


class _Versioning:
    calls: list = []
    busy = False

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1",
                "provider_id": None}

    async def change_summary(self, **kw):
        _Versioning.calls.append(("summary", kw))
        if _Versioning.busy:
            raise ChangeListBusy()
        origin = kw["origin"]
        if origin.branch_id is None:
            return _summary(origin, window={
                "commitCount": 2, "contributors": ["u1"], "contributorCount": 1,
                "firstAt": "2026-10-01T10:00:00+00:00", "lastAt": "2026-10-31T17:42:00+00:00",
                "from": {"seq": 3, "commitId": "cmt_3", "kind": "squash_publish",
                         "message": "before", "actor": "u1", "createdAt": "2026-09-30T09:00:00+00:00"},
                "to": {"seq": 5, "commitId": "cmt_5", "kind": "import", "message": None,
                       "actor": "u1", "createdAt": "2026-10-31T17:42:00+00:00"}})
        return _summary(origin)

    async def change_entries(self, **kw):
        _Versioning.calls.append(("entries", kw))
        return {"entries": [
            {"entityId": "n1", "kind": "node", "status": "added", "type": "Table",
             "structural": False, "displayName": "orders", "qualifiedName": "db.orders",
             "urn": "urn:orders"},
            {"entityId": "e1", "kind": "edge", "status": "removed", "type": "FLOWS_TO",
             "structural": False, "sourceEntityId": "n1", "targetEntityId": "n2",
             "sourceName": "orders", "targetName": None}],
            "total": 7, "offset": kw["offset"], "limit": kw["limit"], "hasMore": True,
            "tooLarge": None}

    async def change_entry(self, **kw):
        _Versioning.calls.append(("entry", kw))
        return {"entityId": kw["entity_id"], "kind": "node", "status": "modified",
                "before": {"name": "a"}, "after": {"name": "b"}}

    async def change_index_compact(self, **kw):
        _Versioning.calls.append(("index", kw))
        return {"origin": kw["origin"].as_dict(), "total": 2, "truncated": False,
                "entries": [["n1", "n", "a", "Table"], ["e1", "e", "r", "FLOWS_TO", "n1", "n2"]]}

    async def history_months(self, **kw):
        _Versioning.calls.append(("months", kw))
        if kw["tz"] == "Mars/Olympus":
            raise ValueError("unknown time zone 'Mars/Olympus'")
        return {"headSeq": 9, "tz": kw["tz"], "months": [
            {"month": "2026-10", "count": 3, "firstSeq": 4, "lastSeq": 9,
             "lastAt": "2026-10-31T23:30:00+00:00",
             "days": [{"day": "2026-10-01", "count": 1, "firstSeq": 4, "lastSeq": 4},
                      {"day": "2026-10-31", "count": 2, "firstSeq": 5, "lastSeq": 9}]}]}


@pytest.fixture
def versioning():
    from backend.app.main import app

    _Versioning.calls = []
    _Versioning.busy = False
    app.dependency_overrides[get_versioning_service] = _Versioning
    yield _Versioning
    app.dependency_overrides.pop(get_versioning_service, None)


@pytest.mark.parametrize("params", [
    {},                                                     # nothing named
    {"branchId": "br_1", "fromSeq": 1, "toSeq": 2},         # both
    {"fromSeq": 3},                                          # half a window
    {"toSeq": 3},
    {"fromSeq": 3, "toSeq": 3},                              # an empty window
    {"fromSeq": 4, "toSeq": 3},                              # backwards
])
async def test_an_origin_is_a_draft_or_two_revisions_never_both(test_client, versioning, params):
    for path in ("/diff/summary", "/diff/entries", "/diff/index", "/diff/entries/n1"):
        r = await test_client.get(f"{BASE}{path}", params=params)
        assert r.status_code == 422, (path, params, r.text)
    assert versioning.calls == []


async def test_a_drafts_summary(test_client, versioning):
    r = await test_client.get(f"{BASE}/diff/summary", params={"branchId": "br_1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["origin"] == {"branchId": "br_1"}
    assert body["counts"] == {**NONE, "added": 2} and body["listed"] == 2
    assert body["byType"] == [{"kind": "node", "type": "Table", **NONE, "added": 1}]
    assert body["window"] is None and body["tooLarge"] is None
    (name, kw), = versioning.calls
    assert name == "summary" and kw["origin"] == ChangeOrigin(branch_id="br_1")
    assert kw["viewer"] is not None


async def test_a_windows_summary_names_its_revisions(test_client, versioning):
    r = await test_client.get(f"{BASE}/diff/summary", params={"fromSeq": 3, "toSeq": 5})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["origin"] == {"fromSeq": 3, "toSeq": 5}
    window = body["window"]
    assert window["commitCount"] == 2 and window["contributors"] == ["u1"]
    assert window["from"]["commitId"] == "cmt_3" and window["to"]["seq"] == 5
    assert "userNames" in body
    assert versioning.calls[0][1]["origin"] == ChangeOrigin(from_seq=3, to_seq=5)


async def test_entries_pass_their_filters_and_page(test_client, versioning):
    r = await test_client.get(f"{BASE}/diff/entries", params={
        "branchId": "br_1", "kind": "edge", "status": "added,removed", "type": "FLOWS_TO",
        "q": "ord", "offset": 100, "limit": 50})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 7 and body["hasMore"] is True and body["offset"] == 100
    edge = body["entries"][1]
    assert edge["sourceName"] == "orders" and edge["targetEntityId"] == "n2"
    (_n, kw), = versioning.calls
    assert (kw["kind"], kw["statuses"], kw["type_"], kw["q"], kw["offset"], kw["limit"]) == (
        "edge", ("added", "removed"), "FLOWS_TO", "ord", 100, 50)


@pytest.mark.parametrize("params", [
    {"status": "added,renamed"},
    {"kind": "column"},
    {"limit": 501},
    {"offset": -1},
])
async def test_entries_refuse_what_they_do_not_page_by(test_client, versioning, params):
    r = await test_client.get(f"{BASE}/diff/entries", params={"branchId": "br_1", **params})
    assert r.status_code == 422, (params, r.text)


async def test_one_entry_before_and_after(test_client, versioning):
    r = await test_client.get(f"{BASE}/diff/entries/n7", params={"fromSeq": 1, "toSeq": 9})
    assert r.status_code == 200, r.text
    assert r.json() == {"entityId": "n7", "kind": "node", "status": "modified",
                        "before": {"name": "a"}, "after": {"name": "b"}}
    assert versioning.calls[0][1]["entity_id"] == "n7"


async def test_the_compact_index(test_client, versioning):
    r = await test_client.get(f"{BASE}/diff/index", params={"branchId": "br_1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["truncated"] is False and body["total"] == 2
    assert body["entries"][1] == ["e1", "e", "r", "FLOWS_TO", "n1", "n2"]


async def test_the_compact_index_is_capped_only_when_asked(test_client, versioning):
    for params in ({"fromSeq": 3, "toSeq": 9, "max": 20000}, {"fromSeq": 3, "toSeq": 9}):
        r = await test_client.get(f"{BASE}/diff/index", params=params)
        assert r.status_code == 200, r.text
    assert [kw["max_entries"] for _n, kw in versioning.calls] == [20000, None]
    r = await test_client.get(f"{BASE}/diff/index", params={"fromSeq": 3, "toSeq": 9, "max": -1})
    assert r.status_code == 422, r.text


async def test_a_list_that_takes_too_long_is_a_retryable_busy(test_client, versioning):
    versioning.busy = True
    r = await test_client.get(f"{BASE}/diff/summary", params={"branchId": "br_1"})
    assert r.status_code == 503, r.text
    assert r.json()["detail"]["type"] == "change_list_busy"
    assert r.headers["Retry-After"] == "5"


async def test_history_months_in_the_readers_time_zone(test_client, versioning):
    r = await test_client.get(f"{BASE}/history/months",
                              params={"tz": "Europe/Berlin", "originatingViewId": "view_1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["headSeq"] == 9 and body["months"][0]["lastSeq"] == 9
    assert [d["day"] for d in body["months"][0]["days"]] == ["2026-10-01", "2026-10-31"]
    (_n, kw), = versioning.calls
    assert kw == {"graph_id": "g1", "tz": "Europe/Berlin", "originating_view_id": "view_1"}


async def test_history_months_refuse_an_unknown_time_zone(test_client, versioning):
    r = await test_client.get(f"{BASE}/history/months", params={"tz": "Mars/Olympus"})
    assert r.status_code == 404, r.text

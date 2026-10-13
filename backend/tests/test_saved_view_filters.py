"""Saved filters (``/api/v1/views/saved-filters``): a person's named Explorer
filter sets, on the server.

The client is ``frontend/src/services/savedViewFiltersService.ts``; the
Explorer shows a 409's ``detail`` verbatim under the name field, so those
sentences are pinned word for word. ``test_client`` signs in as the platform
admin — whose filters are as private as anyone's.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy.exc import IntegrityError

from backend.app.db.models import SavedViewFilterORM
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user

BASE = "/api/v1/views/saved-filters"
BOB = _user("usr_bob_filters")
BOB_CLAIMS = PermissionClaims(sid="s_bob_filters")


async def _create(client: AsyncClient, name: str, query: str = "") -> dict:
    resp = await client.post(BASE, json={"name": name, "query": query})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _listed(client: AsyncClient) -> list:
    resp = await client.get(BASE)
    assert resp.status_code == 200, resp.text
    return [(f["name"], f["position"]) for f in resp.json()]


async def test_create_list_rename_requery_reorder_delete(test_client: AsyncClient):
    assert (await test_client.get(BASE)).json() == []
    mine = await _create(test_client, "  Mine  ", "createdBy=me&sort=newest")
    assert set(mine) == {"id", "name", "query", "position", "createdAt", "updatedAt"}
    assert mine["id"].startswith("svf_")
    assert (mine["name"], mine["query"], mine["position"]) == ("Mine", "createdBy=me&sort=newest", 0)
    finance = await _create(test_client, "Finance", "tags=finance")
    assert finance["position"] == 1
    assert await _listed(test_client) == [("Mine", 0), ("Finance", 1)]

    renamed = (await test_client.put(f"{BASE}/{mine['id']}", json={"name": "My views"})).json()
    assert (renamed["name"], renamed["query"]) == ("My views", "createdBy=me&sort=newest")
    assert renamed["updatedAt"] >= mine["updatedAt"] and renamed["createdAt"] == mine["createdAt"]
    requeried = (await test_client.put(f"{BASE}/{mine['id']}", json={"query": ""})).json()
    assert (requeried["name"], requeried["query"]) == ("My views", "")

    reordered = await test_client.put(f"{BASE}/order", json={"ids": [finance["id"], mine["id"]]})
    assert reordered.status_code == 200
    assert [(f["name"], f["position"]) for f in reordered.json()] == [("Finance", 0), ("My views", 1)]
    assert await _listed(test_client) == [("Finance", 0), ("My views", 1)]

    resp = await test_client.delete(f"{BASE}/{finance['id']}")
    assert resp.status_code == 204 and resp.content == b""
    assert await _listed(test_client) == [("My views", 0)]


async def test_positions_close_up_after_a_delete(test_client: AsyncClient):
    ids = [(await _create(test_client, name))["id"] for name in "ABCD"]
    assert (await test_client.delete(f"{BASE}/{ids[1]}")).status_code == 204
    assert await _listed(test_client) == [("A", 0), ("C", 1), ("D", 2)]
    # And a new one goes last, after the closed-up list.
    await _create(test_client, "E")
    assert await _listed(test_client) == [("A", 0), ("C", 1), ("D", 2), ("E", 3)]


async def test_duplicate_names_are_refused_ignoring_case(test_client: AsyncClient):
    mine = await _create(test_client, "Mine")
    other = await _create(test_client, "Other")
    taken = 'You already have a saved filter called "Mine".'
    for attempt in (
        test_client.post(BASE, json={"name": " mine ", "query": ""}),
        test_client.put(f"{BASE}/{other['id']}", json={"name": "MINE"}),
    ):
        resp = await attempt
        assert resp.status_code == 409
        assert resp.json() == {"detail": taken}
    # A filter may change the case of its own name.
    resp = await test_client.put(f"{BASE}/{mine['id']}", json={"name": "MINE"})
    assert resp.status_code == 200 and resp.json()["name"] == "MINE"


async def test_thirty_is_the_most(test_client: AsyncClient):
    for i in range(30):
        await _create(test_client, f"Filter {i}")
    resp = await test_client.post(BASE, json={"name": "One more", "query": ""})
    assert resp.status_code == 409
    assert resp.json() == {
        "detail": "You can keep up to 30 saved filters. Delete one to save another.",
    }


@pytest.mark.parametrize("body, says", [
    ({"name": "", "query": ""}, "name must be 1 to 80 characters"),
    ({"name": "   ", "query": ""}, "name must be 1 to 80 characters"),
    ({"name": "x" * 81, "query": ""}, "name must be 1 to 80 characters"),
    ({"name": "ok", "query": "q" * 2001}, "query must be at most 2000 characters"),
])
async def test_names_and_queries_are_checked(test_client: AsyncClient, body, says):
    resp = await test_client.post(BASE, json=body)
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], str) and says in resp.json()["detail"]
    created = await _create(test_client, "fine")
    resp = await test_client.put(f"{BASE}/{created['id']}", json=body)
    assert resp.status_code == 422 and says in resp.json()["detail"]


async def test_the_limits_themselves_are_fine(test_client: AsyncClient):
    longest = await _create(test_client, "x" * 80, "q" * 2000)
    assert len(longest["name"]) == 80 and len(longest["query"]) == 2000
    # An empty query is a filter for all views.
    assert (await _create(test_client, "All views", ""))["query"] == ""


async def test_a_reorder_must_name_every_filter_once(test_client: AsyncClient):
    a, b, c = [(await _create(test_client, name))["id"] for name in "ABC"]
    with _auth(user=BOB, claims=BOB_CLAIMS):
        bobs = await _create(test_client, "Bob's")
    for ids in (
        [a, b],                       # one missing
        [a, b, c, "svf_nonexistent"],  # one extra
        [a, b, c, c],                 # one twice
        [a, b, bobs["id"]],           # someone else's in place of one
    ):
        resp = await test_client.put(f"{BASE}/order", json={"ids": ids})
        assert resp.status_code == 422, ids
        assert resp.json() == {
            "detail": "List each of your saved filters exactly once, in the new order.",
        }
    assert await _listed(test_client) == [("A", 0), ("B", 1), ("C", 2)]


async def test_one_person_never_reaches_anothers_filters(test_client: AsyncClient):
    ours = await _create(test_client, "Admin's own", "tags=finance")
    with _auth(user=BOB, claims=BOB_CLAIMS):
        assert (await test_client.get(BASE)).json() == []
        bobs = await _create(test_client, "Admin's own")      # names are per person
        missing = await test_client.put(f"{BASE}/svf_nonexistent", json={"name": "x"})
        for resp in (
            await test_client.put(f"{BASE}/{ours['id']}", json={"name": "Taken over"}),
            await test_client.put(f"{BASE}/{ours['id']}", json={"name": ""}),
            await test_client.delete(f"{BASE}/{ours['id']}"),
        ):
            # Exactly what an id nobody has gets: nothing says whose it is.
            assert resp.status_code == 404
            assert resp.json() == missing.json() == {"detail": "Saved filter not found"}
        assert [f["id"] for f in (await test_client.get(BASE)).json()] == [bobs["id"]]
    # The platform admin is no exception either way.
    listed = (await test_client.get(BASE)).json()
    assert [(f["id"], f["name"]) for f in listed] == [(ours["id"], "Admin's own")]
    assert (await test_client.delete(f"{BASE}/{bobs['id']}")).status_code == 404


async def test_signed_out_is_401(test_client: AsyncClient):
    with _auth(user=None, claims=None):
        assert (await test_client.get(BASE)).status_code == 401
        assert (await test_client.post(BASE, json={"name": "x", "query": ""})).status_code == 401


async def test_mounted_before_the_view_routes(test_client: AsyncClient):
    """Routes match in the order they were included: mounted after the views
    router, ``GET /views/{view_id}`` would take this path first and answer that
    no view called "saved-filters" exists."""
    resp = await test_client.get(BASE)
    assert resp.status_code == 200, resp.text
    assert resp.json() == []


async def test_the_table_holds_names_unique_per_person(db_session):
    """The database's own guard is the exact spelling, per person; the
    case-insensitive comparison is the repository's check before it writes."""
    db_session.add(SavedViewFilterORM(user_id="usr_a", name="Mine", query="", position=0))
    db_session.add(SavedViewFilterORM(user_id="usr_b", name="Mine", query="", position=0))
    db_session.add(SavedViewFilterORM(user_id="usr_a", name="mine", query="", position=1))
    await db_session.flush()
    db_session.add(SavedViewFilterORM(user_id="usr_a", name="Mine", query="", position=2))
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


async def test_a_race_past_the_check_is_the_same_refusal(test_client: AsyncClient, monkeypatch):
    """Two requests racing to one name both pass the check; the second write
    hits the table's constraint and gets the same 409, the session intact."""
    from backend.app.db.repositories import saved_view_filter_repo

    await _create(test_client, "Racing")
    monkeypatch.setattr(saved_view_filter_repo, "_check_unused", lambda *a, **k: None)
    resp = await test_client.post(BASE, json={"name": "Racing", "query": ""})
    assert resp.status_code == 409
    assert resp.json() == {"detail": 'You already have a saved filter called "Racing".'}
    assert await _listed(test_client) == [("Racing", 0)]

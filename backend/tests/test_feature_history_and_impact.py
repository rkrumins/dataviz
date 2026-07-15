"""Who turned it off — and what it would actually touch.

Two gaps, both of which made the Features page ask an admin to decide something it refused to tell
them anything about.

HISTORY. The page could say a flag was off. It could not say who turned it off, when, or what it
was before — `feature_flags` carries a value and a version and nothing else. On a surface where any
admin can silently take a capability away from every user, "someone, at some point" is not an answer
to the only question anyone asks when something stops working.

IMPACT. The dialog described what a feature does when it's off, in a sentence from a config file
that reads identically on an estate of four views and one of four thousand. What decides the
question is a count against YOUR estate — and the database knew it all along.

The sharpest test in here is the last one: a flag with no honest count must return `known: false`,
NOT an empty list. "We didn't measure" and "we measured nothing" look the same on a screen, and
collapsing them is how a confirmation dialog ends up reassuring somebody about a blast radius it
never looked at.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import view_repo
from backend.common.models.management import ViewCreateRequest


@pytest.fixture
async def seeded_registry(db_session: AsyncSession):
    from backend.app.db.seed_feature_registry import seed_feature_flags, seed_feature_registry

    await seed_feature_registry(db_session)
    await seed_feature_flags(db_session)
    await db_session.commit()


async def _patch(client: AsyncClient, **values) -> dict:
    current = await client.get("/api/v1/admin/features")
    version = current.json()["version"]
    resp = await client.patch("/api/v1/admin/features", json={"version": version, **values})
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── history ───────────────────────────────────────────────────────────────────

async def test_a_change_records_who_did_it_and_what_moved(
    test_client: AsyncClient, seeded_registry,
):
    body = await _patch(test_client, traceEnabled=False)

    last = body["lastChanges"]["traceEnabled"]
    assert last["from"] is True
    assert last["to"] is False
    assert last["actorId"] == "usr_test000000"
    assert last["actorName"]  # the conftest user has a name; never blank
    assert last["at"]


async def test_only_the_keys_that_MOVED_are_recorded(
    test_client: AsyncClient, seeded_registry,
):
    """The payload is a full merged config, so a naive log would write a row per flag on every
    save — eleven of twelve saying nothing happened. A history where most entries are noise is a
    history nobody reads."""
    await _patch(test_client, traceEnabled=False)

    resp = await test_client.get("/api/v1/admin/features/traceEnabled/history")
    assert resp.status_code == 200
    assert len(resp.json()["history"]) == 1

    # editModeEnabled was in the same PATCH's merged config, untouched.
    untouched = await test_client.get("/api/v1/admin/features/editModeEnabled/history")
    assert untouched.json()["history"] == []


async def test_history_is_newest_first_and_keeps_the_whole_story(
    test_client: AsyncClient, seeded_registry,
):
    await _patch(test_client, traceEnabled=False)
    await _patch(test_client, traceEnabled=True)

    history = (await test_client.get("/api/v1/admin/features/traceEnabled/history")).json()["history"]
    assert len(history) == 2
    assert history[0]["to"] is True and history[0]["from"] is False   # newest
    assert history[1]["to"] is False and history[1]["from"] is True   # the original


async def test_the_page_gets_every_flags_last_change_in_ONE_request(
    test_client: AsyncClient, seeded_registry,
):
    """Twelve round-trips to render a line of text each is how a settings page ends up feeling slow
    for no reason a user could name."""
    await _patch(test_client, traceEnabled=False)
    await _patch(test_client, signupEnabled=True)

    body = (await test_client.get("/api/v1/admin/features")).json()
    assert set(body["lastChanges"]) == {"traceEnabled", "signupEnabled"}


# ── impact ────────────────────────────────────────────────────────────────────

async def _workspace(client: AsyncClient) -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": "Impact", "dataSources": []})
    assert resp.status_code == 201
    return resp.json()["id"]


async def test_withdrawing_a_layout_counts_the_views_already_built_in_it(
    test_client: AsyncClient, db_session: AsyncSession, seeded_registry,
):
    """The fact that most changes the decision, and the one the page never showed.

    An admin withdrawing a layout wants to know how much of the estate is already built in it. It
    was always a GROUP BY away.
    """
    ws = await _workspace(test_client)
    for name, view_type in [("A", "graph"), ("B", "graph"), ("C", "hierarchy")]:
        await view_repo.create_view(
            db_session,
            ViewCreateRequest(name=name, workspace_id=ws, view_type=view_type, visibility="private"),
            user_id="u1",
        )
    await db_session.commit()

    resp = await test_client.get("/api/v1/admin/features/allowedViewModes/impact")
    assert resp.status_code == 200
    body = resp.json()

    assert body["known"] is True
    fact = body["facts"][0]
    assert fact["count"] == 3
    assert sorted(fact["detail"]) == sorted(["2 × graph", "1 × hierarchy"])
    # It must not frighten anyone: withdrawing a layout does NOT touch the views already in it.
    assert fact["tone"] == "neutral"
    assert "keep working" in fact["consequence"].lower()


async def test_an_empty_estate_is_KNOWN_and_empty_not_unknown(
    test_client: AsyncClient, seeded_registry,
):
    """"There is nothing to affect" is a real, reassuring answer. It has to be distinguishable from
    "we didn't look"."""
    resp = await test_client.get("/api/v1/admin/features/allowedViewModes/impact")
    body = resp.json()
    assert body["known"] is True
    assert body["facts"] == []


async def test_a_flag_with_NO_honest_count_says_so_instead_of_inventing_one(
    test_client: AsyncClient, seeded_registry,
):
    """The whole point of the design.

    `traceEnabled` has no usage telemetry behind it, so there is no truthful answer to "how many
    people would lose trace". The probe therefore returns `known: false` — NOT an empty list, which
    the UI would render as "nothing would be affected". A number on a confirmation screen is read as
    a fact about the world; an invented one is worse than silence.
    """
    resp = await test_client.get("/api/v1/admin/features/traceEnabled/impact")
    body = resp.json()

    assert body["known"] is False, "an unmeasured flag must not masquerade as a harmless one"
    assert body["facts"] == []


async def test_an_unknown_key_is_unknown_not_empty(test_client: AsyncClient, seeded_registry):
    body = (await test_client.get("/api/v1/admin/features/notAFlag/impact")).json()
    assert body["known"] is False

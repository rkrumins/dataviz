"""A view made from a query's members: worked out a page at a time, swapped in whole.

The graph is the membership resolver's (``tests/fixtures/membership_graph.py``), typed as in
``test_views_from_members_api.py``. A run writes its members at its own epoch and readers see
``members_epoch`` until the run applies its answer, in one commit; a run that stopped
mid-page — its request gone — is carried on by the next request at the same epoch, and a
run overtaken writes nothing more. What is tested here is the member table across those
steps: what readers see, what each epoch holds, and that the page size changes nothing.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import view_membership as routes
from backend.app.db.models import ViewMemberORM, ViewMembershipStateORM
from backend.app.services.live_views import pipeline
from backend.app.services.member_sets import sweeper
from backend.tests.test_views_from_members_api import (  # noqa: F401 — fixtures
    TypedEngine,
    body,
    graph,
    members_of,
    membership_on,
    source_view,
    workspace,
)

pytestmark = pytest.mark.usefixtures("membership_on")


class Crash(BaseException):
    """The request's process went away mid-run: nothing after this point happens."""


async def make(client: AsyncClient, **overrides) -> str:
    ws = await workspace(client)
    src = await source_view(client, ws)
    resp = await client.post("/api/v1/views/from-members", json=body(ws, src, **overrides))
    assert resp.status_code == 201, resp.text
    return resp.json()["view"]["id"]


async def run(db_session: AsyncSession, view_id: str, *, owner: str = "test", budget_s: float = 30, **kw):
    from backend.app.main import app

    return await pipeline.refresh(view_id, session=db_session, owner=owner, budget_s=budget_s,
                                  engine_scope=app.dependency_overrides[routes.get_engine_scope](), **kw)


async def state_of(db_session: AsyncSession, view_id: str) -> ViewMembershipStateORM:
    return (await db_session.execute(select(ViewMembershipStateORM).where(
        ViewMembershipStateORM.view_id == view_id).execution_options(populate_existing=True))).scalar_one()


async def at(db_session: AsyncSession, view_id: str, epoch: int) -> int:
    return (await db_session.execute(select(func.count()).select_from(ViewMemberORM).where(
        ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == epoch))).scalar_one()


async def let_go(db_session: AsyncSession, view_id: str) -> None:
    """Its lease runs out: the request that held it is gone."""
    await db_session.execute(update(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
                             .values(lease_until="2000-01-01T00:00:00+00:00"))
    await db_session.commit()


def crash_after(monkeypatch, pages: int):
    """The run's request dies as it starts page ``pages + 1``."""
    real = pipeline.read_page
    read = {"n": 0}

    async def read_page(*args, **kwargs):
        if read["n"] >= pages:
            raise Crash()
        read["n"] += 1
        return await real(*args, **kwargs)

    monkeypatch.setattr(pipeline, "read_page", read_page)
    return lambda: monkeypatch.setattr(pipeline, "read_page", real)


@pytest.fixture()
def data(monkeypatch):
    """The graph's data version as the pipeline reads it (a member set is kept per version)."""
    class Data:
        version = "v1"

    async def version(engine):
        return Data.version

    monkeypatch.setattr(pipeline, "search_data_version", version)
    return Data


# ── Readers see the last answer until the swap; a run outlives its request ──


async def test_readers_see_the_last_answer_until_a_run_carried_on_at_its_epoch_swaps_it_in(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    view_id = await make(test_client)
    before = await state_of(db_session, view_id)
    first, revision = before.members_epoch, before.revision
    assert len(await members_of(db_session, view_id)) == 6

    graph.engine = TypedEngine(gone={"col_b1"})
    restore = crash_after(monkeypatch, 1)
    with pytest.raises(Crash):
        await run(db_session, view_id, page_size=2)
    await db_session.rollback()
    mid = await state_of(db_session, view_id)
    assert mid.members_epoch == first and mid.epoch == first + 1
    assert await at(db_session, view_id, mid.epoch) == 2, "one page placed, at the run's own epoch"
    assert "col_b1" in await members_of(db_session, view_id), "readers still see the last answer"

    restore()
    held = await run(db_session, view_id, page_size=2)
    assert (held.outcome, held.detail) == ("running", {"reason": "busy"}), "its lease still holds it: ask again"
    await let_go(db_session, view_id)
    out = await run(db_session, view_id, page_size=2)
    assert (out.outcome, out.diff["removed"]) == ("applied", 1)
    after = await state_of(db_session, view_id)
    assert after.epoch == mid.epoch == after.members_epoch, "carried on, never started again"
    assert set(await members_of(db_session, view_id)) == {"dom", "tbl_a", "tbl_b", "col_a1", "col_a2"}
    assert await at(db_session, view_id, first) == 0, "the last answer is let go once the new one is in"
    assert after.materialize is None and after.revision == revision + 1


async def test_a_run_overtaken_mid_run_writes_nothing_more(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    view_id = await make(test_client)
    graph.engine = TypedEngine(gone={"col_b1"})
    real = pipeline.read_page
    read = {"n": 0}

    async def read_page(*args, **kwargs):
        read["n"] += 1
        if read["n"] == 2:
            # Its lease ran out while it was slow, and another request took the view.
            await db_session.execute(update(ViewMembershipStateORM).where(
                ViewMembershipStateORM.view_id == view_id).values(lease_owner="someone-else"))
            await db_session.commit()
        return await real(*args, **kwargs)

    monkeypatch.setattr(pipeline, "read_page", read_page)
    out = await run(db_session, view_id, page_size=2)
    assert out.outcome == "fenced"
    state = await state_of(db_session, view_id)
    assert await at(db_session, view_id, state.epoch) == 2, "its second page was rolled back"
    assert len(await members_of(db_session, view_id)) == 6


# ── What an answer does to the members readers see ─────────────────────────


async def test_nothing_changed_keeps_the_epoch_and_lets_the_new_rows_go(
    test_client: AsyncClient, db_session: AsyncSession, graph,
):
    view_id = await make(test_client)
    first = (await state_of(db_session, view_id)).members_epoch
    out = await run(db_session, view_id)
    assert out.outcome == "unchanged"
    state = await state_of(db_session, view_id)
    assert state.members_epoch == first and state.epoch == first + 1
    assert await at(db_session, view_id, state.epoch) == 0


async def test_what_a_member_is_drawn_inside_is_a_change_of_its_own(
    test_client: AsyncClient, db_session: AsyncSession, graph,
):
    """Members placed before what they sit inside was counted (or as it was then): the
    next answer changes nothing else, and is swapped in all the same."""
    view_id = await make(test_client, layout={"kind": "auto"})
    first = (await state_of(db_session, view_id)).members_epoch

    async def drawn_inside(epoch: int) -> dict:
        return dict((await db_session.execute(select(ViewMemberORM.urn, ViewMemberORM.in_layer).where(
            ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == epoch))).all())

    counted = await drawn_inside(first)
    assert (counted["dom"], counted["tbl_a"], counted["col_a1"]) == (0, 1, 2), "inside its table and its domain"
    await db_session.execute(update(ViewMemberORM).where(ViewMemberORM.view_id == view_id).values(in_layer=0))
    await db_session.commit()
    out = await run(db_session, view_id)
    assert out.outcome == "applied"
    assert (out.diff["added"], out.diff["removed"], out.diff["moved"]) == (0, 0, 0)
    state = await state_of(db_session, view_id)
    assert state.members_epoch == first + 1 and await drawn_inside(state.members_epoch) == counted


async def test_over_the_limit_is_known_before_anything_is_placed(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    view_id = await make(test_client)
    monkeypatch.setattr(pipeline, "entry_limit", lambda: 3)
    graph.engine = TypedEngine(gone={"col_b1"})
    out = await run(db_session, view_id)
    assert (out.outcome, out.detail["members"], out.detail["limit"]) == ("over_cap", 5, 3)
    state = await state_of(db_session, view_id)
    assert await at(db_session, view_id, state.epoch) == 0, "not one row placed"
    assert len(await members_of(db_session, view_id)) == 6, "the last good members stay"


async def test_a_held_removal_keeps_its_rows_unswapped_and_confirming_applies_them(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    monkeypatch.setattr(pipeline, "MASS_REMOVAL_MIN", 3)
    view_id = await make(test_client)
    first = (await state_of(db_session, view_id)).members_epoch
    graph.engine = TypedEngine(gone={"tbl_a", "col_a1", "col_a2", "tbl_b", "col_b1"})
    held = await run(db_session, view_id)
    assert (held.outcome, held.detail["removed"], held.detail["of"]) == ("held", 5, 6)
    state = await state_of(db_session, view_id)
    assert state.members_epoch == first and await at(db_session, view_id, state.epoch) == 1
    assert len(await members_of(db_session, view_id)) == 6

    out = await run(db_session, view_id, confirm_removals=True)
    assert out.outcome == "applied"
    after = await state_of(db_session, view_id)
    assert after.members_epoch == state.epoch, "the held answer, as it was placed"
    assert set(await members_of(db_session, view_id)) == {"dom"}


async def test_kept_out_and_always_included_leave_the_members_at_once(
    test_client: AsyncClient, db_session: AsyncSession, graph,
):
    view_id = await make(test_client)
    url = f"/api/v1/views/{view_id}/membership/members"
    config = (await test_client.get(f"/api/v1/views/{view_id}")).json()["config"]
    tables = next(l["id"] for l in config["layout"]["referenceLayout"]["layers"] if l["name"] == "Tables")
    assert (await test_client.post(url, json={"exclude": ["col_a1"]})).status_code == 200
    assert (await test_client.post(url, json={"include": [{"urn": "col_a2", "layerId": tables}]})).status_code == 200
    assert set(await members_of(db_session, view_id)) == {"dom", "tbl_a", "tbl_b", "col_b1"}
    state = await state_of(db_session, view_id)
    assert state.member_count == 4

    graph.engine = TypedEngine(gone={"col_b1"})
    assert (await run(db_session, view_id)).outcome == "applied"
    assert set(await members_of(db_session, view_id)) == {"dom", "tbl_a", "tbl_b"}, (
        "kept out whatever the query finds; a person's own entry is never a member")


async def test_a_snapshot_keeps_its_members(test_client: AsyncClient, db_session: AsyncSession, graph):
    view_id = await make(test_client, mode="snapshot")
    state = await state_of(db_session, view_id)
    assert (state.status, len(await members_of(db_session, view_id))) == ("frozen", 6)
    graph.engine = TypedEngine(gone={"col_b1"})
    with pytest.raises(pipeline.PipelineError) as refused:
        await run(db_session, view_id)
    assert refused.value.kind == "frozen"
    assert (await state_of(db_session, view_id)).members_epoch == state.members_epoch
    assert "col_b1" in await members_of(db_session, view_id)


# ── The page size changes nothing ───────────────────────────────────────────


async def test_any_page_size_places_the_same_rows(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    sources = [{"spec": {"seeds": {"urns": ["dom"]}, "expand": {"children": 2}}},
               {"spec": {"seeds": {"urns": ["col_a1", "tbl_up"]}, "expand": {"upstream": 2, "downstream": 1,
                                                                             "partnerChildren": 1}}}]

    async def rows(page: int):
        monkeypatch.setattr(pipeline, "PAGE", page)
        view_id = await make(test_client, layout={"kind": "auto"}, sources=sources)
        state = await state_of(db_session, view_id)
        found = (await db_session.execute(select(ViewMemberORM).where(
            ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == state.members_epoch)
            .order_by(ViewMemberORM.ord))).scalars().all()
        config = (await test_client.get(f"/api/v1/views/{view_id}")).json()["config"]
        names = {l["id"]: l["name"] for l in config["layout"]["referenceLayout"]["layers"]}
        return [(r.urn, names[r.layer_id], r.sort_key, r.ord, r.label, r.label_ord, r.via, r.hops, r.whole,
                 r.covered, r.name, r.type) for r in found]

    whole = await rows(1000)
    assert len(whole) >= 10
    assert await rows(1) == whole
    assert await rows(3) == whole


# ── What nobody needs any more is swept ─────────────────────────────────────


async def test_the_sweeper_deletes_epochs_nobody_reads_or_works_on(
    test_client: AsyncClient, db_session: AsyncSession, graph,
):
    view_id = await make(test_client)
    state = await state_of(db_session, view_id)
    current = state.members_epoch
    stray = {"view_id": view_id, "urn": "x", "layer_id": "l", "sort_key": "x", "ord": 0, "label": "",
             "label_ord": 0, "whole": False, "covered": False}
    from backend.app.db.repositories import view_members_repo

    await view_members_repo.insert(db_session, [{**stray, "epoch": current - 1}, {**stray, "epoch": current + 5}])
    state.epoch, state.materialize = current + 5, '{"epoch": %d}' % (current + 5)
    await db_session.commit()
    while await sweeper.sweep_once(db_session):
        await db_session.commit()
    assert await at(db_session, view_id, current - 1) == 0, "an answer since replaced"
    assert await at(db_session, view_id, current + 5) == 1, "the run working on it now keeps its rows"
    assert await at(db_session, view_id, current) == 6, "what readers see is kept"
    state.materialize = None
    await db_session.commit()
    while await sweeper.sweep_once(db_session):
        await db_session.commit()
    assert await at(db_session, view_id, current + 5) == 0, "a run that left its rows behind"

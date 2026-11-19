"""A view made from a query's members: worked out a page at a time, swapped in whole.

The graph is the membership resolver's (``tests/fixtures/membership_graph.py``), typed as in
``test_views_from_members_api.py``. A run writes its members at its own epoch and readers see
``members_epoch`` until the run applies its answer, in one commit; a run that stopped
mid-page — its request gone — is carried on by the next request at the same epoch, and a
run overtaken writes nothing more. What is tested here is the member table across those
steps: what readers see, what each epoch holds, and that the page size changes nothing.
"""
import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import view_membership as routes
from backend.app.db.models import ViewMemberORM, ViewMembershipStateORM, ViewORM
from backend.app.db.repositories import view_membership_repo
from backend.app.services.live_views import pipeline
from backend.app.services.member_sets import sweeper
from backend.common.adapters import ProviderUnavailable
from backend.common.models.view_membership import read_definition
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
    assert await at(db_session, view_id, first) == 6, "the last answer is the sweeper's to let go, a while after"
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
    while await sweeper.sweep_once(db_session):
        await db_session.commit()
    assert await at(db_session, view_id, state.epoch) == 0, "an answer nobody reads is swept at once"
    assert await at(db_session, view_id, first) == 6


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


# ── Applying an answer: a step of its own ──────────────────────────────────


async def test_applying_is_the_next_turns_when_placing_leaves_too_little_of_this_one(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    view_id = await make(test_client)
    first = (await state_of(db_session, view_id)).members_epoch
    graph.engine = TypedEngine(gone={"col_b1"})
    monkeypatch.setattr(pipeline, "APPLY_RESERVE_S", 1000)        # more than any turn has left
    out = await run(db_session, view_id)
    assert (out.outcome, out.detail["reason"], out.detail["placed"], out.detail["members"]) == (
        "running", "placing", 5, 5)
    state = await state_of(db_session, view_id)
    assert (state.members_epoch, state.lease_owner) == (first, None), "placed, not applied, and let go"

    monkeypatch.setattr(pipeline, "APPLY_RESERVE_S", 0)
    real, reads = pipeline.read_page, []

    async def read_page(*args, **kwargs):
        reads.append(1)
        return await real(*args, **kwargs)

    monkeypatch.setattr(pipeline, "read_page", read_page)
    out = await run(db_session, view_id)
    assert (out.outcome, out.diff["removed"], reads) == ("applied", 1, []), "this turn only applies it"
    assert (await state_of(db_session, view_id)).members_epoch == state.epoch


async def test_the_answer_is_measured_before_anything_is_locked_and_kept_with_the_run(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    """The change from the last answer is measured holding no lock, and kept with the run:
    a turn that stops as it takes the lock leaves it there, and the next only swaps it in."""
    from backend.app.db.repositories import view_members_repo, view_membership_repo

    view_id = await make(test_client)
    graph.engine = TypedEngine(gone={"col_b1"})
    order = []
    real_diff, real_lock = view_members_repo.diff, view_membership_repo.locked_if_mine

    async def diff(*args, **kwargs):
        order.append("diff")
        return await real_diff(*args, **kwargs)

    async def dies_taking_the_lock(*args, **kwargs):
        order.append("lock")
        raise Crash()

    monkeypatch.setattr(view_members_repo, "diff", diff)
    monkeypatch.setattr(view_membership_repo, "locked_if_mine", dies_taking_the_lock)
    with pytest.raises(Crash):
        await run(db_session, view_id)
    await db_session.rollback()
    assert order == ["diff", "lock"]
    applying = json.loads((await state_of(db_session, view_id)).materialize)["applying"]
    assert (applying["diff"]["removed"], sum(applying["perLayer"].values())) == (1, 5)

    monkeypatch.setattr(view_membership_repo, "locked_if_mine", real_lock)
    await let_go(db_session, view_id)
    order.clear()
    out = await run(db_session, view_id)
    assert (out.outcome, out.diff["removed"], order) == ("applied", 1, []), "measured once"
    assert set(await members_of(db_session, view_id)) == {"dom", "tbl_a", "tbl_b", "col_a1", "col_a2"}


# ── Opening a view that is up to date ──────────────────────────────────────


async def test_opening_a_view_that_is_up_to_date_opens_no_engine(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    """The data's version from the graph cache and the physical graph this process last
    saw behind the data source: no admission, connection or token for a view that needs
    nothing. Not known here, the engine says, as before."""
    from backend.app.db.models import ViewORM
    from backend.app.services import graph_reads
    from backend.app.services.graph_cache import CacheScope

    class Cache:
        async def content_generation(self, scope):
            return "7"

    monkeypatch.setattr(graph_reads, "get_graph_cache", lambda: Cache())
    view_id = await make(test_client)
    ws = (await db_session.execute(select(ViewORM.workspace_id).where(ViewORM.id == view_id))).scalar_one()
    await db_session.execute(update(ViewMembershipStateORM).where(ViewMembershipStateORM.view_id == view_id)
                             .values(data_version="7.ns1"))
    await db_session.commit()
    assert await graph_reads.data_version(CacheScope(workspace_id=ws, graph_ns="ns1")) == "7.ns1"
    assert await graph_reads.known_data_version(ws, None) == "7.ns1", "a read named the graph behind it"

    @asynccontextmanager
    async def no_engine(*args):
        raise AssertionError("an engine was opened")
        yield

    out = await pipeline.refresh(view_id, session=db_session, engine_scope=no_engine, owner="open", budget_s=30,
                                 only_if_changed=True)
    assert (out.outcome, out.detail) == ("current", {"reason": "up_to_date"})
    graph_reads._GRAPH_NS.pop((ws, ""))
    with pytest.raises(AssertionError, match="an engine was opened"):
        await pipeline.refresh(view_id, session=db_session, engine_scope=no_engine, owner="open", budget_s=30,
                               only_if_changed=True)


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
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    view_id = await make(test_client)
    state = await state_of(db_session, view_id)
    current = state.members_epoch
    stray = {"view_id": view_id, "urn": "x", "layer_id": "l", "sort_key": "x", "ord": 0, "label": "",
             "label_ord": 0, "whole": False, "covered": False}
    from backend.app.db.repositories import view_members_repo

    await view_members_repo.insert(db_session, [{**stray, "epoch": e} for e in (current - 2, current - 1, current + 5)])
    state.epoch, state.materialize = current + 5, '{"epoch": %d}' % (current + 5)
    await db_session.commit()
    while await sweeper.sweep_once(db_session):
        await db_session.commit()
    assert await at(db_session, view_id, current - 1) == 1, (
        "the answer before, kept a while after the last: a reader may be reading through it")
    assert await at(db_session, view_id, current - 2) == 0, "one before that"
    assert await at(db_session, view_id, current + 5) == 1, "the run working on it now keeps its rows"
    assert await at(db_session, view_id, current) == 6, "what readers see is kept"
    monkeypatch.setattr(sweeper, "EPOCH_GRACE_S", 0)
    while await sweeper.sweep_once(db_session):
        await db_session.commit()
    assert await at(db_session, view_id, current - 1) == 0, "an answer since replaced, once the while is over"
    assert await at(db_session, view_id, current + 5) == 1
    state.materialize = None
    await db_session.commit()
    while await sweeper.sweep_once(db_session):
        await db_session.commit()
    assert await at(db_session, view_id, current + 5) == 0, "a run that left its rows behind"


# ── Laid out from a sample, a copied layer is never proved empty ───────────


async def test_a_save_that_places_a_sample_keeps_every_layer_it_copied(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    """Saved without a preview, a view of more members than a sample places only the first
    ``SAMPLE`` to choose its layers: a copied layer they don't reach may hold the rest, so
    every one stays — and "Other", for what nothing places. By type, "Other" stays too."""
    monkeypatch.setattr(pipeline, "SAMPLE", 3)

    async def layers(view_id: str) -> dict:
        config = (await test_client.get(f"/api/v1/views/{view_id}")).json()["config"]
        return {l["id"]: l["name"] for l in config["layout"]["referenceLayout"]["layers"]}

    copied = await make(test_client)
    names = await layers(copied)
    assert list(names.values()) == ["Domains", "Tables", "Columns", "Dashboards", "Other"]
    placed = {urn: names[e["layerId"]] for urn, e in (await members_of(db_session, copied)).items()}
    assert placed["col_a1"] == placed["col_b1"] == "Columns", "what the sample didn't see, where it belongs"

    by_type = await make(test_client, layout={"kind": "auto"})
    assert list((await layers(by_type)).values()) == ["Domains", "Other"]


# ── A busy graph ────────────────────────────────────────────────────────────


async def test_a_busy_graph_on_a_new_views_first_turn_reads_as_filling_in(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    """With no members yet, a view the graph was too busy to work out is still filling in
    (``updating``, ``graph_busy``), its run left for the next request; one that has members
    keeps them and is due again (``pending``)."""
    real = pipeline._Run._work

    async def busy(self, engine, **kwargs):
        raise ProviderUnavailable("graph", "busy")

    monkeypatch.setattr(pipeline._Run, "_work", busy)
    ws = await workspace(test_client)
    resp = await test_client.post("/api/v1/views/from-members", json=body(ws, await source_view(test_client, ws)))
    assert resp.status_code == 201, resp.text
    membership = resp.json()["membership"]
    assert (membership["status"], membership["detail"]) == ("updating", {"reason": "graph_busy"})
    view_id = resp.json()["view"]["id"]
    state = await state_of(db_session, view_id)
    assert (state.lease_owner, state.members_epoch) == (None, None) and state.materialize, (
        "let go, its run kept for the next request to carry on")

    monkeypatch.setattr(pipeline._Run, "_work", real)
    assert (await run(db_session, view_id)).outcome == "applied"
    monkeypatch.setattr(pipeline._Run, "_work", busy)
    with pytest.raises(ProviderUnavailable):
        await run(db_session, view_id)
    state = await state_of(db_session, view_id)
    assert (state.status, json.loads(state.status_detail)) == ("pending", {"reason": "graph_busy"})
    assert len(await members_of(db_session, view_id)) == 6


# ── Cut off: the lease is let go at once ───────────────────────────────────


def letting_go(monkeypatch) -> list:
    """What a turn cut off hands over to be let go (``_let_go``), recorded."""
    handed = []
    monkeypatch.setattr(pipeline, "_let_go", lambda view_id, *, owner, epoch: handed.append((view_id, owner, epoch)))
    return handed


async def freed(db_session: AsyncSession, handed: list) -> None:
    """What was handed over, let go of — as ``_let_go``'s own session does."""
    for view_id, owner, epoch in handed:
        await view_membership_repo.update_mine(db_session, view_id, owner=owner, epoch=epoch,
                                               lease_owner=None, lease_until=None)
    await db_session.commit()


def cut_off(monkeypatch, db_session: AsyncSession, *, landed: bool) -> dict:
    """The request is cut off at the next commit once ``armed`` — after the commit lands
    (``landed``), or before."""
    real = db_session.commit
    armed = {}

    async def commit():
        if armed.pop("now", False):
            if landed:
                await real()
            raise asyncio.CancelledError()
        await real()

    monkeypatch.setattr(db_session, "commit", commit)
    return armed


async def test_cut_off_once_its_claim_lands_a_refresh_lets_go_at_once(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    view_id = await make(test_client)
    handed = letting_go(monkeypatch)
    armed = cut_off(monkeypatch, db_session, landed=True)
    real = view_membership_repo.claim

    async def claim(*args, **kwargs):
        armed["now"] = True
        return await real(*args, **kwargs)

    monkeypatch.setattr(view_membership_repo, "claim", claim)
    with pytest.raises(asyncio.CancelledError):
        await run(db_session, view_id)
    state = await state_of(db_session, view_id)
    assert state.lease_owner == "test", "its claim landed"
    assert handed == [(view_id, "test", state.epoch)]
    await freed(db_session, handed)
    assert (await state_of(db_session, view_id)).lease_owner is None


async def test_cut_off_releasing_after_a_failure_the_turn_lets_go_all_the_same(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    view_id = await make(test_client)
    handed = letting_go(monkeypatch)

    async def busy(engine):
        raise ProviderUnavailable("graph", "busy")

    monkeypatch.setattr(pipeline, "search_data_version", busy)
    armed = cut_off(monkeypatch, db_session, landed=False)
    real = view_membership_repo.release

    async def release(*args, **kwargs):
        armed["now"] = True
        return await real(*args, **kwargs)

    monkeypatch.setattr(view_membership_repo, "release", release)
    with pytest.raises(asyncio.CancelledError):
        await run(db_session, view_id)
    await db_session.rollback()
    state = await state_of(db_session, view_id)
    assert state.lease_owner == "test", "its release never landed"
    assert handed == [(view_id, "test", state.epoch)]
    await freed(db_session, handed)
    assert (await state_of(db_session, view_id)).lease_owner is None


async def test_cut_off_saving_a_new_epoch_both_its_epochs_are_let_go(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    """A run whose view changed under it places again at a new epoch; cut off saving it —
    which may never land — the claim at the epoch before is let go of too."""
    view_id = await make(test_client)
    restore = crash_after(monkeypatch, 1)
    with pytest.raises(Crash):
        await run(db_session, view_id, page_size=2)
    await db_session.rollback()
    restore()
    await let_go(db_session, view_id)
    mid = (await state_of(db_session, view_id)).epoch
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    config = json.loads(row.config)
    config["layout"]["referenceLayout"]["layers"].append({"id": "l-new", "name": "New", "order": 9,
                                                         "entityTypes": []})
    row.config = json.dumps(config)
    await db_session.commit()

    handed = letting_go(monkeypatch)
    armed = cut_off(monkeypatch, db_session, landed=False)
    real = pipeline._Run.renumber

    async def renumber(self):
        armed["now"] = True
        return await real(self)

    monkeypatch.setattr(pipeline._Run, "renumber", renumber)
    with pytest.raises(asyncio.CancelledError):
        await run(db_session, view_id, page_size=2)
    await db_session.rollback()
    state = await state_of(db_session, view_id)
    assert (state.epoch, state.lease_owner) == (mid, "test"), "the new epoch never landed"
    assert sorted(handed) == [(view_id, "test", mid), (view_id, "test", mid + 1)]
    await freed(db_session, handed)
    assert (await state_of(db_session, view_id)).lease_owner is None


# ── What a view-scoped import pins in a list view ──────────────────────────


async def test_a_view_scoped_import_pins_the_roots_it_made_in_a_list_view_as_entries(
    test_client: AsyncClient, db_session: AsyncSession, graph, monkeypatch,
):
    """The roots a view-scoped import made are pinned in the draft's copy of a list view as
    entries (``assignedBy: "import"``), as in any view: drawn where they are put, never
    members — its query decides those."""
    from backend.app.api.v1.endpoints import versioning as versioning_ep
    from backend.app.db.repositories import view_repo

    @asynccontextmanager
    async def same_session():
        yield db_session

    async def containment(*args):
        return ["CONTAINS"]

    async def directions(*args):
        return {"CONTAINS": False}

    monkeypatch.setattr("backend.app.db.engine.get_async_session", same_session)
    monkeypatch.setattr(versioning_ep, "_live_containment_types", containment)
    monkeypatch.setattr(versioning_ep, "_live_containment_map", directions)
    view_id = await make(test_client)
    created = [{"eid": "r", "urn": "urn:new-root", "layer_signal": None},
               {"eid": "c", "urn": "urn:new-child", "layer_signal": None}]
    out = await versioning_ep._write_view_import_assignments("ws", "ds", view_id, "br1", created,
                                                             [("r", "c", "CONTAINS")])
    assert out == {"added": 1}
    config = await view_repo.effective_view_config(db_session, view_id, "br1")
    entry = config["layout"]["referenceLayout"]["assignments"]["urn:new-root"]
    assert entry["assignedBy"] == "import"
    inputs = pipeline.inputs_of(config, read_definition(config), None)
    assert inputs.user["urn:new-root"] == entry, "a person's entry, as the run reads it: never a member"
    assert "urn:new-root" not in await members_of(db_session, view_id)

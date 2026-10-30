"""Whether the person who opened a review may approve it, or merge it, is the data source's policy —
over HTTP, needs Postgres.

* Out of the box both are allowed: the opener approves and merges their own review.
* With self-approval off, the opener's approval is 403 ``self_review``; anyone else approves. The
  draft's owner, if someone else opened the review, approves too: the author is who opened it.
* With self-merge off, the opener's merge is 403 ``self_merge`` and someone else merges; publishing a
  draft directly is 409 ``review_required``, since a publish is its publisher's own merge.
* A review says what its reader may do with it (``viewerCan``): approve, merge, and why not.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager
from .test_private_draft_read import _app


async def _policy_run(monkeypatch) -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.services import drafts_policy

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"

    def h(user: str, publish: bool = True) -> dict:
        return {"X-User": user, "X-Manage": "1", "X-Publish": "1" if publish else "0"}

    def policy(**settings):
        async def load(_session, _ds):
            return drafts_policy.resolve(None, SimpleNamespace(**settings))
        monkeypatch.setattr(drafts_policy, "load", load)

    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=h("alice"))
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=h("alice"))
            assert r.status_code == 200, r.text
            B = f"{V1}/graphs/{gid}/branches"

            async def review(owner: str = "alice", opener: str = "alice", reviewers=()) -> str:
                d = (await c.post(B, json={"visibility": "public"}, headers=h(owner))).json()["branchId"]
                save = {"ops": [{"op": "update", "kind": "node", "id": "urn:t:child",
                                 "payload": {"description": os.urandom(3).hex()}}]}
                r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": d}, json=save,
                                 headers=h(owner))
                assert r.status_code == 200, r.text
                r = await c.post(f"{B}/{d}/merge-requests", json={"reviewers": list(reviewers)},
                                 headers=h(opener))
                assert r.status_code == 201, r.text
                return r.json()["prId"]

            async def approve(pr: str, who: str):
                head = (await c.get(f"{V1}/merge-requests/{pr}", headers=h(who))).json()["headCommitId"]
                return await c.post(f"{V1}/merge-requests/{pr}/approve", json={"expectedHeadCommitId": head},
                                    headers=h(who))

            async def can(pr: str, who: str) -> dict:
                r = await c.get(f"{V1}/merge-requests/{pr}", headers=h(who))
                assert r.status_code == 200, r.text
                return r.json()["viewerCan"]

            # Out of the box: the opener approves and merges their own review.
            pr = await review()
            assert (await can(pr, "alice"))["approve"] is True and (await can(pr, "alice"))["merge"] is True
            assert (await approve(pr, "alice")).status_code == 200
            r = await c.post(f"{V1}/merge-requests/{pr}/merge", json={"message": "m"}, headers=h("alice"))
            assert r.status_code == 200, r.text

            # Self-approval off: the opener is refused, the draft's owner who didn't open it is not.
            policy(review_self_approval=False)
            pr = await review(reviewers=["dave"])
            assert await can(pr, "alice") == {"approve": False, "merge": True, "approveReason": "self_review",
                                              "mergeReason": None}
            r = await approve(pr, "alice")
            assert (r.status_code, r.json()["detail"]["code"]) == (403, "self_review"), r.text
            assert (await approve(pr, "dave")).status_code == 200
            pr = await review(owner="alice", opener="bob", reviewers=["dave"])
            assert (await approve(pr, "alice")).status_code == 200         # opened by Bob

            # Self-merge off: the opener can't merge, someone else can; a direct publish asks for a review.
            policy(review_self_merge=False)
            pr = await review()
            assert await can(pr, "alice") == {"approve": True, "merge": False, "approveReason": None,
                                              "mergeReason": "self_merge"}
            assert (await can(pr, "pat"))["merge"] is True
            assert (await can(pr, "bob"))["merge"] is True
            r = await c.post(f"{V1}/merge-requests/{pr}/merge", json={"message": "m"}, headers=h("alice"))
            assert (r.status_code, r.json()["detail"]["code"]) == (403, "self_merge"), r.text
            r = await c.post(f"{V1}/merge-requests/{pr}/merge", json={"message": "m"}, headers=h("pat"))
            assert r.status_code == 200, r.text
            d = (await c.post(B, json={"visibility": "private"}, headers=h("alice"))).json()["branchId"]
            r = await c.post(f"{B}/{d}/publish", json={"message": "m"}, headers=h("alice"))
            assert (r.status_code, r.json()["detail"]["type"]) == (409, "review_required"), r.text

            # A merged review takes neither; without publish, merge isn't anyone's, whatever the policy.
            assert await can(pr, "carol") == {"approve": False, "merge": False, "approveReason": "merged",
                                              "mergeReason": "merged"}
            pr2 = await review()
            r = await c.get(f"{V1}/merge-requests/{pr2}", headers=h("carol", publish=False))
            assert r.json()["viewerCan"]["mergeReason"] == "publish_required", r.text
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_the_data_sources_policy_decides_whether_the_opener_approves_or_merges(data_sources, monkeypatch):
    asyncio.run(_policy_run(monkeypatch))

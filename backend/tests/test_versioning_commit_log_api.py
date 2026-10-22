"""The commit log's contract at the route: a page says whether more follow and where to carry
on, the sequence bounds reach the service, the two ways to page don't mix, and each commit keeps
the stored row's own names.

A script keeps a copy of a graph's history by walking ``main`` with ``before=nextBefore`` and,
later, asking only for what is new with ``after=<newest seq it holds>``. Both rest on
``commit_seq`` being unique within one branch, so a view's raw history — which spans branches —
is paged by offset alone.
"""
import pytest

from backend.app.api.v1.endpoints.versioning import get_versioning_service

WS = "ws_a"
LOG = f"/api/v1/{WS}/versioning/graphs/graph_a/commits"


def _commit(seq: int, **extra) -> dict:
    return {
        "commit_id": f"cmt_{seq}", "commit_seq": seq, "parent_commit_id": f"cmt_{seq - 1}",
        "kind": "squash_publish", "message": f"publish {seq}", "actor": "usr_a",
        "contributors": ["usr_a"], "source_branch_id": "br_a", "source_commit_count": 1,
        "originating_view_id": None, "merkle_root": None,
        "stats": {"create": 1, "update": 0, "delete": 0},
        "created_at": "2026-10-20T09:00:00+00:00", **extra,
    }


class _Versioning:
    def __init__(self, commits, more=False):
        self.commits, self.more, self.calls = commits, more, []

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": WS, "data_source_id": "ds_a"}

    async def commit_log_page(self, **kw):
        self.calls.append(kw)
        return self.commits, self.more

    async def squashed_commits(self, **kw):
        self.calls.append(kw)
        return self.commits


@pytest.fixture
def versioning():
    from backend.app.main import app

    def use(commits, more=False):
        svc = _Versioning(commits, more)
        app.dependency_overrides[get_versioning_service] = lambda: svc
        return svc

    yield use
    app.dependency_overrides.pop(get_versioning_service, None)


async def test_a_page_says_more_follow_and_where_to_carry_on(test_client, versioning):
    svc = versioning([_commit(9), _commit(8)], more=True)
    r = await test_client.get(LOG, params={"limit": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c["commit_seq"] for c in body["commits"]] == [9, 8]
    assert body["hasMore"] is True and body["nextBefore"] == 8
    assert svc.calls[-1]["limit"] == 2


async def test_the_last_page_has_no_cursor(test_client, versioning):
    versioning([_commit(2), _commit(1, kind="genesis", parent_commit_id=None)])
    body = (await test_client.get(LOG)).json()
    assert body["hasMore"] is False and body["nextBefore"] is None


async def test_the_sequence_bounds_reach_the_service(test_client, versioning):
    svc = versioning([])
    r = await test_client.get(LOG, params={"after": 3, "before": 9, "limit": 50})
    assert r.status_code == 200, r.text
    call = svc.calls[-1]
    assert (call["after"], call["before"], call["limit"], call["offset"]) == (3, 9, 50, 0)
    assert call["branch_id"] is None             # main, unless a branch is named


async def test_bounds_and_offset_do_not_mix(test_client, versioning):
    versioning([])
    r = await test_client.get(LOG, params={"before": 9, "offset": 100})
    assert r.status_code == 400, r.text


async def test_a_views_raw_history_is_paged_by_offset_only(test_client, versioning):
    versioning([_commit(3)], more=True)
    r = await test_client.get(LOG, params={"originatingViewId": "view_a", "after": 1})
    assert r.status_code == 400, r.text

    body = (await test_client.get(LOG, params={"originatingViewId": "view_a"})).json()
    assert body["hasMore"] is True and body["nextBefore"] is None   # seqs repeat across branches

    published = await test_client.get(
        LOG, params={"originatingViewId": "view_a", "publishedOnly": "true", "after": 1})
    assert published.status_code == 200, published.text          # that timeline is main's
    assert published.json()["nextBefore"] == 3


async def test_a_negative_bound_is_refused(test_client, versioning):
    versioning([])
    assert (await test_client.get(LOG, params={"before": -1})).status_code == 422


async def test_each_commit_keeps_the_stored_rows_names(test_client, versioning):
    pull = _commit(4, kind="pull", stats={"create": 2, "update": 0, "delete": 0,
                                          "rebased": {"update": 1}, "from_seq": 3, "to_seq": 5})
    versioning([pull])
    body = (await test_client.get(LOG)).json()
    assert list(body["commits"][0]) == list(pull)
    assert body["commits"][0] == pull
    assert body["userNames"] == {}                 # nobody resolvable in this database


async def test_squashed_commits_say_whether_more_follow(test_client, versioning):
    svc = versioning([_commit(3), _commit(2), _commit(1)])
    body = (await test_client.get(f"{LOG}/cmt_9/squashed", params={"limit": 2})).json()
    assert [c["commit_seq"] for c in body["commits"]] == [3, 2]
    assert body["hasMore"] is True
    assert svc.calls[-1]["limit"] == 3

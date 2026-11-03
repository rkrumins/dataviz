"""Locust tasks for subset views: many people opening the same few subset views.

What a subset view costs is its layer feeds (``POST /{ws}/graph/search/view-feed``):
one search per layer, shared by every view and viewer asking the same question,
served from its last complete page for a while after the data changes, and
scanned in a lane of its own. This scenario opens a subset view the way the
canvas does:

1. ``GET /api/v1/views/{id}/search`` — the layers it shows;
2. every layer's first page, four in flight (the canvas's hydration concurrency),
   each with ``waitMs`` 2500, then followed with ``sessionId`` while it is
   ``running``;
3. now and then, a layer's next page by ``cursor``.

The subset views are made once per workspace and process, from the first
ordinary view in the workspace, with ``SYNODIC_SUBSET_PREDICATE`` (default: every
entity of the base) — the same ``Idempotency-Key`` every time, so every user of
a run opens the SAME views: the hot-view case the cache and the lane exist for.
It needs ``searchViewsEnabled`` on.

Rows: ``subset:search``, ``subset:feed`` (and ``:retry`` for shed answers retried
as the canvas retries them), ``subset:feed:poll``, ``subset:feed:page``, and
zero-length markers ``subset:feed:stale`` (a recent answer served while the data
changed) and ``subset:feed:capped``.
"""
from __future__ import annotations

import json
import os
import random
import threading
from typing import Dict, List, Optional

from gevent.pool import Pool
from locust import TaskSet, events, task

from lib.retry import request_with_retries

HYDRATION_CONCURRENCY = 4
WAIT_MS = 2500
POLLS_MAX = 20
PREDICATE = json.loads(os.getenv("SYNODIC_SUBSET_PREDICATE", '{"kind": "all"}'))

_lock = threading.Lock()
_subsets: Dict[str, Optional[str]] = {}       # workspace → its subset view (None: none can be made)


def _note(name: str) -> None:
    """A zero-length row for an answer worth counting that isn't a failure."""
    events.request.fire(request_type="SUBSET", name=name, response_time=0, response_length=0,
                        exception=None, context={})


def _subset_for(client, ws_id: str) -> Optional[str]:
    """This workspace's load-test subset view, made once (and found again by its key)."""
    with _lock:
        if ws_id in _subsets:
            return _subsets[ws_id]
    found: Optional[str] = None
    resp = client.get(f"/api/v1/views/?workspaceId={ws_id}&limit=50", name="subset:setup:views")
    try:
        listed = resp.json()
        items = listed.get("items", []) if isinstance(listed, dict) else listed
        base = next((v["id"] for v in items if isinstance(v, dict)
                     and not (v.get("config") or {}).get("search")), None)
    except (ValueError, AttributeError):
        base = None
    if base:
        made = client.post("/api/v1/views/from-search", name="subset:setup:create",
                           headers={"Idempotency-Key": f"loadtest-subset-{ws_id}"},
                           json={"name": "Load test subset", "workspaceId": ws_id,
                                 "predicate": PREDICATE, "readIn": base})
        if made.status_code in (200, 201):
            found = made.json()["view"]["id"]
    with _lock:
        _subsets[ws_id] = found
    return found


class SearchViewsTasks(TaskSet):
    cursors: List[tuple]

    def on_start(self) -> None:
        self.cursors = []

    def _feed(self, ws_id: str, view_id: str, layer_id: str) -> None:
        body = {"layerId": layer_id, "waitMs": WAIT_MS}
        page = self._ask(ws_id, view_id, body, "subset:feed")
        polls = 0
        while page and page.get("status") == "running" and page.get("sessionId") and polls < POLLS_MAX:
            polls += 1
            page = self._ask(ws_id, view_id, {**body, "sessionId": page["sessionId"]}, "subset:feed:poll")
        if page and page.get("cursor"):
            self.cursors.append((ws_id, view_id, layer_id, page["cursor"]))

    def _ask(self, ws_id: str, view_id: str, body: dict, name: str) -> Optional[dict]:
        answer: Dict[str, dict] = {}

        def keep(resp) -> bool:
            try:
                answer["page"] = resp.json()
            except ValueError:
                return False
            return isinstance(answer["page"], dict)

        request_with_retries(self.client, "POST",
                             f"/api/v1/{ws_id}/graph/search/view-feed?viewId={view_id}",
                             name=name, json=body, on_success=keep)
        page = answer.get("page")
        if page and page.get("stale"):
            _note("subset:feed:stale")
        if page and page.get("capped"):
            _note("subset:feed:capped")
        return page

    @task(5)
    def open_subset(self) -> None:
        ws_id = self.user.id_pool.pick_workspace()
        view_id = _subset_for(self.client, ws_id) if ws_id else None
        if not view_id:
            self.client.get("/__no_subset__", name="subset:no-view")
            return
        resp = self.client.get(f"/api/v1/views/{view_id}/search", name="subset:search")
        try:
            layers = [layer["id"] for layer in resp.json().get("layers", [])]
        except (ValueError, AttributeError):
            return
        pool = Pool(HYDRATION_CONCURRENCY)
        for layer_id in layers:
            pool.spawn(self._feed, ws_id, view_id, layer_id)
        pool.join()

    @task(1)
    def next_page(self) -> None:
        if not self.cursors:
            return
        ws_id, view_id, layer_id, cursor = self.cursors.pop(random.randrange(len(self.cursors)))
        page = self._ask(ws_id, view_id, {"layerId": layer_id, "cursor": cursor}, "subset:feed:page")
        if page and page.get("cursor"):
            self.cursors.append((ws_id, view_id, layer_id, page["cursor"]))

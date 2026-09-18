"""Locust tasks for the canvas view-open path.

The one request shape every user fires on opening a curated view (see
``useGraphHydration`` in the frontend), which nothing else in the mix
reproduces — trace / children / walks are navigation, this is the open:

1. ``POST /api/v1/{ws_id}/graph/nodes/query`` — the view's assigned
   entities by URN, 100 per request, at most 4 requests in flight
   (the frontend's ``VITE_HYDRATION_CONCURRENCY``). Each batch is one
   FalkorDB query on a cache miss, one Redis read on a hit.
2. ``POST /api/v1/{ws_id}/graph/edges/between`` — ONE request for the
   edges among everything the batches returned. The heaviest hydration
   query (an AND-scan over the loaded set); response-cached, with a 24h
   last-known-good fallback when the provider is slow.

The "view" is the pool's URN sample for the workspace, so its size is
``SYNODIC_URNS_PER_WORKSPACE`` (20 by default — one batch). Set it to 500
to emulate a 500-entity view: five node batches and one edge scan per
open. Two stat rows: ``canvas-open:nodes`` (per batch) and
``canvas-open:edges``.

A shed response (429, or a 503 with ``Retry-After``) is RETRIED here, the
way the canvas retries it — see ``lib/retry.py``. It used to count as a
failure, which quietly inverted the thing this scenario measures: under
saturation the real system's offered load goes UP, because every shed
request comes back, while the harness's went DOWN, because the user
recorded a failure and went to think-time. That reported a ceiling below
the real one and could not reproduce retry amplification at all.

The shedding is still the capacity signal — it is just counted as
shedding (``canvas-open:nodes:429``) and as retry traffic
(``canvas-open:nodes:retry``) rather than hidden inside a failure count.
"""
from __future__ import annotations

from gevent.pool import Pool
from locust import TaskSet, task

from lib.retry import request_with_retries

# Mirror the frontend: 100 URNs per /nodes/query, four batches in flight.
NODE_BATCH_SIZE = 100
HYDRATION_CONCURRENCY = 4
# The frontend passes the backend's hard maximum so a large assigned set
# is never truncated at the 50k default.
EDGES_BETWEEN_LIMIT = 200_000


class CanvasOpenTasks(TaskSet):
    @task
    def open_view(self) -> None:
        target = self.user.id_pool.pick_ws_urns()
        if not target:
            # No URNs in the pool — a marker row so the operator sees graph
            # data is missing, without failing the user.
            self.client.get("/__no_node__", name="canvas-open:no-node")
            return
        ws_id, urns = target
        loaded: list[str] = []

        def fetch_batch(batch: list[str]) -> None:
            def _collect(resp) -> bool:
                try:
                    items = resp.json()
                except ValueError:
                    return False
                loaded.extend(
                    it["urn"] for it in items if isinstance(it, dict) and it.get("urn")
                )
                return True

            request_with_retries(
                self.client, "POST",
                f"/api/v1/{ws_id}/graph/nodes/query",
                name="canvas-open:nodes",
                json={"query": {"urns": batch, "limit": len(batch)}},
                on_success=_collect,
            )

        pool = Pool(HYDRATION_CONCURRENCY)
        for i in range(0, len(urns), NODE_BATCH_SIZE):
            pool.spawn(fetch_batch, urns[i:i + NODE_BATCH_SIZE])
        pool.join()

        if not loaded:
            return
        request_with_retries(
            self.client, "POST",
            f"/api/v1/{ws_id}/graph/edges/between",
            name="canvas-open:edges",
            json={"urns": loaded, "limit": EDGES_BETWEEN_LIMIT},
        )

"""Locust tasks for people editing drafts together while others read: the collaboration load.

About 300 people on about 50 versioned graphs, ``SYNODIC_COLLAB_EDITORS`` of them editing. Each
editor opens or resumes a draft on one graph — one hot graph gets ``SYNODIC_COLLAB_HOT_EDITORS``
of them, the rest spread over the others — and works on it the way the canvas does; the other
users read canvases. An editor:

* opens the canvas: ``GET /api/v1/{ws}/versioning/resolve?dataSourceId=`` (the canvas's boot
  lookup), resumes a ``loadtest-collab`` draft of the account's on that graph that no other editor
  of this process holds (``GET …/graphs/{gid}/branches?scope=mine``) or opens one
  (``POST …/graphs/{gid}/branches``), and reads it: ``POST /api/v1/{ws}/graph/nodes/query`` (URNs
  100 a request) then ``POST …/graph/edges/between``, with ``dataSourceId`` and ``branchId``;
* saves what it staged in the canvas as ONE commit, as the canvas's Save does:
  ``POST /api/v1/{ws}/graph/changes?dataSourceId=&branchId=``, a few node updates, each with the
  ``baseVersion`` it last read when the read gave one (a node read from FalkorDB carries none: then
  a plain patch), under an ``Idempotency-Key`` its retries reuse;
* now and then saves through the API's other path instead: stage
  (``POST …/branches/{bid}/changes``), then checkpoint (``POST …/branches/{bid}/commit``);
* polls its draft every ``SYNODIC_COLLAB_FRESHNESS_SECS`` (10, the UI's cadence while the draft
  or main moves): ``GET …/branches/{bid}/freshness?sinceSeq=``;
* pulls main in when that poll says it moved (``POST …/branches/{bid}/rebase``), and after
  ``SYNODIC_COLLAB_SAVES_PER_PUBLISH`` saves publishes the draft (``POST …/branches/{bid}/publish``;
  a 202 is a publish queued on the transfer lane, followed at ``…/publish-jobs/{jobId}``), then
  starts its next draft.

A reader opens a graph's published canvas (the same two reads, without ``branchId``): the hot
graph in the share the editors have of it, otherwise another graph.

Each editor sets one property of its own (``loadtest_<worker>_<n>``) on existing nodes, so no two
editors change one field and their pulls and publishes merge clean; a publish writes those
properties to main. Run it against a deployment whose data may change, as an account that edits
and publishes the data sources it finds. What collaboration answers with — a publish refused
because main moved since the pull or by the data source's policy (409), a save whose base moved
(409 ``merge_conflict``), a pull with conflicts — is an answer, not a failure: each is counted as
a row of its own (``versioning-collab:publish:409:review_required`` …).

Run it with ``runners/versioning_collab.py``::

    locust -f runners/versioning_collab.py --headless -u 300 -r 20 -t 15m --csv results/collab

Knobs (env): ``SYNODIC_COLLAB_GRAPHS`` (50) graphs at most, the hot one included;
``SYNODIC_COLLAB_HOT_DATA_SOURCE`` (the first versioned data source found) the hot graph's data
source; ``SYNODIC_COLLAB_EDITORS`` (60) users who edit, the rest read; ``SYNODIC_COLLAB_HOT_EDITORS``
(20) of them on the hot graph; ``SYNODIC_COLLAB_FRESHNESS_SECS`` (10);
``SYNODIC_COLLAB_SAVES_PER_PUBLISH`` (20). Editors are counted per Locust process in the share
``SYNODIC_COLLAB_EDITORS`` gives them, so a distributed run splits the hot ones across its workers.

SLO gate, checked when the run ends (exit code 1 on a miss), starting points to tune::

* freshness p99 < 300 ms: every open draft polls it;
* save and checkpoint p95 < 1 s; publish p95 < 5 s;
* 0 pool timeouts (503 "temporarily unavailable").

The latency part also checks from a CSV after the fact::

    python -m scenarios.versioning_collab results/collab_stats.csv
"""
from __future__ import annotations

import logging
import os
import random
import sys
import threading
import time
import uuid
from typing import Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import gevent  # noqa: E402
from locust import TaskSet, events, task  # noqa: E402

from config import SETTINGS  # noqa: E402
from lib.data import IdPool  # noqa: E402
from lib.retry import request_with_retries  # noqa: E402
from lib.slo import SLO, assert_slos  # noqa: E402

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else default


GRAPHS = _env_int("SYNODIC_COLLAB_GRAPHS", 50)
HOT_DATA_SOURCE = os.getenv("SYNODIC_COLLAB_HOT_DATA_SOURCE", "").strip() or None
EDITORS = max(1, _env_int("SYNODIC_COLLAB_EDITORS", 60))
HOT_EDITORS = _env_int("SYNODIC_COLLAB_HOT_EDITORS", 20)
FRESHNESS_SECS = float(os.getenv("SYNODIC_COLLAB_FRESHNESS_SECS", "10"))
SAVES_PER_PUBLISH = _env_int("SYNODIC_COLLAB_SAVES_PER_PUBLISH", 20)

DRAFT_NAME = "loadtest-collab"
#: Node updates one save carries: a few staged edits.
OPS_PER_SAVE = 3
#: The canvas asks for nodes 100 URNs a request, and for every edge among them at once.
NODE_BATCH = 100
EDGES_BETWEEN_LIMIT = 200_000
# How a dialog follows a queued publish (the frontend's pollJob): 1 s, then 2 s, then every 5 s.
_POLL_DELAYS = (1.0, 2.0, 5.0)
_FOLLOW_SECS = 120.0

COLLAB_SLOS: List[SLO] = [
    SLO(name="versioning-collab:freshness", p99_ms_max=300.0),
    SLO(name="versioning-collab:save", p95_ms_max=1000.0),
    SLO(name="versioning-collab:checkpoint", p95_ms_max=1000.0),
    SLO(name="versioning-collab:publish", p95_ms_max=5000.0),
]
_GATED = {"versioning-collab:freshness": "GET", "versioning-collab:save": "POST",
          "versioning-collab:checkpoint": "POST", "versioning-collab:publish": "POST"}

# Shared by this process's users (greenlets of one process): the versioned graphs, the hot one
# first, as [(workspace, data source, graph)], found under their own lock (the requests that find
# them fire the listener that takes ``_lock``); each graph's nodes [(urn, version)]; the drafts an
# editor holds; how many editors have started.
_graphs_lock = threading.Lock()
_lock = threading.Lock()
_graphs: Optional[List[Tuple[str, str, str]]] = None
_nodes: Dict[str, List[Tuple[str, Optional[str]]]] = {}
_held: set = set()
_editors = 0
_pool_timeouts = 0


def _note(name: str) -> None:
    """A zero-length row for an answer worth counting that isn't a failure (a 409, a conflict)."""
    events.request.fire(request_type="COLLAB", name=name, response_time=0, response_length=0,
                        exception=None, context={})


def _hot(n: int) -> bool:
    """Whether this process's ``n``-th editor edits the hot graph: ``HOT_EDITORS`` of every
    ``EDITORS``, spread evenly, so a run split across workers still has about that many."""
    return (n + 1) * HOT_EDITORS // EDITORS > n * HOT_EDITORS // EDITORS


def _versioned_graphs(client, pool: IdPool) -> List[Tuple[str, str, str]]:
    """The versioned graphs among the discovered data sources, at most ``GRAPHS``, the hot one
    first; found once per process."""
    global _graphs
    with _graphs_lock:
        if _graphs is None:
            pairs = [(ws, ds) for ws, dss in pool.ws_to_ds.items() for ds in dss]
            pairs.sort(key=lambda p: p[1] != HOT_DATA_SOURCE)
            found: List[Tuple[str, str, str]] = []
            for ws, ds in pairs:
                if len(found) >= GRAPHS:
                    break
                resp = request_with_retries(client, "GET", f"/api/v1/{ws}/versioning/resolve",
                                            name="discover:versioning-resolve", ok=(200, 404),
                                            params={"dataSourceId": ds})
                if resp.status_code == 200:              # 404: the data source isn't versioned
                    found.append((ws, ds, resp.json()["graphId"]))
            if HOT_DATA_SOURCE and (not found or found[0][1] != HOT_DATA_SOURCE):
                logger.warning("versioning_collab: %s is not a versioned data source here; the "
                               "hot graph is the first one found", HOT_DATA_SOURCE)
            _graphs = found
            logger.info("versioning_collab: %d versioned graph(s) among %d data source(s)",
                        len(found), len(pairs))
    return _graphs


def _graph_nodes(client, graph: Tuple[str, str, str]) -> List[Tuple[str, Optional[str]]]:
    """Some of a graph's published nodes, with the version each was read at: what editors edit
    and readers open. ``SYNODIC_URNS_PER_WORKSPACE`` of them, read once per process."""
    ws, ds, gid = graph
    if gid not in _nodes:
        nodes: List[Tuple[str, Optional[str]]] = []

        def collect(resp) -> bool:
            nodes.extend((n["urn"], n.get("version")) for n in resp.json()
                         if isinstance(n, dict) and n.get("urn"))
            return True

        request_with_retries(client, "POST", f"/api/v1/{ws}/graph/nodes/query",
                             name="discover:graph-nodes", params={"dataSourceId": ds},
                             json={"query": {"limit": SETTINGS.urns_per_workspace}}, on_success=collect)
        _nodes[gid] = nodes
    return _nodes[gid]


def _read_canvas(client, graph: Tuple[str, str, str], branch: Optional[str] = None) -> None:
    """Open a graph's canvas, published or a draft's: its nodes by URN, then the edges among them."""
    ws, ds, _gid = graph
    urns = [urn for urn, _version in _graph_nodes(client, graph)]
    if not urns:
        return
    params = {"dataSourceId": ds, **({"branchId": branch} if branch else {})}
    kind = "draft" if branch else "canvas"
    loaded: List[str] = []

    def collect(resp) -> bool:
        loaded.extend(n["urn"] for n in resp.json() if isinstance(n, dict) and n.get("urn"))
        return True

    for i in range(0, len(urns), NODE_BATCH):
        batch = urns[i:i + NODE_BATCH]
        request_with_retries(client, "POST", f"/api/v1/{ws}/graph/nodes/query",
                             name=f"versioning-collab:{kind}-nodes", params=params,
                             json={"query": {"urns": batch, "limit": len(batch)}}, on_success=collect)
    if loaded:
        request_with_retries(client, "POST", f"/api/v1/{ws}/graph/edges/between",
                             name=f"versioning-collab:{kind}-edges", params=params,
                             json={"urns": loaded, "limit": EDGES_BETWEEN_LIMIT})


class CollabEditorTasks(TaskSet):
    """One person's draft on one graph: saved, checkpointed, kept fresh, pulled and published."""

    graph: Optional[Tuple[str, str, str]] = None
    branch: Optional[str] = None
    _poller = None

    def on_start(self) -> None:
        global _editors
        graphs = _versioned_graphs(self.client, self.user.id_pool)
        if not graphs:
            return
        with _lock:
            n, _editors = _editors, _editors + 1
        others = graphs[1:] or graphs
        self.graph = graphs[0] if _hot(n) else others[n % len(others)]
        worker = getattr(self.user.environment.runner, "worker_index", 0)
        self.key = f"loadtest_{worker}_{n}"            # this editor's own field: none share it
        self._open_draft()
        self._poller = gevent.spawn(self._poll_freshness)

    def on_stop(self) -> None:
        if self._poller is not None:
            self._poller.kill(block=False)
        with _lock:
            _held.discard(self.branch)

    def _base(self, graph_path: str = "") -> str:
        ws, _ds, gid = self.graph
        return f"/api/v1/{ws}/versioning/graphs/{gid}{graph_path}"

    def _open_draft(self) -> None:
        """Resume a ``loadtest-collab`` draft of the account's on the graph that no editor of
        this process holds, or open one; then read it, as the canvas does when it opens."""
        ws, ds, _gid = self.graph
        request_with_retries(self.client, "GET", f"/api/v1/{ws}/versioning/resolve",
                             name="versioning-collab:resolve", params={"dataSourceId": ds})
        drafts: List[dict] = []
        request_with_retries(self.client, "GET", self._base("/branches"), name="versioning-collab:drafts",
                             params={"scope": "mine", "status": "open", "limit": 500},
                             on_success=lambda resp: drafts.extend(resp.json()) or True)
        with _lock:
            free = [d["branchId"] for d in drafts if d.get("name") == DRAFT_NAME
                    and d["branchId"] not in _held]
            self.branch = free[0] if free else None
            if self.branch:
                _held.add(self.branch)
        if self.branch is None:
            resp = request_with_retries(self.client, "POST", self._base("/branches"),
                                        name="versioning-collab:open-draft", ok=(201,),
                                        json={"name": DRAFT_NAME})
            if resp.status_code != 201:
                return
            self.branch = resp.json()["branchId"]
            with _lock:
                _held.add(self.branch)
        self.saves, self.since, self.behind, self.publishable = 0, None, False, True
        self.versions = dict(_graph_nodes(self.client, self.graph))
        _read_canvas(self.client, self.graph, self.branch)

    def _next_draft(self) -> None:
        with _lock:
            _held.discard(self.branch)
        self.branch = None
        self._open_draft()

    def _picked(self) -> List[str]:
        urns = list(self.versions)
        return random.sample(urns, min(OPS_PER_SAVE, len(urns)))

    def _poll_freshness(self) -> None:
        """The draft's freshness, every ``FRESHNESS_SECS`` as the UI polls it while things move:
        ``sinceSeq`` is the head this reader last caught up with, as the UI sends it."""
        def read(resp) -> bool:
            body = resp.json()
            self.behind = bool(body.get("behind"))
            if self.since is None:
                self.since = body.get("headCommitSeq")
            return True

        while True:
            if self.branch is not None:
                request_with_retries(
                    self.client, "GET", self._base(f"/branches/{self.branch}/freshness"),
                    name="versioning-collab:freshness", on_success=read,
                    params={"sinceSeq": self.since} if self.since is not None else {})
            gevent.sleep(FRESHNESS_SECS)

    @task(4)
    def read_draft(self) -> None:
        """Look around the draft: the canvas reads it again (a pan, a refresh, another view). An
        editor whose draft didn't open tries again here."""
        if self.graph is None:
            return
        if self.branch is None:
            self._open_draft()
            return
        _read_canvas(self.client, self.graph, self.branch)

    @task(4)
    def save(self) -> None:
        """What the person staged in the canvas, saved as one commit, as the canvas's Save does."""
        if not self.branch:
            return
        ws, ds, _gid = self.graph
        ops = [{"op": "update", "kind": "node", "id": urn,
                "payload": {"properties": {self.key: str(self.saves)}},
                **({"baseVersion": self.versions[urn]} if self.versions.get(urn) else {})}
               for urn in self._picked()]
        if not ops:
            return

        def saved(resp) -> bool:
            body = resp.json()
            if resp.status_code == 409:                  # its base moved: take what is there now
                detail = body.get("detail") if isinstance(body.get("detail"), dict) else {}
                _note(f"versioning-collab:save:409:{detail.get('type')}")
                views = detail.get("current") or {}
            else:
                self.saves += 1
                views = body.get("entities") or {}
            # Keyed by entity id; a node's URN is what this editor addresses it by.
            self.versions.update({(v.get("node") or {}).get("urn") or eid: v.get("version")
                                  for eid, v in views.items() if isinstance(v, dict)})
            return True

        request_with_retries(self.client, "POST", f"/api/v1/{ws}/graph/changes",
                             name="versioning-collab:save", ok=(200, 409), on_success=saved,
                             params={"dataSourceId": ds, "branchId": self.branch},
                             json={"ops": ops, "message": "loadtest collab save"},
                             headers={"Idempotency-Key": uuid.uuid4().hex})

    @task(1)
    def checkpoint(self) -> None:
        """The API's save: the same kind of updates staged on the server, then checkpointed."""
        if not self.branch:
            return
        picked = self._picked()
        ops = [{"op": "update", "entityKind": "node", "entityId": urn,
                "payload": {"properties": {self.key: str(self.saves)}}} for urn in picked]
        if not ops:
            return
        staged = request_with_retries(self.client, "POST", self._base(f"/branches/{self.branch}/changes"),
                                      name="versioning-collab:stage", json={"ops": ops})
        if staged.status_code != 200:
            return
        done = request_with_retries(self.client, "POST", self._base(f"/branches/{self.branch}/commit"),
                                    name="versioning-collab:checkpoint",
                                    json={"message": "loadtest collab checkpoint"})
        if done.status_code == 200:
            self.saves += 1
            self.versions.update(dict.fromkeys(picked))  # versions unknown now: plain patches next

    @task(1)
    def pull_or_publish(self) -> None:
        """Pull main in when the freshness poll says it moved; once the draft has had its saves,
        publish it and start the next one."""
        if not self.branch:
            return
        if self.behind and not self._pull():
            return
        if self.publishable and self.saves >= SAVES_PER_PUBLISH:
            self._publish()

    def _pull(self) -> bool:
        """Pull main into the draft. A pull with conflicts gives the draft up for a new one: True
        when the draft is up to date and still this editor's."""
        result: dict = {}
        resp = request_with_retries(self.client, "POST", self._base(f"/branches/{self.branch}/rebase"),
                                    name="versioning-collab:pull", json={},
                                    on_success=lambda r: result.update(r.json()) or True)
        if resp.status_code != 200:
            return False
        if not result.get("clean", True):
            _note("versioning-collab:pull:conflicts")
            request_with_retries(self.client, "POST", self._base(f"/branches/{self.branch}/abandon"),
                                 name="versioning-collab:abandon")
            self._next_draft()
            return False
        self.behind, self.since = False, None
        return True

    def _publish(self) -> None:
        answer: dict = {}
        resp = request_with_retries(self.client, "POST", self._base(f"/branches/{self.branch}/publish"),
                                    name="versioning-collab:publish", ok=(200, 202, 409),
                                    json={"message": "loadtest collab publish"},
                                    on_success=lambda r: answer.update(r.json()) or True)
        if resp.status_code == 409:
            self._refused("versioning-collab:publish", answer.get("detail"))
            return
        if resp.status_code == 202:                      # queued on the transfer lane
            job = self._follow(answer["graphId"], answer["jobId"])
            if job.get("status") == "failed" and (job.get("error") or {}).get("status") == 409:
                # Main moved while it waited, or its policy changed: as a refusal inside the
                # request, which the job answers in its place.
                self._refused("versioning-collab:publish-job", job["error"].get("detail"))
                return
        if resp.status_code in (200, 202):
            self._next_draft()

    def _refused(self, row: str, detail) -> None:
        """A publish refused with a 409, inside the request or by its job."""
        kind = detail.get("type") if isinstance(detail, dict) else None
        _note(f"{row}:409:{kind}")
        if kind == "not_up_to_date":                     # a colleague published first: pull again
            self.behind = True
        else:                                            # e.g. its policy wants a review: keep
            self.publishable = False                     # editing it, unpublished

    def _follow(self, graph_id: str, job_id: str) -> dict:
        """A queued publish, followed as the publish dialog follows it, for as long as it does: the
        job as it ended, or ``{}`` while it is still queued."""
        ws = self.graph[0]
        started, n = time.monotonic(), 0
        while time.monotonic() - started < _FOLLOW_SECS:
            gevent.sleep(_POLL_DELAYS[min(n, len(_POLL_DELAYS) - 1)])
            n += 1
            job: dict = {}
            request_with_retries(self.client, "GET",
                                 f"/api/v1/{ws}/versioning/graphs/{graph_id}/publish-jobs/{job_id}",
                                 name="versioning-collab:publish-job",
                                 on_success=lambda r: job.update(r.json()) or True)
            if job.get("status") in ("completed", "failed", "cancelled"):
                _note(f"versioning-collab:publish-job:{job['status']}")
                return job
        _note("versioning-collab:publish-job:still-queued")
        return {}


class CollabReaderTasks(TaskSet):
    """Someone reading: a graph's published canvas, the hot one in the editors' share of it."""

    @task
    def read_canvas(self) -> None:
        graphs = _versioned_graphs(self.client, self.user.id_pool)
        if not graphs:
            return
        hot = len(graphs) == 1 or random.random() < HOT_EDITORS / EDITORS
        _read_canvas(self.client, graphs[0] if hot else random.choice(graphs[1:]))


@events.request.add_listener
def _count_pool_timeouts(request_type, name, response_time, response_length, response=None,
                         exception=None, **_kwargs) -> None:
    """A 503 "temporarily unavailable" is the API's answer when a DB pool checkout timed out."""
    global _pool_timeouts
    if response is not None and response.status_code == 503 and "temporarily unavailable" in (response.text or ""):
        with _lock:
            _pool_timeouts += 1


def gate(stats) -> List[str]:
    """This scenario's SLOs against the run: ``stats`` is Locust's ``RequestStats``."""
    misses = []
    for slo in COLLAB_SLOS:
        entry = stats.get(slo.name, _GATED[slo.name])
        if not entry.num_requests:
            continue
        for q, limit in ((0.95, slo.p95_ms_max), (0.99, slo.p99_ms_max)):
            if limit is not None and entry.get_response_time_percentile(q) > limit:
                misses.append(f"[{slo.name}] p{round(q * 100)} = "
                              f"{entry.get_response_time_percentile(q):.0f} ms (> {limit:.0f} ms)")
    if _pool_timeouts:
        misses.append(f"{_pool_timeouts} pool timeout(s) (503 temporarily unavailable; 0 allowed)")
    return misses


@events.quitting.add_listener
def _gate_at_quit(environment, **_kwargs) -> None:
    misses = gate(environment.stats)
    logger.info("versioning_collab: %d editor(s) started here, %d pool timeout(s)", _editors,
                _pool_timeouts)
    if misses:
        for miss in misses:
            logger.error("versioning_collab SLO miss: %s", miss)
        environment.process_exit_code = 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python -m scenarios.versioning_collab <stats.csv>", file=sys.stderr)
        sys.exit(2)
    violations = assert_slos(sys.argv[1], slos=COLLAB_SLOS, skip_missing=True)
    for v in violations:
        print(f"  - {v}", file=sys.stderr)
    print("SLO check passed" if not violations else "SLO violations", file=sys.stderr if violations else sys.stdout)
    sys.exit(1 if violations else 0)

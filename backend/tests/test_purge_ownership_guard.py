"""The permanent-delete guardrail: a purge drops the physical FalkorDB graph ONLY when we own it.

This locks ``purge_worker._phase_falkor`` — the single place on the delete/reaper path that can
issue a destructive command to a provider (``client.delete()``). It must fire only for a graph WE
generated (``projection_state.owns_falkor_graph`` is True — a managed/versioned graph), and NEVER
for a federated/external graph pinned to the customer's own store. Deleting our version history
must never mean deleting their data.

See ``backend/app/services/versioning/purge_worker.py`` (_phase_falkor) and ``models.py`` (the
``owns_falkor_graph`` column, "we own it IFF we generated its name", default False).

Driven with a faked session so the invariant is pinned without standing up the graphver schema.
"""
import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

from backend.app.services.versioning.purge_worker import PurgeRunner
from backend.app.services.versioning.models import ProjectionStateORM, JobORM


def _run(coro):
    return asyncio.run(coro)


class _Client:
    """Stand-in for the FalkorDB graph client. Records the one call that would destroy data."""
    def __init__(self):
        self.deletes = 0

    async def delete(self):
        self.deletes += 1


async def _no_readers(*_a):
    return []


def _runner(*, ps, shared_with, client, key_in_use=_no_readers):
    """A ``PurgeRunner`` whose session is faked — no DB, no schema.

    ``ps`` is the ProjectionState row (or None); ``shared_with`` is the count of other LIVE graphs
    still projecting into the same FalkorDB name; ``client`` is the stub graph client (or None to
    model "no graph client configured"); ``key_in_use`` answers who else reads the key (the
    management DB's bindings: none, by default — asking the real one needs that database).
    """
    job = SimpleNamespace(id="job1", status="running", retry_count=0, summary={}, updated_at=None)

    class _Session:
        async def get(self, model, ident):
            if model is ProjectionStateORM:
                return ps
            if model is JobORM:
                return job
            raise AssertionError(f"unexpected get({model!r})")

        async def scalar(self, clause, params=None):
            return shared_with

    @asynccontextmanager
    async def _session():
        yield _Session()

    factory = (lambda name, provider: client) if client is not None else None
    return PurgeRunner(graph_factory=factory, session_factory=_session, key_in_use=key_in_use), job


def _landing(job):
    """The purge's lease, as one whose fenced checkpoint lands: the verdict reaches the job row."""
    class _Lease:
        job_id = job.id

        async def checkpoint(self, _s, **values):
            for column, value in values.items():
                setattr(job, column, value)

    return _Lease()


def _ps(owned, name="cust_graph"):
    return SimpleNamespace(falkor_graph_name=name, owns_falkor_graph=owned, falkor_provider=None)


def test_external_graph_is_never_dropped():
    """owns_falkor_graph=False (the default; the federated/customer case) → PROTECTED, untouched."""
    client = _Client()
    runner, job = _runner(ps=_ps(owned=False), shared_with=0, client=client)
    _run(runner._phase_falkor(_landing(job), "g1"))
    assert client.deletes == 0                       # the customer's data is never touched
    assert job.summary["falkor"]["owned"] is False
    assert "PROTECTED" in job.summary["falkor"]["verdict"]


def test_owned_managed_graph_is_dropped():
    """owns_falkor_graph=True (a graph we minted) and not shared → the drop really happens."""
    client = _Client()
    runner, job = _runner(ps=_ps(owned=True, name="blank_ds1"), shared_with=0, client=client)
    _run(runner._phase_falkor(_landing(job), "g1"))
    assert client.deletes == 1                        # our managed/versioned graph is dropped
    assert job.summary["falkor"]["verdict"].startswith("dropped")


def test_owned_but_still_shared_graph_is_protected():
    """Even a graph we own is not dropped while another surviving graph still projects into it."""
    client = _Client()
    runner, job = _runner(ps=_ps(owned=True, name="blank_ds1"), shared_with=2, client=client)
    _run(runner._phase_falkor(_landing(job), "g1"))
    assert client.deletes == 0
    assert "still projected" in job.summary["falkor"]["verdict"]


def test_no_projection_state_is_a_noop():
    """No projection row → nothing to drop; the phase is a no-op, not a destructive guess."""
    client = _Client()
    runner, job = _runner(ps=None, shared_with=0, client=client)
    _run(runner._phase_falkor(_landing(job), "g1"))
    assert client.deletes == 0
    assert job.summary["falkor"]["verdict"] == "no projected graph"


def test_owned_graph_still_read_elsewhere_is_protected():
    """A key we minted that another data source (or a catalog entry) still reads is kept."""
    async def readers(*_a):
        return [{"kind": "dataSource", "id": "ds_other"}]

    client = _Client()
    runner, job = _runner(ps=_ps(owned=True, name="blank_ds1"), shared_with=0, client=client,
                          key_in_use=readers)
    _run(runner._phase_falkor(_landing(job), "g1"))
    assert client.deletes == 0
    assert "still read by" in job.summary["falkor"]["verdict"]


def test_owned_graph_whose_readers_cannot_be_asked_is_protected():
    """No answer to "who else reads it?" keeps the key: the purge fails closed."""
    async def unreachable(*_a):
        raise ConnectionRefusedError("management DB down")

    client = _Client()
    runner, job = _runner(ps=_ps(owned=True, name="blank_ds1"), shared_with=0, client=client,
                          key_in_use=unreachable)
    _run(runner._phase_falkor(_landing(job), "g1"))
    assert client.deletes == 0
    assert job.summary["falkor"]["verdict"].startswith("PROTECTED: could not check")

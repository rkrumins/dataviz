"""Property operations: one property set, filled, renamed or removed across everything a search
matches, written into a draft by a job (``graphver.jobs``, type ``property_op``).

The Property Manager picks entities with an Advanced Search and one operation on one property
(:mod:`.property_directive`). The job writes it into the open draft, in phases:

* **waiting** — while the published graph catches up with ``main``: the search reads it, and the
  context hook answers ``None`` until it is fresh.
* **finding** — the search's matches on the published graph (``deep_search_scan``), narrowed to what
  the operation can change: ``fillEmpty`` to the nodes whose key is empty, ``rename`` / ``remove``
  to those that have it. The narrowing judges each node by its published value, so the nodes the
  draft changed are then re-checked against the search alone (``deep_search_membership``) — the
  draft may have emptied a key the published graph still holds. An operation that would leave the
  draft with more than ``PROPERTY_OP_MAX_DRAFT_CHANGES`` changes is refused here, before it writes.
* **applying** — ``PROPERTY_OP_WINDOW`` entities a commit, each decided on its value in the draft
  inside that commit. What the ontology refuses is skipped and counted, the window written without
  it.

Between windows it stops when asked (:meth:`PropertyOps.cancel`), or when the draft was published or
discarded; what it already wrote stays. A draft runs one operation at a time, never beside its
publish.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence

from sqlalchemy import select, update

from backend.common.models.search import SearchQuery

from . import config, db, property_directive
from .import_export.import_worker import heartbeat
from .import_export.runner import QUEUED
from .import_export.snapshot import open_snapshot
from .models import BranchORM, JobORM
from .service import ConcurrencyError, GraphVersioningService, OntologyViolation

#: How often a job waiting for the published graph asks again, and for how long.
_WAIT_POLL_S = 5.0
_WAIT_MAX_S = 1800.0
#: URNs per re-check (the most one membership call takes).
_RECHECK_BATCH = 1000
#: More tries at a window that kept losing the race for the draft's next commit.
_CONTENTION_RETRIES = 3
_LIVE = ("pending", "running")
#: A closed draft's status, as the user knows it.
_CLOSED = {"abandoned": "discarded", "merged": "published"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclasses.dataclass
class OpContext:
    """What a job needs from the API layer, which owns the providers and the ontology."""

    provider: Any                                  # the published graph's search
    run_context: Any                               # its SearchRunContext (version, scope, admission)
    containment_edge_types: Sequence[str]
    ontology_rules: Any
    on_written: Callable[[], Awaitable[None]]      # after each commit: the draft's reads refreshed


class PropertyOpRunning(RuntimeError):
    """Another property operation on this draft is pending or running."""

    def __init__(self, job_id: str) -> None:
        super().__init__(f"a property operation ({job_id}) is already running on this draft")
        self.job_id = job_id


class PublishRunning(RuntimeError):
    """This draft is being published."""

    def __init__(self, job_id: str) -> None:
        super().__init__(f"this draft is being published ({job_id})")
        self.job_id = job_id


def running_refusal(job_id: str) -> Dict[str, Any]:
    """How a publish, merge or pull of a draft is refused while an operation is written into it."""
    return {"type": "property_op_running", "jobId": job_id,
            "message": "A property operation is being written into this draft. Wait for it to "
                       "finish, or stop it, first."}


class _Stopped(Exception):
    """The job ends here as ``status``, telling the user ``message`` (none when asked to stop)."""

    def __init__(self, status: str, message: Optional[str] = None) -> None:
        super().__init__(message or status)
        self.status, self.message = status, message


def op_label(op: Dict[str, Any]) -> str:
    """The operation as its commits name it: ``Set owner = alice``."""
    key = op["key"]
    if op["kind"] == "set":
        return f"Set {key} = {_shown(op['value'])}"
    if op["kind"] == "fillEmpty":
        return f"Fill empty {key} with {_shown(op['value'])}"
    if op["kind"] == "rename":
        return f"Rename {key} to {op['newKey']}"
    return f"Remove {key}"


def _shown(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value)
    return text if len(text) <= 80 else text[:79] + "…"


def _narrowed(query: SearchQuery, op: Dict[str, Any]) -> Optional[SearchQuery]:
    """The search narrowed to what the operation can change — or ``None``: a ``set`` changes any
    match (search compares across types, so ``NOT eq`` would pass over a ``"42"`` it retypes to
    ``42``), and a search using ``withinHops`` can't be re-checked one entity at a time."""
    if op["kind"] == "fillEmpty":
        need = {"kind": "property", "key": op["key"], "op": "isEmpty"}
    elif op["kind"] in ("rename", "remove"):
        need = {"kind": "hasProperty", "key": op["key"]}
    else:
        return None
    if "withinHops" in _kinds(query.predicate):
        return None
    wire = query.model_dump(mode="json", by_alias=True)
    wire["predicate"] = {"kind": "group", "op": "and", "children": [wire["predicate"], need]}
    return SearchQuery.model_validate(wire)


def _kinds(predicate) -> set:
    return {predicate.kind}.union(*(_kinds(c) for c in getattr(predicate, "children", None) or ()))


def _alive(row: JobORM) -> bool:
    """A pending or running job still showing life: one silent past the stale rule
    (``ImportExportService.get_job``) died with its process."""
    from .import_export.service import _silent_secs

    queued = row.status == "pending" and row.current_phase == QUEUED
    return row.status in _LIVE and _silent_secs(row) <= (
        config.TRANSFER_QUEUE_TIMEOUT_SECS if queued else config.JOB_STALE_AFTER_SECS)


async def _live_job(s, graph_id: str, branch_id: str, job_types: Sequence[str]) -> Optional[JobORM]:
    """A job of ``job_types`` on this draft that is pending or running, and alive."""
    for row in (await s.execute(select(JobORM).where(
            JobORM.graph_id == graph_id, JobORM.branch_id == branch_id,
            JobORM.job_type.in_(job_types), JobORM.status.in_(_LIVE)))).scalars():
        if _alive(row):
            return row
    return None


def _expire(row: JobORM) -> None:
    """Fail a job that died with its process, as ``get_job`` does."""
    from .import_export.service import _INTERRUPTED, _NOT_STARTED

    if row.status in _LIVE and not _alive(row):
        queued = row.status == "pending" and row.current_phase == QUEUED
        row.status, row.completed_at = "failed", _now()
        row.error_message = _NOT_STARTED if queued else _INTERRUPTED


def _wire(row: JobORM) -> Dict[str, Any]:
    fields = row.field_scope or {}
    phase = QUEUED if row.status == "pending" else row.current_phase if row.status == "running" else None
    return {
        "jobId": row.id, "kind": fields.get("kind", "apply"), "status": row.status, "phase": phase,
        "cancelRequested": bool(fields.get("cancel")), "graphId": row.graph_id,
        "branchId": row.branch_id, "viewId": row.scope_view_id, "actor": fields.get("actor"),
        "op": fields.get("op"), "predicate": (fields.get("query") or {}).get("predicate"),
        "expectedCount": fields.get("expectedCount"), "processed": row.processed, "total": row.total,
        "percent": row.progress, "summary": row.summary, "error": row.error_message,
        "createdAt": row.created_at, "startedAt": row.started_at, "completedAt": row.completed_at,
    }


def _too_many(room: int, before: int) -> str:
    return (f"This operation would change more than {room:,} entities, and a draft holds at most "
            f"{config.PROPERTY_OP_MAX_DRAFT_CHANGES:,} changes ({before:,} here already). Narrow the "
            "search, or publish this draft and continue in a new one.")


class PropertyOps:
    """Create, follow, stop and run property operations."""

    def __init__(self, versioning: GraphVersioningService,
                 context: Optional[Callable[[Dict[str, Any]], Awaitable[Optional[OpContext]]]]) -> None:
        self._svc = versioning
        # async ``(job) -> OpContext | None`` from the API layer: the published graph's search and
        # the target's ontology — ``None`` while the published graph catches up.
        self._context = context

    async def create(self, *, workspace_id: str, data_source_id: Optional[str], graph_id: str,
                     branch_id: str, view_id: Optional[str], actor: str, op: Dict[str, Any],
                     query: SearchQuery, scope_hash: str, expected_count: Optional[int] = None) -> str:
        """Queue an operation on an open draft; the caller starts it. :class:`PropertyOpRunning` /
        :class:`PublishRunning` while the draft has one, or its publish, under way."""
        property_directive.check(op)
        async with db.graphver_session() as s:
            # Two requests at once would each see no job under way and each add one: the draft's
            # row, locked, puts them one after the other.
            branch = (await s.execute(select(BranchORM).where(BranchORM.id == branch_id)
                                      .with_for_update())).scalar_one_or_none()
            if branch is None or branch.graph_id != graph_id:
                raise ValueError(f"unknown branch {branch_id}")
            if branch.kind == "main" or branch.status != "open":
                raise ValueError(f"branch {branch_id} is not an open draft")
            await self._svc._assert_not_bootstrapping(s, graph_id)
            live = await _live_job(s, graph_id, branch_id, ("property_op", "publish"))
            if live is not None:
                raise (PropertyOpRunning if live.job_type == "property_op" else PublishRunning)(live.id)
            job = JobORM(job_type="property_op", graph_id=graph_id, workspace_id=workspace_id,
                         data_source_id=data_source_id, branch_id=branch_id, scope_view_id=view_id,
                         status="pending", field_scope={
                             "kind": "apply", "actor": actor, "op": dict(op),
                             "query": query.model_dump(mode="json", by_alias=True),
                             "scopeHash": scope_hash, "expectedCount": expected_count})
            s.add(job)
            await s.flush()
            return job.id

    async def running(self, *, graph_id: str, branch_id: str) -> Optional[str]:
        """The operation being written into this draft — pending or running, and alive — or None."""
        async with db.graphver_session() as s:
            live = await _live_job(s, graph_id, branch_id, ("property_op",))
            return live.id if live is not None else None

    async def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None or row.job_type != "property_op":
                return None
            _expire(row)
            return _wire(row)

    async def list(self, *, graph_id: str, branch_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        """A draft's operations, newest first."""
        async with db.graphver_session() as s:
            rows = (await s.execute(select(JobORM).where(
                JobORM.graph_id == graph_id, JobORM.branch_id == branch_id,
                JobORM.job_type == "property_op").order_by(JobORM.created_at.desc())
                .limit(limit))).scalars().all()
            for row in rows:
                _expire(row)
            return [_wire(row) for row in rows]

    async def cancel(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Stop an operation: a pending one at once, a running one once the window it is writing
        lands. What it wrote stays."""
        async with db.graphver_session() as s:
            row = (await s.execute(select(JobORM).where(JobORM.id == job_id)
                                   .with_for_update())).scalar_one_or_none()
            if row is None or row.job_type != "property_op":
                return None
            _expire(row)
            if row.status == "pending":
                row.status, row.completed_at = "cancelled", _now()
            elif row.status == "running":
                row.field_scope = {**(row.field_scope or {}), "cancel": True}
            return _wire(row)

    async def run(self, job_id: str) -> Dict[str, Any]:
        """Run the operation to its end — completed, cancelled, or failed saying why. Its summary."""
        job = await self._begin(job_id)
        if job is None:                                   # stopped before it started
            return ((await self.get(job_id)) or {}).get("summary") or {}
        summary: Dict[str, Any] = {
            "matched": 0, "applied": 0, "unchanged": 0, "notInDraft": 0,
            "skipped": {"targetExists": 0, "ontology": 0}, "commits": [],
            "draftChangesBefore": None, "timings": {}}
        beat = asyncio.create_task(heartbeat(job_id))
        try:
            await self._run(job_id, job, summary)
            status, error = "completed", None
        except _Stopped as stop:
            status, error = stop.status, stop.message
        finally:
            beat.cancel()
        async with db.graphver_session() as s:
            await s.execute(update(JobORM).where(JobORM.id == job_id).values(
                status=status, error_message=error, summary=summary, current_phase=None,
                completed_at=_now(), updated_at=_now(),
                **({"progress": 100} if status == "completed" else {})))
        return summary

    async def _begin(self, job_id: str) -> Optional[Dict[str, Any]]:
        async with db.graphver_session() as s:
            row = (await s.execute(select(JobORM).where(JobORM.id == job_id)
                                   .with_for_update())).scalar_one_or_none()
            if row is None or row.status not in _LIVE:
                return None
            row.status = "running"
            row.started_at = row.started_at or _now()
            row.updated_at = _now()
            fields = row.field_scope or {}
            return {"jobId": row.id, "graphId": row.graph_id, "branchId": row.branch_id,
                    "workspaceId": row.workspace_id, "dataSourceId": row.data_source_id,
                    "viewId": row.scope_view_id, "actor": fields.get("actor"), "op": fields["op"],
                    "query": fields["query"], "scopeHash": fields.get("scopeHash")}

    async def _run(self, job_id: str, job: Dict[str, Any], summary: Dict[str, Any]) -> None:
        graph_id, branch_id, op = job["graphId"], job["branchId"], job["op"]
        timings = summary["timings"]
        if self._context is None:
            raise _Stopped("failed", "Property operations can't run here: no search is configured.")

        started = time.monotonic()
        await self._phase(job_id, "waiting")
        while True:
            await self._check(job_id, branch_id)
            ctx = await self._context(job)
            if ctx is not None:
                break
            if time.monotonic() - started > _WAIT_MAX_S:
                raise _Stopped("failed", "The published graph didn't catch up with the latest "
                                         "changes in time. Try again in a few minutes.")
            await asyncio.sleep(_WAIT_POLL_S)
        timings["waitingMs"] = int((time.monotonic() - started) * 1000)

        started = time.monotonic()
        await self._phase(job_id, "finding")
        before = await self._svc.branch_change_count(graph_id=graph_id, branch_id=branch_id)
        summary["draftChangesBefore"] = before
        room = config.PROPERTY_OP_MAX_DRAFT_CHANGES - before
        if room <= 0:
            raise _Stopped("failed", f"This draft already holds {before:,} changes, the most a "
                                     "property operation may leave it with. Publish it and continue "
                                     "in a new draft.")
        query = SearchQuery.model_validate(job["query"])
        narrowed = _narrowed(query, op)
        found = await ctx.provider.deep_search_scan(narrowed or query, context=ctx.run_context, cap=room)
        if found.over_cap:
            raise _Stopped("failed", _too_many(room, before))
        urns = list(dict.fromkeys(found.urns))
        if narrowed is not None:
            urns += await self._recheck(ctx, job, query, set(urns))
            if len(urns) > room:
                raise _Stopped("failed", _too_many(room, before))
        summary["matched"] = len(urns)
        timings["findingMs"] = int((time.monotonic() - started) * 1000)

        started = time.monotonic()
        await self._phase(job_id, "applying", total=len(urns), processed=0, progress=0)
        # The search's URNs are the published graph's: its ids for them are main's, and each is then
        # decided on its value in the draft (not live there: skipped as notInDraft).
        published = await open_snapshot(graph_id=graph_id)
        label, window = op_label(op), max(1, config.PROPERTY_OP_WINDOW)
        parts = -(-len(urns) // window)
        for part in range(parts):
            await self._check(job_id, branch_id, done=part, parts=parts)
            chunk = urns[part * window:(part + 1) * window]
            ids = await published.nodes_by_urn(chunk)
            summary["notInDraft"] += len(chunk) - len(ids)
            outcome: Dict[str, List[str]] = {}
            try:
                commit = await self._write(ctx, job, [
                    {"op": "update", "entity_kind": "node", "entity_id": eid, "directive": op}
                    for eid in ids.values()],
                    label if parts == 1 else f"{label} · part {part + 1} of {parts}", outcome, summary)
            except ValueError:
                # Refused because the draft closed since the check above: say that, not the refusal.
                await self._check(job_id, branch_id, done=part, parts=parts)
                raise
            summary["applied"] += len(outcome.get("changed", ()))
            summary["unchanged"] += len(outcome.get("unchanged", ()))
            summary["notInDraft"] += len(outcome.get("notInDraft", ()))
            summary["skipped"]["targetExists"] += len(outcome.get("targetExists", ()))
            if commit is not None:
                summary["commits"].append(commit)
                await ctx.on_written()
            processed = min(len(urns), (part + 1) * window)
            async with db.graphver_session() as s:
                await s.execute(update(JobORM).where(JobORM.id == job_id).values(
                    processed=processed, progress=processed * 100 // len(urns), summary=summary,
                    updated_at=_now()))
        timings["applyingMs"] = int((time.monotonic() - started) * 1000)

    async def _recheck(self, ctx: OpContext, job: Dict[str, Any], query: SearchQuery,
                       found: set) -> List[str]:
        """The nodes the draft changed that the search alone matches, beyond ``found``."""
        changed = [u for u in await self._svc.draft_node_urns(
            graph_id=job["graphId"], branch_id=job["branchId"]) if u not in found]
        more: List[str] = []
        for i in range(0, len(changed), _RECHECK_BATCH):
            answer = await ctx.provider.deep_search_membership(
                query.scope, [("op", query.predicate)], changed[i:i + _RECHECK_BATCH],
                context=ctx.run_context)
            if answer.get("errors"):
                raise RuntimeError(f"re-checking the draft's changes failed: {answer['errors']}")
            more += answer["matches"].get("op", [])
        return more

    async def _write(self, ctx: OpContext, job: Dict[str, Any], ops: List[Dict[str, Any]],
                     message: str, outcome: Dict[str, List[str]], summary: Dict[str, Any]) -> Optional[str]:
        """One window, one commit. What the ontology refuses is dropped and the window written
        again without it — once: a second refusal fails the job. A window that kept losing the race
        for the draft's next commit to other writers is tried again, after a pause."""
        refused: set = set()
        contention = 0
        while True:
            try:
                return await self._svc.apply_ops(
                    graph_id=job["graphId"], branch_id=job["branchId"], actor=job["actor"],
                    ops=[o for o in ops if o["entity_id"] not in refused], message=message,
                    containment_edge_types=ctx.containment_edge_types,
                    ontology_rules=ctx.ontology_rules, outcome=outcome)
            except OntologyViolation as exc:
                named = {v.get("entity_id") for v in exc.violations} & {o["entity_id"] for o in ops}
                if refused or not named:
                    raise
                refused = named
                summary["skipped"]["ontology"] += len(named)
            except ConcurrencyError:
                contention += 1
                if contention > _CONTENTION_RETRIES:
                    raise
                await asyncio.sleep(2 ** contention)

    async def _phase(self, job_id: str, phase: str, **values: Any) -> None:
        async with db.graphver_session() as s:
            await s.execute(update(JobORM).where(JobORM.id == job_id).values(
                current_phase=phase, updated_at=_now(), **values))

    async def _check(self, job_id: str, branch_id: str, *, done: int = 0, parts: int = 0) -> None:
        """Stop here when asked to, or when the draft was published or discarded."""
        async with db.graphver_session() as s:
            fields = (await s.execute(select(JobORM.field_scope).where(JobORM.id == job_id))).scalar_one()
            status = (await s.execute(select(BranchORM.status).where(
                BranchORM.id == branch_id))).scalar_one_or_none()
        if (fields or {}).get("cancel"):
            raise _Stopped("cancelled")
        if status != "open":
            where = f" after part {done} of {parts}" if done else ""
            raise _Stopped("failed", f"The draft was {_CLOSED.get(status, status or 'deleted')} while "
                                     f"the operation ran, so it stopped{where}.")

"""Lifecycle of a versioned graph: what deleting one actually costs, and what it does not.

Deleting a data source currently removes ONE row and orphans everything derived from it — on the
dev database, 2,277 of 2,302 versioned graphs (98.9%) have no data source left, and 23 GB of
history nobody can reach. This module is the honest half of fixing that: before we destroy
anything, we say precisely what is about to be destroyed.

Two principles, and the second is the one people get wrong:

  1. NAME THE IRREPLACEABLE THING. A graph's version rows can be regenerated from the source. Its
     COMMITS, DRAFTS AND CURATION cannot — those are the hours a human spent. A confirmation that
     says "2.1 GB" is describing the cheap part. One that says "3 open drafts, by alice@ and bob@"
     is describing the expensive part.

  2. SAY WHAT IS SAFE. A data source is usually pinned to the customer's OWN FalkorDB graph
     (`nexus_lineage`), which we did not create and will never delete. A user about to click a red
     button deserves to know that before they click it, not after. A dialog that lists only
     horrors is one people learn to click through — and then it has taught them to ignore the one
     that mattered.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import func, select, text, update

from .db import graphver_session
from .models import (
    BranchORM,
    CommitORM,
    EdgeVersionORM,
    EntityHeadORM,
    GraphORM,
    JobORM,
    MergeRequestORM,
    NodeVersionORM,
    ProjectionStateORM,
)

logger = logging.getLogger(__name__)

# What one version row costs on disk, roughly — payload JSONB plus index overhead. Only ever used
# to put a HUMAN-READABLE size on a confirmation dialog, never to make a decision.
_BYTES_PER_VERSION_ROW = 900


async def versioning_impact(data_source_id: str, workspace_id: str) -> Optional[dict]:
    """What deleting `data_source_id` would cost. None when version control was never enabled.

    Every number here is COUNTED, not estimated — except the byte figure, which is explicitly a
    rough size for a human to read and is never used to decide anything. A confirmation dialog
    that invents its numbers is theatre, and the moment a user notices, every future warning we
    show them is worth less.
    """
    async with graphver_session() as s:
        graph = (await s.execute(
            select(GraphORM).where(
                GraphORM.data_source_id == data_source_id,
                GraphORM.workspace_id == workspace_id,
                GraphORM.deleted_at.is_(None),
            ))).scalars().first()
        if graph is None:
            return None

        gid = graph.id
        commits = await s.scalar(
            select(func.count()).select_from(CommitORM).where(CommitORM.graph_id == gid)) or 0

        # Open drafts — the casualty everyone forgets. Someone has unpublished work in here, and
        # they are not the person clicking Delete.
        drafts = (await s.execute(
            select(BranchORM.id, BranchORM.name, BranchORM.owner)
            .where(BranchORM.graph_id == gid, BranchORM.kind == "draft"))).all()

        reviews = await s.scalar(
            select(func.count()).select_from(MergeRequestORM).where(
                MergeRequestORM.graph_id == gid,
                MergeRequestORM.status.in_(("open", "in_review")))) or 0

        # CURATION: entities a HUMAN touched. Rows written by the import/sync machinery can be
        # rebuilt from the source; these cannot. This is the number that should stop someone's
        # hand on the way to the button — which is exactly why it must be TRUE.
        #
        # It is derived from the COMMIT KIND, not from `change_reason`. `change_reason` is NULL on
        # every bootstrap row (the worker never sets it), so keying on NULL reported 289,616
        # "curated" entities on a graph where a human had touched precisely zero — a number that
        # would have made every future warning we show worth less. `genesis`/`import`/`sync` are
        # the machine; everything else (edit, checkpoint, squash_publish, revert, restore) is a
        # person deciding something.
        curated = await s.scalar(
            select(func.count(func.distinct(NodeVersionORM.entity_id)))
            .select_from(NodeVersionORM)
            .join(CommitORM, (CommitORM.graph_id == NodeVersionORM.graph_id)
                             & (CommitORM.id == NodeVersionORM.commit_id))
            .where(NodeVersionORM.graph_id == gid,
                   CommitORM.kind.notin_(("genesis", "import", "sync")))) or 0

        rows = (await s.scalar(
            select(func.count()).select_from(NodeVersionORM).where(
                NodeVersionORM.graph_id == gid)) or 0) + (await s.scalar(
            select(func.count()).select_from(EdgeVersionORM).where(
                EdgeVersionORM.graph_id == gid)) or 0)

        ps = await s.get(ProjectionStateORM, gid)

    return {
        "versioned": True,
        "commits": int(commits),
        # `owner` is the raw user id — graphver does not know about users, and is not going to
        # start. The repository layer, which already holds an app-DB session, turns these into
        # names. Most drafts are called "Untitled draft", so the owner IS the identifying
        # information: "3 drafts will be deleted" is a statistic, "Priya's draft will be deleted"
        # is a reason to stop.
        "openDrafts": [
            {"id": d[0], "name": d[1] or "Untitled draft", "owner": d[2] or ""}
            for d in drafts
        ],
        "openReviews": int(reviews),
        "curatedEntities": int(curated),
        "storageBytes": int(rows) * _BYTES_PER_VERSION_ROW,
        # THE REASSURANCE. `owns_falkor_graph` is a recorded fact, set at creation — we own the
        # graph iff we minted its name. A bootstrapped source is pinned to the customer's own
        # graph, and no lifecycle operation may ever touch it.
        "falkorGraphName": (ps.falkor_graph_name if ps else None),
        "falkorGraphOwned": bool(ps.owns_falkor_graph) if ps else False,
    }


# ---------------------------------------------------------------- moving a data source --
_ACTIVE_JOB = ("pending", "running")


class GraphBusy(Exception):
    """A job is writing this graph right now; moving it would strand the job in the old workspace."""

    def __init__(self, job_type: str):
        super().__init__(job_type)
        self.job_type = job_type


async def relocation_facts(data_source_id: str) -> Optional[dict]:
    """What moving `data_source_id` to another workspace takes with it. None when version control
    was never enabled.

    Looked up by data source alone: the graph's own ``workspace_id`` is exactly what a move
    rewrites, and a copy left stale by an earlier move must not hide the graph from this one.
    """
    async with graphver_session() as s:
        graph = (await s.execute(
            select(GraphORM).where(
                GraphORM.data_source_id == data_source_id,
                GraphORM.deleted_at.is_(None),
            ))).scalars().first()
        if graph is None:
            return None
        gid = graph.id
        active = (await s.execute(
            select(JobORM.job_type).where(JobORM.graph_id == gid, JobORM.status.in_(_ACTIVE_JOB))
        )).scalars().all()
        commits = await s.scalar(
            select(func.count()).select_from(CommitORM).where(CommitORM.graph_id == gid)) or 0
        # Open drafts only: a merged or abandoned draft is history, not someone's work in flight.
        drafts = (await s.execute(
            select(BranchORM.id, BranchORM.name, BranchORM.owner).where(
                BranchORM.graph_id == gid,
                BranchORM.kind == "draft",
                BranchORM.status.in_(("open", "publishing")),
            ))).all()
        reviews = await s.scalar(
            select(func.count()).select_from(MergeRequestORM).where(
                MergeRequestORM.target_graph_id == gid,
                MergeRequestORM.status.notin_(("merged", "closed")))) or 0
        forks = await s.scalar(
            select(func.count()).select_from(GraphORM).where(
                GraphORM.fork_parent_graph_id == gid, GraphORM.deleted_at.is_(None))) or 0
    return {
        "graphId": gid,
        "activeJobs": sorted(set(active)),
        "commits": int(commits),
        "openDrafts": [{"id": d[0], "name": d[1] or "Untitled draft", "owner": d[2] or ""}
                       for d in drafts],
        "openReviews": int(reviews),
        "forks": int(forks),
    }


async def relocate_graph(data_source_id: str, workspace_id: str, *,
                         check_busy: bool = True) -> Optional[str]:
    """File `data_source_id`'s versioned graph, and every job ever run on it, under
    `workspace_id`. Returns the graph id, or None when the source isn't versioned.

    The versioning API decides tenancy from ``graphs.workspace_id`` and the bootstrap's status,
    retry and abandon from ``jobs.workspace_id`` — a graph left behind would stay writable from
    the workspace the source left and unreachable from the one it joined. It SETS the workspace
    rather than swapping one for another, so running it again (or moving the source again) heals
    a split left by a failure between the two stores.

    Takes the lock merges and publishes take (``_lock_graph``), so none lands mid-move, and
    refuses with :class:`GraphBusy` while a job is pending or running unless `check_busy` is
    False — which only compensation passes, to put back what a failed move just changed.
    """
    async with graphver_session() as s:
        if s.bind.dialect.name == "postgresql":
            # Wait briefly for a merge in flight; never queue a request behind a long one.
            await s.execute(text("SET LOCAL lock_timeout = '5s'"))
        graph = (await s.execute(
            select(GraphORM).where(GraphORM.data_source_id == data_source_id).with_for_update()
        )).scalars().first()
        if graph is None:
            return None
        await s.execute(select(func.pg_advisory_xact_lock(func.hashtext(graph.id))))
        if check_busy:
            busy = (await s.execute(
                select(JobORM.job_type).where(
                    JobORM.graph_id == graph.id, JobORM.status.in_(_ACTIVE_JOB)).limit(1)
            )).scalars().first()
            if busy:
                raise GraphBusy(busy)
        graph.workspace_id = workspace_id
        await s.execute(
            update(JobORM).where(JobORM.graph_id == graph.id).values(workspace_id=workspace_id))
        return graph.id

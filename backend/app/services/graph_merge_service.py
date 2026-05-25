"""Same-graph three-way merge orchestrator.

Bridges the pure :mod:`backend.app.services.graph_versioning.merge`
engine to the persisted Graph Store. Two operations:

- :func:`plan_merge` — compute the merge for ``source_branch`` into
  ``target_branch`` of one graph. Loads the LCA, runs the pure
  three-way merge, runs post-merge integrity check, persists a
  ``GraphMergeORM`` row + ``GraphMergeConflictORM`` rows. If the
  result is clean + ``auto_commit_if_clean=True``, also commits the
  merge inline using the standard commit path.

- :func:`commit_resolved_merge` — re-load the snapshots, re-apply the
  caller-supplied resolutions, re-run integrity check, and persist a
  merge commit with two parents.

Both operations advance the ``target_branch`` ref via the existing
``persist_commit`` CAS guard — a concurrent commit on the target
between plan + commit fails with :class:`HeadMovedError` and the
client re-plans.

Cross-graph merges (PR from a fork) reuse this engine in Phase 2.5 —
the source snapshot then comes from a different graph_id but the
algorithm is identical (content hashes are global semantic
identities). Out of scope this round.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Mapping

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models_graph import (
    GraphChangeEventORM,
    GraphCommitContributorORM,
    GraphCommitORM,
    GraphEdgeVersionORM,
    GraphMergeConflictORM,
    GraphMergeORM,
    GraphNodeVersionORM,
)
from backend.app.db.repositories import graph_repo, graph_store_outbox_repo
from backend.app.db.repositories.graph_commit_repo import (
    HeadMovedError,
    persist_commit,
)
from backend.app.services.graph_versioning.commit import (
    EdgeState,
    EmptyCommitError,
    NodeState,
    plan_commit,
)
from backend.app.services.graph_versioning.merge import (
    EntryMap,
    IntegrityViolation,
    MergeConflict,
    MergeOutcome,
    apply_resolutions,
    run_post_merge_checks,
    three_way_merge,
)
from backend.app.services.graph_versioning.validation import OntologySpec


# A few SQLAlchemy CHECK constraints in models_graph.py constrain
# conflict_class to a fixed enum; the pure engine emits a different
# but overlapping set. Map between the two so the persistence layer
# is consistent.
_PURE_TO_DB_CONFLICT_CLASS = {
    "add_add": "add_add",
    "edit_delete": "edit_delete",
    "modify_modify": "attr",  # the DB enum lacks modify_modify; "attr" is the closest
}


class MergeNotFoundError(LookupError):
    pass


class MergeNotResolvableError(ValueError):
    """Caller asked to commit a merge that has unresolved conflicts or
    integrity violations after applying their resolutions."""


@dataclass(frozen=True)
class MergePlan:
    """Public DTO returned by :func:`plan_merge`. Subset of
    ``GraphMergeORM`` + the engine output so the API layer doesn't
    need to project the ORM itself."""

    merge_id: str
    graph_id: str
    source_branch: str
    target_branch: str
    base_commit_id: str | None
    source_commit_id: str | None
    target_commit_id: str | None
    status: str                              # 'open' | 'committed'
    has_no_conflicts: bool
    has_no_integrity_violations: bool
    is_mergeable: bool
    auto_entry_count: int
    conflicts: list[dict[str, Any]]
    integrity_violations: list[dict[str, Any]]
    result_commit_id: str | None             # set when auto-committed
    delta_summary: Mapping[str, int] | None


# ── LCA walk ───────────────────────────────────────────────────────


async def find_merge_base(
    session: AsyncSession, *, graph_id: str,
    head_a: str | None, head_b: str | None,
) -> str | None:
    """Lowest common ancestor of two commits. Bidirectional BFS over
    ``parent_ids``; first commit seen by both sides is the LCA.
    Returns None for two empty branches or two disjoint histories.

    Bounded by graph **history** depth, not graph content size. Phase
    3 can swap in commit-order indexing for O(1) LCA on linear
    histories; for Phase 2 the walk is fine.
    """
    if head_a is None or head_b is None:
        return None

    visited_a: set[str] = set()
    visited_b: set[str] = set()
    queue_a: list[str] = [head_a]
    queue_b: list[str] = [head_b]

    async def _parents_of(commit_id: str) -> list[str]:
        row = (
            await session.execute(
                select(GraphCommitORM.parent_ids).where(
                    GraphCommitORM.id == commit_id
                )
            )
        ).scalar_one_or_none()
        return list(row or [])

    while queue_a or queue_b:
        if queue_a:
            cid = queue_a.pop(0)
            if cid in visited_b:
                return cid
            if cid not in visited_a:
                visited_a.add(cid)
                queue_a.extend(await _parents_of(cid))
        if queue_b:
            cid = queue_b.pop(0)
            if cid in visited_a:
                return cid
            if cid not in visited_b:
                visited_b.add(cid)
                queue_b.extend(await _parents_of(cid))
    return None


# ── snapshot materialisation (entry map → NodeState/EdgeState) ─────


async def materialize_entries(
    session: AsyncSession, *, graph_id: str, entries: EntryMap,
) -> tuple[dict[str, NodeState], dict[str, EdgeState]]:
    """Resolve content hashes in *entries* back to full
    ``NodeState`` / ``EdgeState``. Required by the commit path to
    build the new snapshot — ``plan_commit`` content-addresses
    everything itself, so re-fetching the blob and handing it back
    is the cleanest way to reuse the existing commit pipeline.
    """
    node_hashes = {k: h for k, (kind, h) in entries.items() if kind == "node"}
    edge_hashes = {k: h for k, (kind, h) in entries.items() if kind == "edge"}

    nodes: dict[str, NodeState] = {}
    edges: dict[str, EdgeState] = {}

    if node_hashes:
        rows = (
            await session.execute(
                select(GraphNodeVersionORM).where(
                    GraphNodeVersionORM.graph_id == graph_id,
                    GraphNodeVersionORM.content_hash.in_(set(node_hashes.values())),
                )
            )
        ).scalars()
        by_hash: dict[str, GraphNodeVersionORM] = {}
        for r in rows:
            by_hash[r.content_hash] = r
        for k, h in node_hashes.items():
            r = by_hash.get(h)
            if r is None:
                raise LookupError(
                    f"node version {h!r} for key {k!r} missing on graph {graph_id!r}"
                )
            nodes[k] = NodeState(
                key=k,
                entity_type=r.entity_type,
                display_name=r.display_name,
                position=r.position,
                properties=dict(r.properties or {}),
                tags=tuple(r.tags or []),
            )

    if edge_hashes:
        rows = (
            await session.execute(
                select(GraphEdgeVersionORM).where(
                    GraphEdgeVersionORM.graph_id == graph_id,
                    GraphEdgeVersionORM.content_hash.in_(set(edge_hashes.values())),
                )
            )
        ).scalars()
        by_hash_e: dict[str, GraphEdgeVersionORM] = {}
        for r in rows:
            by_hash_e[r.content_hash] = r
        for k, h in edge_hashes.items():
            r = by_hash_e.get(h)
            if r is None:
                raise LookupError(
                    f"edge version {h!r} for key {k!r} missing on graph {graph_id!r}"
                )
            edges[k] = EdgeState(
                key=k,
                source_key=r.source_node_key,
                target_key=r.target_node_key,
                edge_type=r.edge_type,
                confidence=r.confidence,
                properties=dict(r.properties or {}),
            )

    return nodes, edges


# ── edge endpoint resolver (for integrity check) ───────────────────


async def build_edge_endpoint_resolver(
    session: AsyncSession, *, graph_id: str, edge_hashes: set[str],
):
    """Prefetch every edge endpoint we'll need during integrity check
    and return a sync resolver per the merge.py contract
    ``content_hash -> (source, target, edge_type)``."""
    cache: dict[str, tuple[str, str, str | None]] = {}
    if edge_hashes:
        rows = (
            await session.execute(
                select(GraphEdgeVersionORM).where(
                    GraphEdgeVersionORM.graph_id == graph_id,
                    GraphEdgeVersionORM.content_hash.in_(edge_hashes),
                )
            )
        ).scalars()
        for r in rows:
            cache[r.content_hash] = (
                r.source_node_key, r.target_node_key, r.edge_type,
            )

    def _resolve(h: str) -> tuple[str, str, str | None]:
        if h not in cache:
            raise KeyError(f"edge hash {h!r} not primed")
        return cache[h]

    return _resolve


# ── conflict serialisation ─────────────────────────────────────────


def _serialise_conflicts(conflicts: tuple[MergeConflict, ...]) -> list[dict[str, Any]]:
    return [
        {
            "key": c.key,
            "kind": c.kind,
            "conflict_class": c.conflict_class,
            "base_content_hash": c.base_hash,
            "source_content_hash": c.theirs_hash,   # "theirs" = source branch
            "target_content_hash": c.ours_hash,     # "ours"   = target branch
        }
        for c in conflicts
    ]


def _serialise_violations(vs: tuple[IntegrityViolation, ...]) -> list[dict[str, Any]]:
    return [{"code": v.code, "detail": v.detail, "key": v.key} for v in vs]


# ── plan_merge ─────────────────────────────────────────────────────


async def plan_merge(
    session: AsyncSession,
    *,
    graph_id: str,
    source_branch: str,
    target_branch: str,
    user_id: str | None,
    message: str | None = None,
    auto_commit_if_clean: bool = False,
    ontology: OntologySpec | None = None,
) -> MergePlan:
    """Compute the three-way merge and persist a ``GraphMergeORM`` row.

    The engine's "ours" = the **target** branch (we are merging into
    it). "theirs" = the **source** branch. This matches the Git
    convention ``git checkout target; git merge source``.

    On clean-and-integrity-clean + ``auto_commit_if_clean=True``, the
    merge commit is created inline and the returned plan carries
    ``status='committed'`` + ``result_commit_id``. Otherwise the plan
    has ``status='open'`` and the caller drives ``commit_resolved_merge``.
    """
    if source_branch == target_branch:
        raise ValueError("source_branch and target_branch must differ")

    target_ref = await graph_repo.get_branch_ref(
        session, graph_id=graph_id, branch=target_branch,
    )
    source_ref = await graph_repo.get_branch_ref(
        session, graph_id=graph_id, branch=source_branch,
    )
    target_commit_id = target_ref.commit_id
    source_commit_id = source_ref.commit_id
    base_commit_id = await find_merge_base(
        session, graph_id=graph_id,
        head_a=target_commit_id, head_b=source_commit_id,
    )

    base_snap = await graph_repo.load_snapshot(
        session, graph_id=graph_id, commit_id=base_commit_id,
    )
    ours_snap = await graph_repo.load_snapshot(
        session, graph_id=graph_id, commit_id=target_commit_id,
    )
    theirs_snap = await graph_repo.load_snapshot(
        session, graph_id=graph_id, commit_id=source_commit_id,
    )

    outcome: MergeOutcome = three_way_merge(base_snap, ours_snap, theirs_snap)

    if outcome.has_no_conflicts:
        edge_hashes = {
            h for (_kind, h) in outcome.auto.values()
            if _kind == "edge"
        }
        resolver = await build_edge_endpoint_resolver(
            session, graph_id=graph_id, edge_hashes=edge_hashes,
        )
        outcome = run_post_merge_checks(
            outcome,
            get_edge_endpoints=resolver,
            containment_edge_types=(
                ontology.containment_edge_types if ontology else frozenset()
            ),
        )

    merge_id = f"gmrg_{uuid.uuid4().hex[:12]}"
    session.add(
        GraphMergeORM(
            id=merge_id,
            graph_id=graph_id,
            source_branch=source_branch,
            target_branch=target_branch,
            base_commit_id=base_commit_id,
            source_commit_id=source_commit_id,
            target_commit_id=target_commit_id,
            status="open",
            created_by=user_id,
        )
    )
    for c in outcome.conflicts:
        session.add(
            GraphMergeConflictORM(
                id=f"gmc_{uuid.uuid4().hex[:12]}",
                merge_id=merge_id,
                conflict_class=_PURE_TO_DB_CONFLICT_CLASS.get(
                    c.conflict_class, "attr"
                ),
                object_kind=c.kind,
                object_id=c.key,
                base_value={"content_hash": c.base_hash} if c.base_hash else None,
                source_value={"content_hash": c.theirs_hash} if c.theirs_hash else None,
                target_value={"content_hash": c.ours_hash} if c.ours_hash else None,
            )
        )

    result_commit_id: str | None = None
    delta_summary: Mapping[str, int] | None = None
    final_status = "open"

    if outcome.is_mergeable and auto_commit_if_clean:
        result_commit_id, delta_summary = await _persist_merge_commit(
            session,
            graph_id=graph_id,
            target_branch=target_branch,
            source_branch=source_branch,
            target_commit_id=target_commit_id,
            source_commit_id=source_commit_id,
            base_commit_id=base_commit_id,
            merged_entries=outcome.auto,
            user_id=user_id,
            message=message or (
                f"Merge {source_branch} into {target_branch}"
            ),
            merge_id=merge_id,
        )
        merge_orm = (
            await session.execute(
                select(GraphMergeORM).where(GraphMergeORM.id == merge_id)
            )
        ).scalar_one()
        merge_orm.status = "committed"
        merge_orm.result_commit_id = result_commit_id
        merge_orm.updated_at = _now()
        final_status = "committed"

        await graph_store_outbox_repo.emit(
            session,
            event_type="visualization.graph.merged",
            aggregate_id=graph_id,
            payload={
                "graph_id": graph_id,
                "merge_id": merge_id,
                "source_branch": source_branch,
                "target_branch": target_branch,
                "result_commit_id": result_commit_id,
                "actor": user_id,
            },
        )

    return MergePlan(
        merge_id=merge_id,
        graph_id=graph_id,
        source_branch=source_branch,
        target_branch=target_branch,
        base_commit_id=base_commit_id,
        source_commit_id=source_commit_id,
        target_commit_id=target_commit_id,
        status=final_status,
        has_no_conflicts=outcome.has_no_conflicts,
        has_no_integrity_violations=outcome.has_no_integrity_violations,
        is_mergeable=outcome.is_mergeable,
        auto_entry_count=len(outcome.auto),
        conflicts=_serialise_conflicts(outcome.conflicts),
        integrity_violations=_serialise_violations(outcome.integrity_violations),
        result_commit_id=result_commit_id,
        delta_summary=delta_summary,
    )


# ── commit_resolved_merge ──────────────────────────────────────────


async def commit_resolved_merge(
    session: AsyncSession,
    *,
    merge_id: str,
    resolutions: Mapping[str, tuple[str, str] | None],
    user_id: str | None,
    message: str | None,
    ontology: OntologySpec | None = None,
) -> MergePlan:
    """Apply *resolutions* (one entry per conflict, value=None to
    delete) to a previously-planned merge and commit it. Re-runs the
    three-way merge from scratch so any base/source advance since
    plan time is picked up — if heads moved, the conflict surface may
    differ and the caller must re-resolve.

    Returns the updated MergePlan with ``status='committed'`` on
    success. Raises :class:`MergeNotResolvableError` when integrity
    violations remain after resolution.
    """
    merge_orm = (
        await session.execute(
            select(GraphMergeORM).where(GraphMergeORM.id == merge_id)
        )
    ).scalar_one_or_none()
    if merge_orm is None:
        raise MergeNotFoundError(merge_id)
    if merge_orm.status not in ("open", "resolved"):
        raise MergeNotResolvableError(
            f"merge {merge_id} is in state {merge_orm.status!r}"
        )

    # Re-resolve heads + base (catches advance during human time).
    target_ref = await graph_repo.get_branch_ref(
        session, graph_id=merge_orm.graph_id, branch=merge_orm.target_branch,
    )
    source_ref = await graph_repo.get_branch_ref(
        session, graph_id=merge_orm.graph_id, branch=merge_orm.source_branch,
    )
    fresh_target = target_ref.commit_id
    fresh_source = source_ref.commit_id
    fresh_base = await find_merge_base(
        session, graph_id=merge_orm.graph_id,
        head_a=fresh_target, head_b=fresh_source,
    )

    base_snap = await graph_repo.load_snapshot(
        session, graph_id=merge_orm.graph_id, commit_id=fresh_base,
    )
    ours_snap = await graph_repo.load_snapshot(
        session, graph_id=merge_orm.graph_id, commit_id=fresh_target,
    )
    theirs_snap = await graph_repo.load_snapshot(
        session, graph_id=merge_orm.graph_id, commit_id=fresh_source,
    )

    outcome = three_way_merge(base_snap, ours_snap, theirs_snap)
    merged_entries = apply_resolutions(outcome, resolutions)

    # Post-resolution integrity check (resolutions can re-introduce
    # dangling edges).
    edge_hashes = {h for (_k, h) in merged_entries.values() if _k == "edge"}
    resolver = await build_edge_endpoint_resolver(
        session, graph_id=merge_orm.graph_id, edge_hashes=edge_hashes,
    )
    from backend.app.services.graph_versioning.merge import (
        check_referential_integrity,
    )
    violations = tuple(
        check_referential_integrity(
            merged_entries,
            get_edge_endpoints=resolver,
            containment_edge_types=(
                ontology.containment_edge_types if ontology else frozenset()
            ),
        )
    )
    if violations:
        raise MergeNotResolvableError(
            "post-merge integrity violations: "
            + "; ".join(f"[{v.code}] {v.detail}" for v in violations[:5])
        )

    result_commit_id, delta_summary = await _persist_merge_commit(
        session,
        graph_id=merge_orm.graph_id,
        target_branch=merge_orm.target_branch,
        source_branch=merge_orm.source_branch,
        target_commit_id=fresh_target,
        source_commit_id=fresh_source,
        base_commit_id=fresh_base,
        merged_entries=merged_entries,
        user_id=user_id,
        message=message or (
            f"Merge {merge_orm.source_branch} into {merge_orm.target_branch}"
        ),
        merge_id=merge_id,
    )
    merge_orm.status = "committed"
    merge_orm.result_commit_id = result_commit_id
    merge_orm.source_commit_id = fresh_source
    merge_orm.target_commit_id = fresh_target
    merge_orm.base_commit_id = fresh_base
    merge_orm.updated_at = _now()

    # Stamp resolved_by / resolved_at on each conflict.
    conflicts = (
        await session.execute(
            select(GraphMergeConflictORM).where(
                GraphMergeConflictORM.merge_id == merge_id
            )
        )
    ).scalars().all()
    for c in conflicts:
        chosen = resolutions.get(c.object_id)
        if chosen is None:
            c.resolution = "delete"
            c.resolved_value = None
        else:
            c.resolution = "keep"
            c.resolved_value = {"kind": chosen[0], "content_hash": chosen[1]}
        c.resolved_by = user_id
        c.resolved_at = _now()

    await graph_store_outbox_repo.emit(
        session,
        event_type="visualization.graph.merged",
        aggregate_id=merge_orm.graph_id,
        payload={
            "graph_id": merge_orm.graph_id,
            "merge_id": merge_id,
            "source_branch": merge_orm.source_branch,
            "target_branch": merge_orm.target_branch,
            "result_commit_id": result_commit_id,
            "actor": user_id,
        },
    )

    return MergePlan(
        merge_id=merge_id,
        graph_id=merge_orm.graph_id,
        source_branch=merge_orm.source_branch,
        target_branch=merge_orm.target_branch,
        base_commit_id=fresh_base,
        source_commit_id=fresh_source,
        target_commit_id=fresh_target,
        status="committed",
        has_no_conflicts=True,
        has_no_integrity_violations=True,
        is_mergeable=True,
        auto_entry_count=len(merged_entries),
        conflicts=[],
        integrity_violations=[],
        result_commit_id=result_commit_id,
        delta_summary=delta_summary,
    )


# ── private: persist a merge commit ────────────────────────────────


async def _persist_merge_commit(
    session: AsyncSession,
    *,
    graph_id: str,
    target_branch: str,
    source_branch: str,
    target_commit_id: str | None,
    source_commit_id: str | None,
    base_commit_id: str | None,
    merged_entries: EntryMap,
    user_id: str | None,
    message: str,
    merge_id: str,
) -> tuple[str, Mapping[str, int]]:
    """Build the merge commit + advance the target ref. Returns the
    new commit id + delta summary.

    V1 squash semantics (V1-1, V1-2, V1-3): when ``target_branch`` is
    the graph's default branch, this is a squash merge. The trunk
    commit gets a single parent (the previous trunk head), the source
    tip is captured via ``merge_source_commit_id`` (provenance
    pointer, not a parent), and the audit events from the squashed
    range are copied onto the new trunk commit with original actor /
    timestamp / attribute_path preserved so trunk blame remains
    O(1)-readable. Contributor manifest rows are derived from the
    same scan. Non-default-branch merges keep the two-parent shape.
    """
    graph = await graph_repo.get_graph(session, graph_id)
    is_squash = target_branch == graph.default_branch

    nodes, edges = await materialize_entries(
        session, graph_id=graph_id, entries=merged_entries,
    )

    # Use the existing planner — it computes the diff vs the target
    # snapshot, writes audit events for each changed object, and
    # builds the manifest. We bypass the ontology validation gate
    # here on purpose: every blob in *merged_entries* was previously
    # committed (and therefore previously validated). Re-running
    # strict validation on a merge would reject combinations that
    # were individually valid on each branch.
    target_snapshot = await graph_repo.load_snapshot(
        session, graph_id=graph_id, commit_id=target_commit_id,
    )
    try:
        plan = plan_commit(
            base_snapshot=target_snapshot,
            nodes=nodes,
            edges=edges,
            partition_count=graph.partition_count,
            schema_mode="schemaless",  # see comment above
            ontology=None,
        )
    except EmptyCommitError:
        # The merge produced no delta vs target (i.e. source was an
        # ancestor or strict subset of target). Persist the merge
        # row as 'committed' with NULL result_commit_id rather than
        # crashing; the API renders this as "already up to date".
        return target_commit_id or "", {
            "nodes_added": 0, "nodes_modified": 0, "nodes_removed": 0,
            "edges_added": 0, "edges_modified": 0, "edges_removed": 0,
        }

    extra_parents = (
        [] if is_squash
        else ([source_commit_id] if source_commit_id else [])
    )
    result = await persist_commit(
        session,
        graph_id=graph_id,
        branch=target_branch,
        plan=plan,
        node_states=nodes,
        edge_states=edges,
        author=user_id,
        message=message,
        expected_head_commit_id=target_commit_id,
        actor=user_id,
        view_id=None,
        pr_id=None,
        extra_parent_ids=extra_parents,
        merge_base_id=base_commit_id,
        is_default_branch=is_squash,
        merge_source_commit_id=source_commit_id if is_squash else None,
        merge_source_branch=source_branch if is_squash else None,
    )

    if is_squash and source_commit_id is not None:
        await _copy_squashed_audit_and_contributors(
            session,
            graph_id=graph_id,
            source_commit_id=source_commit_id,
            base_commit_id=base_commit_id,
            new_commit_id=result.commit_id,
            target_branch=target_branch,
        )

    return result.commit_id, plan.delta_summary


async def _copy_squashed_audit_and_contributors(
    session: AsyncSession,
    *,
    graph_id: str,
    source_commit_id: str,
    base_commit_id: str | None,
    new_commit_id: str,
    target_branch: str,
) -> None:
    """V1-3: Wave 6 audit-row copy + contributor manifest.

    Walks the chain from ``source_commit_id`` back to (but not
    including) ``base_commit_id``, collecting commit ids. Re-inserts
    every ``graph_change_event`` row from those commits stamped with
    ``commit_id = new_commit_id`` and ``branch = target_branch`` —
    preserving original ``actor`` / ``created_at`` / ``attribute_path``
    / ``old_value`` / ``new_value`` / content hashes. Same scan
    aggregates ops_count + first/last timestamps per actor into
    ``graph_commit_contributors``.

    Idempotent at the row level: each new audit row gets a fresh id;
    contributor rows use ``ON CONFLICT (commit_id, user_id) DO
    UPDATE`` so repeated calls on the same input converge.
    """
    chain: list[str] = []
    cur: str | None = source_commit_id
    seen: set[str] = set()
    while cur and cur != base_commit_id and cur not in seen:
        seen.add(cur)
        chain.append(cur)
        row = (
            await session.execute(
                select(GraphCommitORM.parent_ids).where(
                    GraphCommitORM.id == cur
                )
            )
        ).scalar_one_or_none()
        if row is None:
            break
        # Linear walk: take the first parent (single-parent on drafts
        # by construction; for any historical two-parent commit the
        # primary parent is the right next step on the source line).
        cur = row[0] if row else None
    if not chain:
        return

    events = (
        await session.execute(
            select(GraphChangeEventORM).where(
                GraphChangeEventORM.graph_id == graph_id,
                GraphChangeEventORM.commit_id.in_(chain),
            )
        )
    ).scalars().all()
    if not events:
        return

    contributors: dict[str, dict[str, Any]] = {}
    for ev in events:
        session.add(
            GraphChangeEventORM(
                id=f"gce_{uuid.uuid4().hex[:12]}",
                graph_id=ev.graph_id,
                branch=target_branch,
                commit_id=new_commit_id,
                object_kind=ev.object_kind,
                object_id=ev.object_id,
                action=ev.action,
                attribute_path=ev.attribute_path,
                old_value=ev.old_value,
                new_value=ev.new_value,
                prev_content_hash=ev.prev_content_hash,
                new_content_hash=ev.new_content_hash,
                actor=ev.actor,
                pr_id=ev.pr_id,
                view_id=ev.view_id,
                created_at=ev.created_at,
            )
        )
        actor = ev.actor or "unknown"
        c = contributors.setdefault(
            actor,
            {"ops_count": 0, "first_at": ev.created_at, "last_at": ev.created_at},
        )
        c["ops_count"] += 1
        if ev.created_at < c["first_at"]:
            c["first_at"] = ev.created_at
        if ev.created_at > c["last_at"]:
            c["last_at"] = ev.created_at

    from sqlalchemy.dialects.postgresql import insert as pg_insert

    for actor, agg in contributors.items():
        await session.execute(
            pg_insert(GraphCommitContributorORM)
            .values(
                commit_id=new_commit_id,
                user_id=actor,
                graph_id=graph_id,
                ops_count=agg["ops_count"],
                first_op_at=agg["first_at"],
                last_op_at=agg["last_at"],
            )
            .on_conflict_do_update(
                index_elements=["commit_id", "user_id"],
                set_={
                    "ops_count": agg["ops_count"],
                    "first_op_at": agg["first_at"],
                    "last_op_at": agg["last_at"],
                },
            )
        )


# ── helpers ────────────────────────────────────────────────────────


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


__all__ = [
    "MergePlan",
    "MergeNotFoundError",
    "MergeNotResolvableError",
    "find_merge_base",
    "materialize_entries",
    "build_edge_endpoint_resolver",
    "plan_merge",
    "commit_resolved_merge",
]

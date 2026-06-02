"""Graph versioning write path — Postgres-first, the durable source of truth.

Implements the core flow (plan §3, §8, §11):

  create_graph → open_draft → stage_changes → checkpoint → publish (squash to main)

plus the read/audit helpers ``materialize_state``, ``entity_history`` and
``diff_commits``.  Everything writes the ``graphver`` store first; FalkorDB
projection (plan §5) is a separate worker that consumes committed state — it is
NOT on this path, so writes are durable regardless of projection lag.

Design choices honoured here:

* Append-only version tables; "latest" tracked via the :class:`EntityHeadORM`
  pointer (no ``is_head`` churn — plan §16.5 #4).
* A checkpoint folds the durable ``working_changes`` buffer into version rows,
  squash-deduping no-op edits via :mod:`changeset`.
* A draft has its own linear ``commit_seq``; publishing squashes the whole draft
  into one ``main`` commit carrying contributor attribution (plan §8).
* Concurrent advance of ``main`` is detected (OCC) and surfaced rather than
  silently mis-merged; field-level rebase reuses :mod:`merge` (wired next).
"""
from __future__ import annotations

from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert as pg_insert

from . import config, db
from .changeset import Delta, materialize, net_delta, diff_states
from .ids import prefixed_id
from .merge import three_way_merge
from .merkle import MerkleTree, content_hash
from .merkle_store import MerkleStore
from .models import (
    BranchORM,
    CommitORM,
    EdgeVersionORM,
    EntityHeadORM,
    GraphORM,
    MergeRequestORM,
    NodeVersionORM,
    ProjectionStateORM,
    WorkingChangeORM,
    _now,
)

# Keys read out of a payload into denormalised, queryable version columns.
_NODE_DENORM = {
    "urn": "urn",
    "entityType": "entity_type",
    "displayName": "display_name",
    "qualifiedName": "qualified_name",
}


class ConcurrencyError(RuntimeError):
    """Raised when a publish would violate referential integrity (e.g. a
    surviving edge points at a node the merge tombstoned). A stale base is *not*
    an error — it is auto-rebased; only genuine conflicts block a publish."""


class MergeConflict(RuntimeError):
    """Raised when a 3-way rebase/merge has unresolved field-level conflicts.

    ``.conflicts`` is a JSON-able list of ``{entity_id, path, base, ours, theirs,
    kind}`` for the UI to resolve; resubmit ``publish(..., resolutions=...)`` with
    the chosen payloads to land the merge.
    """

    def __init__(self, conflicts):
        super().__init__(f"{len(conflicts)} unresolved merge conflict(s)")
        self.conflicts = conflicts


class GraphVersioningService:
    """Service over the ``graphver`` store.  Each public method is one
    transaction (via :func:`db.graphver_session`) unless a session is passed."""

    def __init__(self, session_factory=db.graphver_session):
        self._session = session_factory
        self._merkle = MerkleStore()

    # ------------------------------------------------------------------ #
    # Graph + branch lifecycle                                            #
    # ------------------------------------------------------------------ #
    async def create_graph(
        self,
        *,
        data_source_id: str,
        workspace_id: str,
        kind: str = "manual",
        actor: Optional[str] = None,
        base_ontology_id: Optional[str] = None,
        tenant_id: Optional[str] = None,
        falkor_graph_name: Optional[str] = None,
    ) -> Dict[str, str]:
        """Create a blank versioned graph: graph row + ``main`` branch + empty
        genesis commit + projection state.  Returns ids and the genesis seq."""
        async with self._session() as s:
            graph = GraphORM(
                data_source_id=data_source_id,
                workspace_id=workspace_id,
                tenant_id=tenant_id,
                kind=kind,
                base_ontology_id=base_ontology_id,
                created_by=actor,
                main_head_commit_seq=1,
            )
            s.add(graph)
            await s.flush()

            main = BranchORM(
                graph_id=graph.id, kind="main", name="main", created_by=actor
            )
            s.add(main)
            await s.flush()

            genesis = CommitORM(
                graph_id=graph.id,
                branch_id=main.id,
                commit_seq=1,
                kind="genesis",
                message="genesis",
                actor=actor,
                merkle_root=MerkleTree.build({}).root,
                stats={"nodes": 0, "edges": 0},
            )
            s.add(genesis)
            await s.flush()                      # materialise genesis.id before linking
            main.head_commit_id = genesis.id
            s.add(
                ProjectionStateORM(
                    graph_id=graph.id, projected_commit_seq=0, target_commit_seq=1,
                    falkor_graph_name=falkor_graph_name,   # the data source's real graph
                )
            )
            return {"graph_id": graph.id, "main_branch_id": main.id, "genesis_commit_id": genesis.id}

    async def open_draft(
        self,
        *,
        graph_id: str,
        owner: str,
        name: Optional[str] = None,
        originating_view_id: Optional[str] = None,
    ) -> str:
        """Open a per-user draft based on the graph's current ``main`` head."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            draft = BranchORM(
                graph_id=graph_id,
                kind="draft",
                name=name,
                owner=owner,
                base_commit_seq=graph.main_head_commit_seq,
                base_ontology_version_id=graph.base_ontology_version_id,
                originating_view_id=originating_view_id,
                created_by=owner,
            )
            s.add(draft)
            await s.flush()
            return draft.id

    # ------------------------------------------------------------------ #
    # Staging + checkpoint                                                #
    # ------------------------------------------------------------------ #
    async def stage_changes(
        self,
        *,
        graph_id: str,
        branch_id: str,
        ops: Sequence[Mapping],
        actor: str,
    ) -> Dict[str, str]:
        """Bulk-append working changes to a draft (plan decision #10).

        Each op: ``{ref?, op, entity_kind, entity_id?, payload, change_reason?}``.
        For ``create`` without an ``entity_id`` a stable ULID is minted.  Returns
        ``{ref_or_entity_id: entity_id}`` so the client can reconcile.
        """
        assigned: Dict[str, str] = {}
        async with self._session() as s:
            start = (
                await s.execute(
                    select(func.coalesce(func.max(WorkingChangeORM.seq), 0)).where(
                        WorkingChangeORM.graph_id == graph_id,
                        WorkingChangeORM.branch_id == branch_id,
                    )
                )
            ).scalar_one()
            seq = int(start)
            for op in ops:
                seq += 1
                entity_id = op.get("entity_id") or prefixed_id("ent")
                ref = op.get("ref", entity_id)
                assigned[ref] = entity_id
                payload = op.get("payload")
                base_hash = None
                if op["op"] != "create":
                    base_hash = await self._effective_head_hash(
                        s, graph_id, branch_id, entity_id
                    )
                s.add(
                    WorkingChangeORM(
                        graph_id=graph_id,
                        branch_id=branch_id,
                        seq=seq,
                        op=op["op"],
                        entity_kind=op["entity_kind"],
                        entity_id=entity_id,
                        payload=payload,
                        base_content_hash=base_hash,
                        actor=actor,
                        change_reason=op.get("change_reason"),
                    )
                )
            return assigned

    async def checkpoint(
        self,
        *,
        graph_id: str,
        branch_id: str,
        actor: str,
        message: Optional[str] = None,
    ) -> Optional[str]:
        """Fold uncommitted working changes into version rows under a new draft
        commit.  Returns the commit id, or ``None`` if nothing was staged."""
        async with self._session() as s:
            branch = await s.get(BranchORM, branch_id)
            if branch is None or branch.graph_id != graph_id:
                raise ValueError("unknown branch")

            changes = (
                await s.execute(
                    select(WorkingChangeORM)
                    .where(
                        WorkingChangeORM.graph_id == graph_id,
                        WorkingChangeORM.branch_id == branch_id,
                        WorkingChangeORM.committed_into_commit_id.is_(None),
                    )
                    .order_by(WorkingChangeORM.seq)
                )
            ).scalars().all()
            if not changes:
                return None

            kind_by_entity = {c.entity_id: c.entity_kind for c in changes}
            touched = list(kind_by_entity)

            # Base = the draft's current effective state for each touched entity,
            # fork-aware (draft over this graph's main over any fork parent), so a
            # checkpoint on a fork classifies edits to inherited entities as
            # updates (not creates) and keeps hash continuity intact.
            composed = await self._composed_state(s, graph_id, branch_id)
            base_state = {eid: composed.get(eid) for eid in touched}
            ops = [
                {"entity_id": c.entity_id, "op": c.op, "payload": c.payload}
                for c in changes
            ]
            head_state = materialize(base_state, ops)
            deltas = net_delta(base_state, head_state)

            commit_seq = await self._next_seq(s, graph_id, branch_id)
            commit = CommitORM(
                graph_id=graph_id,
                branch_id=branch_id,
                commit_seq=commit_seq,
                parent_commit_id=branch.head_commit_id,
                kind="checkpoint" if branch.head_commit_id else "edit",
                message=message or f"checkpoint by {actor}",
                actor=actor,
            )
            s.add(commit)
            await s.flush()

            await self._write_deltas(
                s, graph_id, branch_id, commit, deltas, kind_by_entity, actor
            )

            # Merkle root over the branch's full effective live state.
            commit.merkle_root = await self._merkle_root(s, graph_id, branch_id)
            commit.stats = _delta_stats(deltas)

            for c in changes:
                c.committed_into_commit_id = commit.id
            branch.head_commit_id = commit.id
            branch.updated_at = _now()
            return commit.id

    # ------------------------------------------------------------------ #
    # Publish (squash draft → main)                                       #
    # ------------------------------------------------------------------ #
    async def publish(
        self,
        *,
        graph_id: str,
        branch_id: str,
        actor: str,
        message: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
    ) -> str:
        """Squash a draft into a single ``main`` commit, rebasing onto current
        main with a field-level 3-way merge (plan §8).

        If ``main`` advanced under the draft, non-overlapping field edits
        auto-merge; genuine same-field conflicts raise :class:`MergeConflict`
        (resubmit with ``resolutions={entity_id: payload|None}``).  The same path
        covers the no-advance case (then base == theirs, so the merge reduces to
        the draft's own delta).
        """
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            draft = await s.get(BranchORM, branch_id)
            if graph is None or draft is None or draft.graph_id != graph_id:
                raise ValueError("unknown graph/branch")
            main_id = await self._main_branch_id(s, graph_id)

            merged_state, conflicts, theirs = await self._compute_merge(
                s, graph_id, graph, draft, main_id, dict(resolutions or {})
            )
            if conflicts:
                raise MergeConflict(conflicts)

            # No surviving edge may point at a tombstone (cross-entity conflict
            # the per-entity merge can't see — §16.5 #8).
            self._assert_referential_integrity(merged_state)

            deltas = net_delta(theirs, merged_state)   # what publish adds to main
            new_seq = graph.main_head_commit_seq + 1
            if not deltas:
                draft.status = "merged"
                draft.base_commit_seq = graph.main_head_commit_seq
                return draft.head_commit_id or ""

            contributors = await self._branch_contributors(s, graph_id, branch_id)
            source_commits = await self._branch_commit_ids(s, graph_id, branch_id)
            main = await s.get(BranchORM, main_id)
            squash = CommitORM(
                graph_id=graph_id,
                branch_id=main_id,
                commit_seq=new_seq,
                parent_commit_id=main.head_commit_id,
                kind="squash_publish",
                message=message,
                actor=actor,
                contributors=contributors,
                source_branch_id=branch_id,
                source_commit_ids=source_commits,
                source_commit_count=len(source_commits),
                originating_view_id=draft.originating_view_id,
            )
            s.add(squash)
            await s.flush()

            kind_by_entity = await self._kind_map_multi(
                s, [(graph_id, branch_id), (graph_id, main_id)]
            )
            await self._write_deltas(s, graph_id, main_id, squash, deltas, kind_by_entity, actor)

            main.head_commit_id = squash.id
            graph.main_head_commit_seq = new_seq       # advance head before merkle
            squash.merkle_root = await self._commit_merkle(s, graph_id, main_id, squash, deltas)
            graph.updated_at = _now()
            squash.stats = _delta_stats(deltas)
            draft.status = "merged"
            draft.base_commit_seq = new_seq            # rebased onto new main

            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return squash.id

    async def preview_merge(self, *, graph_id: str, branch_id: str) -> Dict[str, object]:
        """Dry-run the publish merge: report conflicts + change counts without
        committing, so the UI can resolve before publishing."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            draft = await s.get(BranchORM, branch_id)
            if graph is None or draft is None:
                raise ValueError("unknown graph/branch")
            main_id = await self._main_branch_id(s, graph_id)
            merged_state, conflicts, theirs = await self._compute_merge(
                s, graph_id, graph, draft, main_id, {}
            )
            return {
                "clean": not conflicts,
                "conflicts": conflicts,
                "changes": _delta_stats(net_delta(theirs, merged_state)),
            }

    # ------------------------------------------------------------------ #
    # Forking + pull requests (copy-on-write — plan §8, §12.5)            #
    # ------------------------------------------------------------------ #
    async def fork_graph(
        self,
        *,
        parent_graph_id: str,
        workspace_id: str,
        actor: str,
        data_source_id: Optional[str] = None,
        tenant_id: Optional[str] = None,
    ) -> Dict[str, object]:
        """Copy-on-write fork: a new graph whose ``main`` inherits the parent's
        state at its current head **without copying any rows**.  Divergence accrues
        only as the fork's own commits; reads compose parent@fork_base + own (plan
        §8 cross-team flow)."""
        async with self._session() as s:
            parent = await s.get(GraphORM, parent_graph_id)
            if parent is None:
                raise ValueError(f"unknown parent graph {parent_graph_id}")
            base_seq = parent.main_head_commit_seq
            parent_main = await self._main_branch_id(s, parent_graph_id)
            fork = GraphORM(
                data_source_id=data_source_id or prefixed_id("dsfork"),
                workspace_id=workspace_id,
                tenant_id=tenant_id,
                kind=parent.kind,
                base_ontology_id=parent.base_ontology_id,
                base_ontology_version_id=parent.base_ontology_version_id,
                fork_parent_graph_id=parent_graph_id,
                fork_base_commit_seq=base_seq,
                main_head_commit_seq=base_seq,
                created_by=actor,
            )
            s.add(fork)
            await s.flush()
            main = BranchORM(graph_id=fork.id, kind="main", name="main", created_by=actor)
            s.add(main)
            await s.flush()
            # Fork-point commit carries the parent's state hash; no version rows.
            fork_point = CommitORM(
                graph_id=fork.id, branch_id=main.id, commit_seq=base_seq,
                kind="genesis", message=f"fork of {parent_graph_id}@{base_seq}",
                actor=actor, source_branch_id=parent_main,
                merkle_root=await self._merkle_root(s, parent_graph_id, parent_main),
                stats={},
            )
            s.add(fork_point)
            await s.flush()                      # materialise fork_point.id before linking
            main.head_commit_id = fork_point.id
            parent_ps = await s.get(ProjectionStateORM, parent_graph_id)
            parent_name = (parent_ps.falkor_graph_name if parent_ps else None) or f"gv_{parent_graph_id}"
            s.add(ProjectionStateORM(
                graph_id=fork.id, projected_commit_seq=0, target_commit_seq=base_seq,
                falkor_graph_name=f"{parent_name}__fork_{fork.id}",   # forks get their own graph
            ))
            return {
                "graph_id": fork.id,
                "main_branch_id": main.id,
                "fork_base_commit_seq": base_seq,
            }

    async def open_pr(
        self, *, source_graph_id: str, actor: str, title: Optional[str] = None,
    ) -> str:
        """Open a PR from a fork's ``main`` back to its parent's ``main``,
        recording the current mergeability/conflict set (plan §12.5)."""
        async with self._session() as s:
            fork = await s.get(GraphORM, source_graph_id)
            if fork is None or not fork.fork_parent_graph_id:
                raise ValueError("source graph is not a fork")
            fork_main = await self._main_branch_id(s, source_graph_id)
            merged, conflicts, _theirs = await self._compute_fork_merge(s, fork, {})
            pr = MergeRequestORM(
                graph_id=source_graph_id,
                source_branch_id=fork_main,
                target_graph_id=fork.fork_parent_graph_id,
                target_branch="main",
                base_commit_seq=fork.fork_base_commit_seq,
                status="conflicts" if conflicts else "mergeable",
                conflicts=conflicts or None,
                actor=actor,
            )
            s.add(pr)
            await s.flush()
            return pr.id

    async def preview_pr(self, *, pr_id: str) -> Dict[str, object]:
        """Dry-run a fork PR's merge into the parent (conflicts + change counts)."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            fork = await s.get(GraphORM, pr.graph_id)
            merged, conflicts, theirs = await self._compute_fork_merge(s, fork, {})
            return {
                "clean": not conflicts,
                "conflicts": conflicts,
                "changes": _delta_stats(net_delta(theirs, merged)),
            }

    async def merge_pr(
        self,
        *,
        pr_id: str,
        actor: str,
        message: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
    ) -> str:
        """Squash-merge a fork PR into the parent's ``main`` — the same 3-way
        semantics as draft publish, across graphs (plan §8, §12.5).

        Non-overlapping edits auto-merge; genuine conflicts raise
        :class:`MergeConflict` (resubmit with ``resolutions``).  Already-merged
        divergence nets to zero on any later PR, so the fork keeps its base and
        can keep diverging."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            fork = await s.get(GraphORM, pr.graph_id)
            parent = await s.get(GraphORM, pr.target_graph_id)
            if fork is None or parent is None:
                raise ValueError("pr endpoints missing")
            parent_main = await self._main_branch_id(s, parent.id)
            fork_main = await self._main_branch_id(s, fork.id)

            merged, conflicts, theirs = await self._compute_fork_merge(
                s, fork, dict(resolutions or {})
            )
            if conflicts:
                pr.status = "conflicts"
                pr.conflicts = conflicts
                raise MergeConflict(conflicts)
            self._assert_referential_integrity(merged)

            deltas = net_delta(theirs, merged)
            if not deltas:
                pr.status = "merged"
                return ""

            new_seq = parent.main_head_commit_seq + 1
            contributors = await self._branch_contributors(s, fork.id, fork_main)
            source_commits = await self._branch_commit_ids(s, fork.id, fork_main)
            main = await s.get(BranchORM, parent_main)
            squash = CommitORM(
                graph_id=parent.id, branch_id=parent_main, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="squash_publish",
                message=message, actor=actor, contributors=contributors,
                source_branch_id=fork_main, source_commit_ids=source_commits,
                source_commit_count=len(source_commits),
            )
            s.add(squash)
            await s.flush()

            kind_by_entity = await self._kind_map_multi(
                s, [(fork.id, fork_main), (parent.id, parent_main)]
            )
            await self._write_deltas(s, parent.id, parent_main, squash, deltas, kind_by_entity, actor)

            main.head_commit_id = squash.id
            parent.main_head_commit_seq = new_seq      # advance head before merkle
            parent.updated_at = _now()
            squash.merkle_root = await self._commit_merkle(s, parent.id, parent_main, squash, deltas)
            squash.stats = _delta_stats(deltas)

            pr.status = "merged"
            pr.resulting_commit_id = squash.id
            pr.updated_at = _now()
            ps = await s.get(ProjectionStateORM, parent.id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return squash.id

    async def _compute_fork_merge(self, s, fork, resolutions):
        """3-way merge a fork's divergence into its parent's current main.

        base   = parent main at the fork point (common ancestor)
        ours   = the fork's current main (parent@fork_base + fork divergence)
        theirs = the parent's current main
        Returns ``(merged_state, conflicts, theirs_state)``.
        """
        parent = await s.get(GraphORM, fork.fork_parent_graph_id)
        if parent is None:
            raise ValueError("fork parent missing")
        parent_main = await self._main_branch_id(s, parent.id)
        fork_main = await self._main_branch_id(s, fork.id)
        base = await self._state_as_of(s, parent.id, parent_main, fork.fork_base_commit_seq or 0)
        ours = await self._composed_state(s, fork.id, fork_main)
        theirs = await self._composed_state(s, parent.id, parent_main)

        set_fields = frozenset(config.SET_FIELDS)
        merged: Dict[str, Optional[dict]] = {}
        conflicts: List[dict] = []
        for eid in sorted(set(base) | set(ours) | set(theirs)):
            if eid in resolutions:
                merged[eid] = resolutions[eid]
                continue
            out = three_way_merge(base.get(eid), ours.get(eid), theirs.get(eid), set_fields)
            merged[eid] = out.merged
            for c in out.conflicts:
                conflicts.append({
                    "entity_id": eid, "path": list(c.path),
                    "base": c.base, "ours": c.ours, "theirs": c.theirs, "kind": c.kind,
                })
        return merged, conflicts, theirs

    # ------------------------------------------------------------------ #
    # Reads / audit                                                       #
    # ------------------------------------------------------------------ #
    async def main_branch_id(self, graph_id: str) -> str:
        """Public accessor for a graph's ``main`` branch id."""
        async with self._session() as s:
            return await self._main_branch_id(s, graph_id)

    async def materialize_state(
        self, *, graph_id: str, branch_id: str
    ) -> Dict[str, Dict[str, dict]]:
        """Current live node/edge payloads for a branch (fork-aware composition).

        Read straight from the version store (the source of truth); the FalkorDB
        projection is the hot read path and sits behind the same API.
        """
        async with self._session() as s:
            state = await self._composed_state(s, graph_id, branch_id)
            nodes, edges = {}, {}
            for eid, p in state.items():
                if p is None:
                    continue
                (edges if _is_edge_payload(p) else nodes)[eid] = p
            return {"nodes": nodes, "edges": edges}

    async def projection_watermark(self, graph_id: str) -> Dict[str, object]:
        """Read freshness for a graph's FalkorDB projection — attached to reads so
        a client knows whether it's seeing the latest committed `main`."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            ps = await s.get(ProjectionStateORM, graph_id)
            committed = graph.main_head_commit_seq if graph else 0
            projected = ps.projected_commit_seq if ps else 0
            return {
                "committed": committed,
                "projected": projected,
                "target": ps.target_commit_seq if ps else 0,
                "status": ps.status if ps else "idle",
                "falkor_graph_name": ps.falkor_graph_name if ps else None,
                "fresh": projected >= committed,
            }

    async def neighbors_from_state(
        self, *, graph_id: str, urn: str, depth: int = 1,
        direction: str = "both", edge_types: Optional[Sequence[str]] = None,
        limit: int = 500,
    ) -> Dict[str, List[dict]]:
        """Bounded neighborhood of a node on `main`, served from Postgres — the
        fallback for the FalkorDB traversal when the projection lags/evicts.

        Reader-compatible shapes (GraphNode/GraphEdge by alias). NOTE: this
        composes full `main` state to build adjacency (O(graph) setup); the FalkorDB
        path is the hot path. A bounded as-of SQL BFS is the later optimisation.
        """
        et = set(edge_types) if edge_types else None
        async with self._session() as s:
            main_id = await self._main_branch_id(s, graph_id)
            state = await self._composed_state(s, graph_id, main_id)
        nodes = {eid: p for eid, p in state.items() if p is not None and not _is_edge_payload(p)}
        edges = {eid: p for eid, p in state.items() if p is not None and _is_edge_payload(p)}
        urn_of = {eid: (p.get("urn") or f"gv:{eid}") for eid, p in nodes.items()}
        eid_of = {u: eid for eid, u in urn_of.items()}

        start = eid_of.get(urn) or (urn[3:] if urn.startswith("gv:") and urn[3:] in nodes else None)
        if start is None:
            return {"nodes": [], "edges": []}

        seen_nodes = {start}
        seen_edges: set = set()
        frontier = {start}
        for _ in range(max(1, depth)):
            nxt: set = set()
            for eid, p in edges.items():
                if eid in seen_edges:
                    continue
                if et is not None and (p.get("edgeType") not in et):
                    continue
                src, tgt = _edge_src_tgt(p)
                hit = None
                if direction in ("out", "both") and src in frontier:
                    hit = tgt
                elif direction in ("in", "both") and tgt in frontier:
                    hit = src
                if hit is None or hit not in nodes:
                    continue
                seen_edges.add(eid)
                if hit not in seen_nodes:
                    if len(seen_nodes) >= limit:
                        continue
                    seen_nodes.add(hit)
                    nxt.add(hit)
            if not nxt:
                break
            frontier = nxt

        out_nodes = [_graphnode_dict(eid, urn_of[eid], nodes[eid]) for eid in seen_nodes]
        out_edges = [
            _graphedge_dict(eid, edges[eid], urn_of) for eid in seen_edges
            if _edge_src_tgt(edges[eid])[0] in seen_nodes and _edge_src_tgt(edges[eid])[1] in seen_nodes
        ]
        return {"nodes": out_nodes, "edges": out_edges}

    async def entity_history(self, *, graph_id: str, entity_id: str) -> List[dict]:
        """Full revision timeline of one entity (plan §7 tier 1)."""
        async with self._session() as s:
            rows = (
                await s.execute(
                    select(NodeVersionORM)
                    .where(
                        NodeVersionORM.graph_id == graph_id,
                        NodeVersionORM.entity_id == entity_id,
                    )
                    .order_by(NodeVersionORM.commit_seq, NodeVersionORM.created_at)
                )
            ).scalars().all()
            if not rows:
                rows = (
                    await s.execute(
                        select(EdgeVersionORM)
                        .where(
                            EdgeVersionORM.graph_id == graph_id,
                            EdgeVersionORM.entity_id == entity_id,
                        )
                        .order_by(EdgeVersionORM.commit_seq, EdgeVersionORM.created_at)
                    )
                ).scalars().all()
            return [
                {
                    "commit_id": r.commit_id,
                    "commit_seq": r.commit_seq,
                    "branch_id": r.branch_id,
                    "op": r.op,
                    "content_hash": r.content_hash,
                    "prev_content_hash": r.prev_content_hash,
                    "actor": r.actor,
                    "change_reason": r.change_reason,
                    "payload": r.payload,
                    "created_at": r.created_at,
                }
                for r in rows
            ]

    async def diff_commits(
        self, *, graph_id: str, branch_id: str, from_seq: int, to_seq: int
    ) -> Dict[str, object]:
        """Field-level diff between two commits of a branch (plan §7), **O(changed)**:
        scans only the version rows in ``(from_seq, to_seq]`` (a commit writes rows
        only for changed entities), then resolves each changed entity's value at
        each endpoint. Never reconstructs full graph state."""
        async with self._session() as s:
            changed = await self._changed_in_window(s, graph_id, branch_id, from_seq, to_seq)
            if not changed:
                return {"added": [], "removed": [], "modified": {}}
            a = await self._values_at(s, graph_id, branch_id, changed, from_seq)
            b = await self._values_at(s, graph_id, branch_id, changed, to_seq)
            graph = await s.get(GraphORM, graph_id)
            if graph is not None and graph.fork_parent_graph_id:
                for eid in changed:                  # fork CoW: inherited 'before' value
                    if eid not in a:
                        v = await self._entity_value_at(s, graph_id, branch_id, eid, from_seq)
                        if v is not None:
                            a[eid] = v
            return diff_states(a, b)

    async def get_graph(self, graph_id: str) -> Optional[Dict[str, object]]:
        """Graph metadata (or ``None``) — also the API's tenant-isolation guard."""
        async with self._session() as s:
            g = await s.get(GraphORM, graph_id)
            return None if g is None else self._graph_meta(g)

    async def list_branches(
        self, *, graph_id: str, limit: int = 100, offset: int = 0
    ) -> List[dict]:
        """Branches of a graph (``main`` + drafts/forks), oldest first."""
        async with self._session() as s:
            rows = (await s.execute(
                select(BranchORM).where(BranchORM.graph_id == graph_id)
                .order_by(BranchORM.created_at).limit(limit).offset(offset)
            )).scalars().all()
            return [self._branch_meta(b) for b in rows]

    async def get_pr(self, pr_id: str) -> Optional[dict]:
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            return None if pr is None else self._pr_meta(pr)

    async def list_pulls(
        self, *, target_graph_id: str, limit: int = 100, offset: int = 0
    ) -> List[dict]:
        """PRs targeting a graph's ``main`` (the base owner's review queue), newest first."""
        async with self._session() as s:
            rows = (await s.execute(
                select(MergeRequestORM)
                .where(MergeRequestORM.target_graph_id == target_graph_id)
                .order_by(MergeRequestORM.created_at.desc()).limit(limit).offset(offset)
            )).scalars().all()
            return [self._pr_meta(pr) for pr in rows]

    @staticmethod
    def _graph_meta(g: GraphORM) -> Dict[str, object]:
        return {
            "graph_id": g.id, "workspace_id": g.workspace_id, "tenant_id": g.tenant_id,
            "kind": g.kind, "base_ontology_id": g.base_ontology_id,
            "fork_parent_graph_id": g.fork_parent_graph_id,
            "fork_base_commit_seq": g.fork_base_commit_seq,
            "main_head_commit_seq": g.main_head_commit_seq,
            "created_by": g.created_by, "created_at": g.created_at,
        }

    @staticmethod
    def _branch_meta(b: BranchORM) -> dict:
        return {
            "branch_id": b.id, "kind": b.kind, "name": b.name, "owner": b.owner,
            "status": b.status, "base_commit_seq": b.base_commit_seq,
            "head_commit_id": b.head_commit_id, "originating_view_id": b.originating_view_id,
            "created_by": b.created_by, "created_at": b.created_at, "updated_at": b.updated_at,
        }

    @staticmethod
    def _pr_meta(pr: MergeRequestORM) -> dict:
        return {
            "pr_id": pr.id, "graph_id": pr.graph_id, "source_branch_id": pr.source_branch_id,
            "target_graph_id": pr.target_graph_id, "target_branch": pr.target_branch,
            "base_commit_seq": pr.base_commit_seq, "status": pr.status,
            "conflicts": pr.conflicts, "resulting_commit_id": pr.resulting_commit_id,
            "actor": pr.actor, "created_at": pr.created_at, "updated_at": pr.updated_at,
        }

    # ------------------------------------------------------------------ #
    # Internal helpers                                                    #
    # ------------------------------------------------------------------ #
    async def _main_branch_id(self, s, graph_id: str) -> str:
        return (
            await s.execute(
                select(BranchORM.id).where(
                    BranchORM.graph_id == graph_id, BranchORM.kind == "main"
                )
            )
        ).scalar_one()

    async def _next_seq(self, s, graph_id: str, branch_id: str) -> int:
        cur = (
            await s.execute(
                select(func.coalesce(func.max(CommitORM.commit_seq), 0)).where(
                    CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id
                )
            )
        ).scalar_one()
        return int(cur) + 1

    async def _heads(self, s, graph_id: str, branch_id: str) -> Dict[str, EntityHeadORM]:
        rows = (
            await s.execute(
                select(EntityHeadORM).where(
                    EntityHeadORM.graph_id == graph_id,
                    EntityHeadORM.branch_id == branch_id,
                )
            )
        ).scalars().all()
        return {r.entity_id: r for r in rows}

    async def _effective_head_hash(
        self, s, graph_id: str, branch_id: str, entity_id: str
    ) -> Optional[str]:
        main_id = await self._main_branch_id(s, graph_id)
        for bid in (branch_id, main_id):
            row = await s.get(EntityHeadORM, (graph_id, bid, entity_id))
            if row is not None:
                return None if row.is_tombstone else row.content_hash
        return None

    async def _composed_state(self, s, graph_id: str, branch_id: str) -> Dict[str, Optional[dict]]:
        """Live payload state of a branch, fork-aware — the one primitive every
        read/merge path composes from (so 'current state' has a single definition).

        * ``main`` → the graph's reconstructed state at its head (a fork's main is
          seeded copy-on-write from its parent at the fork point).
        * a draft → the graph's ``main`` at the draft's branch point overlaid with
          the draft's own staged changes (the 'ours' side of a rebase).
        """
        main_id = await self._main_branch_id(s, graph_id)
        if branch_id == main_id:
            graph = await s.get(GraphORM, graph_id)
            return await self._state_as_of(s, graph_id, main_id, graph.main_head_commit_seq)
        branch = await s.get(BranchORM, branch_id)
        base = await self._state_as_of(s, graph_id, main_id, branch.base_commit_seq or 0)
        base.update(await self._branch_own_payloads(s, graph_id, branch_id))
        return base

    async def _branch_own_payloads(
        self, s, graph_id: str, branch_id: str
    ) -> Dict[str, Optional[dict]]:
        """Payloads for entities THIS branch itself changed (its own heads only);
        tombstone → None.  Used as the 'ours' side of a rebase merge."""
        heads = await self._heads(s, graph_id, branch_id)
        out: Dict[str, Optional[dict]] = {}
        node_ids, edge_ids, kindvid = [], [], {}
        for eid, h in heads.items():
            if h.is_tombstone:
                out[eid] = None
            else:
                kindvid[eid] = h.head_version_id
                (node_ids if h.entity_kind == "node" else edge_ids).append(h.head_version_id)
        payload_by_vid: Dict[str, dict] = {}
        if node_ids:
            for r in (await s.execute(select(NodeVersionORM).where(
                NodeVersionORM.graph_id == graph_id, NodeVersionORM.id.in_(node_ids)
            ))).scalars():
                payload_by_vid[r.id] = r.payload
        if edge_ids:
            for r in (await s.execute(select(EdgeVersionORM).where(
                EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.id.in_(edge_ids)
            ))).scalars():
                payload_by_vid[r.id] = r.payload
        for eid, vid in kindvid.items():
            out[eid] = payload_by_vid.get(vid)
        return out

    async def _compute_merge(self, s, graph_id, graph, draft, main_id, resolutions):
        """3-way merge a draft onto current main.

        base   = main state at the draft's branch point (common ancestor)
        ours   = base + the draft's own changes
        theirs = current main state
        Returns ``(merged_state, conflicts, theirs_state)``.
        """
        base = await self._state_as_of(s, graph_id, main_id, draft.base_commit_seq or 0)
        theirs = await self._state_as_of(s, graph_id, main_id, graph.main_head_commit_seq)
        ours = dict(base)
        ours.update(await self._branch_own_payloads(s, graph_id, draft.id))

        set_fields = frozenset(config.SET_FIELDS)
        merged: Dict[str, Optional[dict]] = {}
        conflicts: List[dict] = []
        for eid in sorted(set(base) | set(theirs) | set(ours)):
            if eid in resolutions:
                merged[eid] = resolutions[eid]
                continue
            out = three_way_merge(base.get(eid), ours.get(eid), theirs.get(eid), set_fields)
            merged[eid] = out.merged
            for c in out.conflicts:
                conflicts.append({
                    "entity_id": eid, "path": list(c.path),
                    "base": c.base, "ours": c.ours, "theirs": c.theirs, "kind": c.kind,
                })
        return merged, conflicts, theirs

    async def _kind_map_multi(self, s, pairs: Sequence[Tuple[str, str]]) -> Dict[str, str]:
        """``entity_id → kind`` across several ``(graph_id, branch_id)`` head sets
        (first match wins) — spans a fork and its parent for cross-graph merges."""
        out: Dict[str, str] = {}
        for gid, bid in pairs:
            rows = (await s.execute(
                select(EntityHeadORM.entity_id, EntityHeadORM.entity_kind).where(
                    EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == bid,
                )
            )).all()
            for eid, kind in rows:
                out.setdefault(eid, kind)
        return out

    async def _merkle_root(self, s, graph_id: str, branch_id: str) -> str:
        """Merkle root over a branch's full live state (fork-aware) — the O(graph)
        full build, used for draft checkpoints and fork mains (cross-branch CoW is
        a later step)."""
        state = await self._composed_state(s, graph_id, branch_id)
        live = {eid: content_hash(p) for eid, p in state.items() if p is not None}
        return MerkleTree.build(live).root

    async def _commit_merkle(self, s, graph_id: str, branch_id: str, commit, deltas: List[Delta]) -> str:
        """Merkle root for a commit. For a **non-fork `main`** (linear, long-lived)
        this is the incremental persisted CoW build — O(changed·depth), writing
        only changed-path rows. Forks fall back to the full build."""
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            return await self._merkle_root(s, graph_id, branch_id)
        changes: Dict[str, Optional[str]] = {
            d.entity_id: (None if d.op == "delete" else d.content_hash) for d in deltas
        }
        return await self._merkle.commit_tree(
            s, graph_id, branch_id, commit.id, commit.commit_seq, changes
        )

    async def _write_deltas(
        self, s, graph_id, branch_id, commit, deltas: List[Delta], kind_by_entity, actor
    ) -> None:
        for d in deltas:
            kind = kind_by_entity.get(d.entity_id, "node")
            if kind == "node":
                vid = prefixed_id("nv")
                p = d.payload or {}
                s.add(NodeVersionORM(
                    graph_id=graph_id, id=vid, entity_id=d.entity_id, commit_id=commit.id,
                    commit_seq=commit.commit_seq, branch_id=branch_id, op=d.op,
                    content_hash=d.content_hash, prev_content_hash=d.prev_content_hash,
                    payload=d.payload, actor=actor,
                    urn=p.get("urn"), entity_type=p.get("entityType"),
                    display_name=p.get("displayName"), qualified_name=p.get("qualifiedName"),
                ))
            else:
                vid = prefixed_id("ev")
                p = d.payload or {}
                s.add(EdgeVersionORM(
                    graph_id=graph_id, id=vid, entity_id=d.entity_id, commit_id=commit.id,
                    commit_seq=commit.commit_seq, branch_id=branch_id, op=d.op,
                    content_hash=d.content_hash, prev_content_hash=d.prev_content_hash,
                    payload=d.payload, actor=actor,
                    source_entity_id=p.get("sourceEntityId") or p.get("source_entity_id") or "",
                    target_entity_id=p.get("targetEntityId") or p.get("target_entity_id") or "",
                    edge_type=p.get("edgeType"), confidence=p.get("confidence"),
                    discriminator=p.get("discriminator"),
                ))
            # Upsert the head pointer (keeps version tables append-only).
            stmt = pg_insert(EntityHeadORM).values(
                graph_id=graph_id, branch_id=branch_id, entity_id=d.entity_id,
                entity_kind=kind, head_version_id=vid, content_hash=d.content_hash,
                is_tombstone=(d.op == "delete"), updated_at=_now(),
            ).on_conflict_do_update(
                index_elements=["graph_id", "branch_id", "entity_id"],
                set_={"head_version_id": vid, "content_hash": d.content_hash,
                      "is_tombstone": (d.op == "delete"), "updated_at": _now()},
            )
            await s.execute(stmt)

    async def _branch_contributors(self, s, graph_id, branch_id) -> List[str]:
        rows = (await s.execute(
            select(CommitORM.actor).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id,
                CommitORM.actor.is_not(None),
            ).distinct()
        )).scalars().all()
        return sorted(set(rows))

    async def _branch_commit_ids(self, s, graph_id, branch_id) -> List[str]:
        rows = (await s.execute(
            select(CommitORM.id).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id,
            ).order_by(CommitORM.commit_seq)
        )).scalars().all()
        return list(rows)

    async def _state_as_of(self, s, graph_id, branch_id, seq: int) -> Dict[str, Optional[dict]]:
        """Reconstruct a branch's state at ``commit_seq <= seq`` from version rows.

        Copy-on-write fork aware: a fork's ``main`` is seeded from its parent's
        state at the fork point (recursively, so a fork-of-a-fork resolves) before
        the fork's own divergence is overlaid — no parent rows are ever copied.
        """
        state: Dict[str, Optional[dict]] = {}
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            main_id = await self._main_branch_id(s, graph_id)
            if branch_id == main_id:
                parent_main = await self._main_branch_id(s, graph.fork_parent_graph_id)
                state.update(await self._state_as_of(
                    s, graph.fork_parent_graph_id, parent_main,
                    graph.fork_base_commit_seq or 0,
                ))
        for model in (NodeVersionORM, EdgeVersionORM):
            rows = (await s.execute(
                select(model).where(
                    model.graph_id == graph_id, model.branch_id == branch_id,
                    model.commit_seq <= seq,
                ).order_by(model.commit_seq, model.created_at)
            )).scalars().all()
            for r in rows:
                state[r.entity_id] = None if r.op == "delete" else r.payload
        return state

    async def _changed_in_window(self, s, graph_id, branch_id, from_seq, to_seq) -> set:
        """Entity ids touched by commits in ``(from_seq, to_seq]`` — O(changed),
        index-backed by ``ix_*_branch_changeset`` (a commit writes rows only for
        the entities it changed)."""
        changed: set = set()
        for model in (NodeVersionORM, EdgeVersionORM):
            rows = (await s.execute(
                select(model.entity_id).where(
                    model.graph_id == graph_id, model.branch_id == branch_id,
                    model.commit_seq > from_seq, model.commit_seq <= to_seq,
                ).distinct()
            )).scalars().all()
            changed.update(rows)
        return changed

    async def _values_at(self, s, graph_id, branch_id, ids, seq) -> Dict[str, Optional[dict]]:
        """Latest value (``commit_seq <= seq``) per entity in *ids* — O(ids) via
        DISTINCT ON (``ix_*_entity_hist``). Deleted → ``None``; absent ids omitted."""
        out: Dict[str, Optional[dict]] = {}
        if not ids:
            return out
        for model in (NodeVersionORM, EdgeVersionORM):
            stmt = (
                select(model.entity_id, model.op, model.payload)
                .where(model.graph_id == graph_id, model.branch_id == branch_id,
                       model.entity_id.in_(list(ids)), model.commit_seq <= seq)
                .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                .distinct(model.entity_id)
            )
            for eid, op, payload in (await s.execute(stmt)).all():
                out[eid] = None if op == "delete" else payload
        return out

    async def _entity_value_at(self, s, graph_id, branch_id, entity_id, seq) -> Optional[dict]:
        """One entity's value at ``seq`` (fork-aware): this graph, else the parent
        at the fork point (recursively)."""
        vals = await self._values_at(s, graph_id, branch_id, [entity_id], seq)
        if entity_id in vals:
            return vals[entity_id]
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            main_id = await self._main_branch_id(s, graph_id)
            if branch_id == main_id:
                pmain = await self._main_branch_id(s, graph.fork_parent_graph_id)
                return await self._entity_value_at(
                    s, graph.fork_parent_graph_id, pmain, entity_id,
                    min(seq, graph.fork_base_commit_seq or 0),
                )
        return None

    @staticmethod
    def _assert_referential_integrity(state: Mapping[str, Optional[dict]]) -> None:
        live = {eid for eid, p in state.items() if p is not None}
        for eid, p in state.items():
            if p is None:
                continue
            src = p.get("sourceEntityId") or p.get("source_entity_id")
            tgt = p.get("targetEntityId") or p.get("target_entity_id")
            if src is None and tgt is None:
                continue  # a node
            if src not in live or tgt not in live:
                raise ConcurrencyError(
                    f"edge {eid} would dangle (endpoint tombstoned): {src}->{tgt}"
                )


def _is_edge_payload(payload: Mapping) -> bool:
    """Edge payloads carry both endpoints; node payloads don't.  Lets a composed
    state be split into nodes/edges without a second kind lookup (the same
    heuristic the referential-integrity guard uses)."""
    if not payload:
        return False
    has_src = "sourceEntityId" in payload or "source_entity_id" in payload
    has_tgt = "targetEntityId" in payload or "target_entity_id" in payload
    return has_src and has_tgt


def _edge_src_tgt(p: Mapping) -> Tuple[str, str]:
    return (p.get("sourceEntityId") or p.get("source_entity_id") or "",
            p.get("targetEntityId") or p.get("target_entity_id") or "")


def _graphnode_dict(entity_id: str, urn: str, payload: dict) -> dict:
    """Reader-compatible GraphNode shape (by alias) from a version payload."""
    return {
        "urn": urn,
        "entityId": entity_id,
        "entityType": payload.get("entityType"),
        "displayName": payload.get("displayName") or "",
        "qualifiedName": payload.get("qualifiedName"),
        "description": payload.get("description"),
        "properties": payload.get("properties") or {},
        "tags": payload.get("tags") or [],
    }


def _graphedge_dict(entity_id: str, payload: dict, urn_of: Mapping) -> dict:
    src, tgt = _edge_src_tgt(payload)
    return {
        "id": entity_id,
        "sourceUrn": urn_of.get(src, f"gv:{src}"),
        "targetUrn": urn_of.get(tgt, f"gv:{tgt}"),
        "edgeType": payload.get("edgeType"),
        "confidence": payload.get("confidence"),
        "properties": payload.get("properties") or {},
    }


def _delta_stats(deltas: List[Delta]) -> dict:
    out = {"create": 0, "update": 0, "delete": 0}
    for d in deltas:
        out[d.op] += 1
    return out

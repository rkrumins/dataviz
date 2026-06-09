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

import asyncio
import contextlib
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import select, func, delete, update, or_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from . import config, db
from .changeset import Delta, materialize, net_delta, diff_states
from .ids import prefixed_id
from .merge import three_way_merge
from .merkle import MerkleTree, content_hash
from .merkle_store import MerkleStore
from .ontology import Ontology, validate_entities
from .models import (
    BranchORM,
    BranchMemberORM,
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


class OntologyViolation(RuntimeError):
    """Raised when ops/commit entities violate a graph's ontology under ``strict``
    enforcement. ``.violations`` is a JSON-able ``[{entity_id, kind, reason}]``."""

    def __init__(self, violations):
        super().__init__(f"{len(violations)} ontology violation(s)")
        self.violations = violations


class AccessDenied(RuntimeError):
    """Actor lacks the branch role required for an operation on a shared draft."""


class ApprovalRequired(RuntimeError):
    """A PR's required reviewers haven't all approved yet — merge is blocked."""

    def __init__(self, pr_id: str, pending):
        super().__init__(f"pr {pr_id} needs approval from {pending}")
        self.pr_id = pr_id
        self.pending = list(pending)


#: editor and maintainer may edit; only maintainer (and the owner) may manage/publish.
ROLE_RANK = {"viewer": 1, "editor": 2, "maintainer": 3}

# Terminal PR statuses — a merged or closed PR no longer "needs attention", so it is excluded
# from the active-PR scope the view indicator counts (the rest: open/mergeable/approved/conflicts).
_TERMINAL_PR_STATUS = ("merged", "closed")


class GraphVersioningService:
    """Service over the ``graphver`` store.  Each public method is one
    transaction (via :func:`db.graphver_session`) unless a session is passed."""

    def __init__(self, session_factory=db.graphver_session):
        self._session = session_factory
        self._merkle = MerkleStore()

    @contextlib.asynccontextmanager
    async def _session_scope(self, session=None):
        """Run within a caller-provided session (the caller owns commit/rollback, so
        several service calls compose into ONE atomic transaction) or, when none is
        given, open a fresh self-committing one. Lets the bootstrap create the graph
        and seed it in a single all-or-nothing transaction."""
        if session is not None:
            yield session
        else:
            async with self._session() as s:
                yield s

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
        falkor_provider: Optional[str] = None,
        ontology_spec: Optional[Mapping] = None,
        ontology_enforcement: Optional[str] = None,
        session=None,
    ) -> Dict[str, str]:
        """Create a blank versioned graph: graph row + ``main`` branch + empty
        genesis commit + projection state.  Returns ids and the genesis seq.

        Pass ``session`` to compose with a following ingest in one transaction (the
        atomic bootstrap), so a seed failure also rolls back the graph creation."""
        async with self._session_scope(session) as s:
            graph = GraphORM(
                data_source_id=data_source_id,
                workspace_id=workspace_id,
                tenant_id=tenant_id,
                kind=kind,
                base_ontology_id=base_ontology_id,
                ontology_spec=dict(ontology_spec) if ontology_spec else None,
                created_by=actor,
                main_head_commit_seq=1,
                **({"ontology_enforcement": ontology_enforcement} if ontology_enforcement else {}),
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
                    falkor_provider=falkor_provider,       # FalkorDB instance (per-provider eviction)
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
        shared: bool = False,
    ) -> str:
        """Open a per-user draft based on the graph's current ``main`` head.

        ``shared=True`` opens a collaborative draft: other users added via
        :meth:`add_branch_member` can edit it, and checkpoints field-merge
        concurrent edits (raising on same-field clashes) instead of clobbering."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            draft = BranchORM(
                graph_id=graph_id,
                kind="draft",
                name=name,
                owner=owner,
                is_shared=shared,
                base_commit_seq=graph.main_head_commit_seq,
                base_ontology_version_id=graph.base_ontology_version_id,
                originating_view_id=originating_view_id,
                created_by=owner,
            )
            s.add(draft)
            await s.flush()
            return draft.id

    # ------------------------------------------------------------------ #
    # Shared-draft membership (plan §8)                                   #
    # ------------------------------------------------------------------ #
    async def add_branch_member(
        self, *, graph_id: str, branch_id: str, subject_type: str, subject_id: str,
        role: str, actor: str, actor_groups: Sequence[str] = (),
    ) -> dict:
        """Grant a user/group a role on a draft (maintainer/owner only). Adding a
        member marks the draft shared; re-adding an existing subject updates role."""
        if role not in ROLE_RANK:
            raise ValueError(f"unknown role {role!r}")
        if subject_type not in ("user", "group"):
            raise ValueError(f"unknown subject_type {subject_type!r}")
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._require_manage(s, branch, actor, actor_groups)
            row = (await s.execute(select(BranchMemberORM).where(
                BranchMemberORM.branch_id == branch_id,
                BranchMemberORM.subject_type == subject_type,
                BranchMemberORM.subject_id == subject_id,
            ))).scalar_one_or_none()
            if row is None:
                s.add(BranchMemberORM(branch_id=branch_id, subject_type=subject_type,
                                      subject_id=subject_id, role=role))
            else:
                row.role = role
            if not branch.is_shared:
                branch.is_shared = True
            return {"subjectType": subject_type, "subjectId": subject_id, "role": role}

    async def remove_branch_member(
        self, *, graph_id: str, branch_id: str, subject_type: str, subject_id: str,
        actor: str, actor_groups: Sequence[str] = (),
    ) -> None:
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._require_manage(s, branch, actor, actor_groups)
            await s.execute(delete(BranchMemberORM).where(
                BranchMemberORM.branch_id == branch_id,
                BranchMemberORM.subject_type == subject_type,
                BranchMemberORM.subject_id == subject_id,
            ))

    async def list_branch_members(self, *, graph_id: str, branch_id: str) -> List[dict]:
        async with self._session() as s:
            await self._get_branch(s, graph_id, branch_id)
            rows = (await s.execute(select(BranchMemberORM).where(
                BranchMemberORM.branch_id == branch_id
            ).order_by(BranchMemberORM.created_at))).scalars().all()
            return [{"subjectType": r.subject_type, "subjectId": r.subject_id, "role": r.role}
                    for r in rows]

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
        actor_groups: Sequence[str] = (),
    ) -> Dict[str, str]:
        """Bulk-append working changes to a draft (plan decision #10).

        Each op: ``{ref?, op, entity_kind, entity_id?, payload, change_reason?}``.
        For ``create`` without an ``entity_id`` a stable ULID is minted.  Returns
        ``{ref_or_entity_id: entity_id}`` so the client can reconcile.
        """
        assigned: Dict[str, str] = {}
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            self._require_open(branch)
            await self._require_edit(s, branch, actor, actor_groups)
            graph = await s.get(GraphORM, graph_id)
            ontology = Ontology.from_spec(graph.ontology_spec) if graph else None
            entities: List[tuple] = []
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
                if op["op"] != "delete":
                    entities.append((entity_id, op["entity_kind"], payload))
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
            violations = validate_entities(entities, ontology)
            if violations and graph is not None and graph.ontology_enforcement == "strict":
                raise OntologyViolation(violations)      # rolls back — nothing staged
            return assigned

    async def checkpoint(
        self,
        *,
        graph_id: str,
        branch_id: str,
        actor: str,
        message: Optional[str] = None,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        actor_groups: Sequence[str] = (),
        containment_edge_types: Optional[Sequence[str]] = None,
    ) -> Optional[str]:
        """Fold uncommitted working changes into version rows under a new draft
        commit.  Returns the commit id, or ``None`` if nothing was staged.

        On a **shared** draft, concurrent edits from different collaborators are
        field-merged; a same-field clash raises :class:`MergeConflict` unless a
        ``resolutions`` payload (``{entity_id: payload|None}``) settles it."""
        async with self._session() as s:
            branch = await s.get(BranchORM, branch_id)
            if branch is None or branch.graph_id != graph_id:
                raise ValueError("unknown branch")
            self._require_open(branch)
            await self._require_edit(s, branch, actor, actor_groups)

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
            if branch.is_shared:
                head_state, conflicts = _fold_shared(
                    base_state, changes, frozenset(config.SET_FIELDS), resolutions or {}
                )
                if conflicts:
                    raise MergeConflict(conflicts)       # rolls back — nothing committed
            else:
                ops = [
                    {"entity_id": c.entity_id, "op": c.op, "payload": c.payload}
                    for c in changes
                ]
                head_state = materialize(base_state, ops)

            # Cascade containment deletes (ontology-driven): expand a deleted node to its
            # subtree + all incident edges so a checkpoint can't orphan descendants or dangle
            # edges — parity with apply_ops, via the same shared helper.
            del_nodes = {c.entity_id for c in changes
                         if c.op == "delete" and c.entity_kind == "node"}
            if del_nodes:
                subtree, inc_edges = await self._cascade_deletes(
                    s, graph_id, branch_id, del_nodes, containment_edge_types)
                extra = [e for e in (subtree | set(inc_edges)) if e not in base_state]
                extra_cur = await self._current_values(s, graph_id, branch_id, extra) if extra else {}
                for e in extra:
                    cur = extra_cur.get(e)
                    if cur is None:
                        continue
                    base_state[e] = cur            # so net_delta sees a delete
                    head_state[e] = None           # tombstone the descendant / incident edge
                    kind_by_entity[e] = "edge" if _is_edge_payload(cur) else "node"
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
        actor_groups: Sequence[str] = (),
    ) -> str:
        """Squash a draft into a single ``main`` commit, rebasing onto current
        main with a field-level 3-way merge (plan §8) — the ungated path (admin /
        no review). The reviewed path is :meth:`open_draft_mr` + :meth:`merge_mr`,
        which share the squash body in :meth:`_apply_draft_squash`.

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
            self._require_open(draft)
            if draft.is_shared:                           # publishing a shared draft → maintainer
                await self._require_manage(s, draft, actor, actor_groups)
            main_id = await self._main_branch_id(s, graph_id)

            merged_state, conflicts, theirs = await self._compute_merge(
                s, graph_id, graph, draft, main_id, dict(resolutions or {})
            )
            if conflicts:
                raise MergeConflict(conflicts)
            return await self._apply_draft_squash(
                s, graph, draft, main_id, merged_state, theirs, actor, message
            )

    async def _apply_draft_squash(
        self, s, graph, draft, main_id, merged_state, theirs, actor, message,
    ) -> str:
        """Squash a draft's (already-merged, conflict-free) state onto ``main`` as a
        single ``squash_publish`` commit: cascade incident-edge deletes, assert
        referential integrity, write the net delta, advance the head + merkle, and
        mark the draft merged + projection target. Shared by :meth:`publish` and the
        reviewed :meth:`merge_mr` (so both attribute contributors and re-gate ontology
        identically)."""
        # Deleting a node cascades to its incident edges in this same commit;
        # the guard then only rejects edges to an endpoint that never existed
        # (cross-entity conflict the per-entity merge can't see — §16.5 #8).
        self._cascade_incident_edges(merged_state)
        self._assert_referential_integrity(merged_state)

        deltas = net_delta(theirs, merged_state)   # what publish adds to main
        new_seq = graph.main_head_commit_seq + 1
        if not deltas:
            draft.status = "merged"
            draft.base_commit_seq = graph.main_head_commit_seq
            return draft.head_commit_id or ""

        contributors = await self._branch_contributors(s, graph.id, draft.id)
        source_commits = await self._branch_commit_ids(s, graph.id, draft.id)
        main = await s.get(BranchORM, main_id)
        squash = CommitORM(
            graph_id=graph.id,
            branch_id=main_id,
            commit_seq=new_seq,
            parent_commit_id=main.head_commit_id,
            kind="squash_publish",
            message=message,
            actor=actor,
            contributors=contributors,
            source_branch_id=draft.id,
            source_commit_ids=source_commits,
            source_commit_count=len(source_commits),
            originating_view_id=draft.originating_view_id,
        )
        s.add(squash)
        await s.flush()

        kind_by_entity = await self._kind_map_multi(
            s, [(graph.id, draft.id), (graph.id, main_id)]
        )
        ontology = Ontology.from_spec(graph.ontology_spec)   # PR re-validation gate (§16.5 #6)
        if ontology is not None and graph.ontology_enforcement == "strict":
            viol = validate_entities(
                [(d.entity_id, kind_by_entity.get(d.entity_id, "node"), d.payload)
                 for d in deltas if d.op != "delete"], ontology)
            if viol:
                raise OntologyViolation(viol)
        await self._write_deltas(s, graph.id, main_id, squash, deltas, kind_by_entity, actor)

        main.head_commit_id = squash.id
        graph.main_head_commit_seq = new_seq       # advance head before merkle
        squash.merkle_root = await self._commit_merkle(s, graph.id, main_id, squash, deltas)
        graph.updated_at = _now()
        squash.stats = _delta_stats(deltas)
        draft.status = "merged"
        draft.base_commit_seq = new_seq            # rebased onto new main

        ps = await s.get(ProjectionStateORM, graph.id)
        if ps is not None:
            ps.target_commit_seq = new_seq
        return squash.id

    async def abandon_draft(
        self, *, graph_id: str, branch_id: str, actor: str,
        actor_groups: Sequence[str] = (),
    ) -> dict:
        """Mark an open draft ``abandoned`` (plan §17 #8): it becomes inert — no
        further stage/checkpoint/publish. Re-abandoning is idempotent; ``main`` and
        already-merged drafts cannot be abandoned. A shared draft needs a maintainer.
        Staged rows are left in place for audit (the branch is simply unreachable)."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            if branch.kind == "main":
                raise ValueError("cannot abandon main")
            if branch.status == "abandoned":
                return self._branch_meta(branch)          # idempotent
            self._require_open(branch)                    # merged/publishing → reject
            if branch.is_shared:
                await self._require_manage(s, branch, actor, actor_groups)
            branch.status = "abandoned"
            branch.updated_at = _now()
            return self._branch_meta(branch)

    async def sweep_idle_drafts(
        self, *, now: Optional[datetime] = None, ttl_days: Optional[int] = None,
    ) -> List[str]:
        """Auto-abandon open drafts idle past the TTL (plan §17 #8) and return the
        ids swept. One ``UPDATE … RETURNING`` — O(stale), atomic. Only ``open``
        drafts/fork-drafts are touched; ``main`` and terminal branches are left be.
        ``updated_at`` is the idle clock (bumped by checkpoint/publish/abandon)."""
        ttl = config.DRAFT_TTL_DAYS if ttl_days is None else ttl_days
        cutoff = ((now or datetime.now(timezone.utc)) - timedelta(days=ttl)).isoformat()
        async with self._session() as s:
            swept = (await s.execute(
                update(BranchORM)
                .where(
                    BranchORM.kind.in_(("draft", "fork_draft")),
                    BranchORM.status == "open",
                    BranchORM.updated_at < cutoff,
                )
                .values(status="abandoned", updated_at=_now())
                .returning(BranchORM.id)
            )).scalars().all()
            return list(swept)

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

    async def revert_commit(
        self, *, graph_id: str, commit_id: str, actor: str, message: Optional[str] = None,
    ) -> str:
        """Apply the inverse of a published commit as a new ``revert`` commit on
        main (plan §17): restore every entity that commit touched to its
        pre-commit state. If a later commit also changed one of those entities the
        revert can't apply cleanly and raises :class:`MergeConflict`. Deleting a
        node on revert cascades to its incident edges, same as publish."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)
            target = await s.get(CommitORM, (graph_id, commit_id))
            if target is None or target.branch_id != main_id:
                raise ValueError("commit is not on this graph's main")
            if target.kind == "genesis":
                raise ValueError("cannot revert the genesis commit")

            k, head_seq = target.commit_seq, graph.main_head_commit_seq
            before = await self._state_as_of(s, graph_id, main_id, k - 1)
            after = await self._state_as_of(s, graph_id, main_id, k)
            cur = await self._state_as_of(s, graph_id, main_id, head_seq)
            touched = await self._changed_in_window(s, graph_id, main_id, k - 1, k)

            conflicts = [
                {"entity_id": eid, "path": [], "reason": "modified after the reverted commit"}
                for eid in sorted(touched)
                if content_hash(cur.get(eid)) != content_hash(after.get(eid))
            ]
            if conflicts:
                raise MergeConflict(conflicts)

            merged = dict(cur)
            for eid in touched:
                merged[eid] = before.get(eid)          # restore (None ⇒ tombstone)
            self._cascade_incident_edges(merged)
            self._assert_referential_integrity(merged)

            deltas = net_delta(cur, merged)
            if not deltas:
                return ""                              # nothing to undo

            new_seq = head_seq + 1
            main = await s.get(BranchORM, main_id)
            revert = CommitORM(
                graph_id=graph_id, branch_id=main_id, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="revert",
                message=message or f"revert {commit_id}", actor=actor,
            )
            s.add(revert)
            await s.flush()
            kind_by_entity = await self._kind_map_multi(s, [(graph_id, main_id)])
            await self._write_deltas(s, graph_id, main_id, revert, deltas, kind_by_entity, actor)
            main.head_commit_id = revert.id
            graph.main_head_commit_seq = new_seq
            revert.merkle_root = await self._commit_merkle(s, graph_id, main_id, revert, deltas)
            graph.updated_at = _now()
            revert.stats = _delta_stats(deltas)
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return revert.id

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
                falkor_provider=(parent_ps.falkor_provider if parent_ps else None),  # same instance as parent
            ))
            return {
                "graph_id": fork.id,
                "main_branch_id": main.id,
                "fork_base_commit_seq": base_seq,
            }

    async def open_pr(
        self, *, source_graph_id: str, actor: str, title: Optional[str] = None,
        description: Optional[str] = None, reviewers: Optional[Sequence[str]] = None,
    ) -> str:
        """Open a PR from a fork's ``main`` back to its parent's ``main``,
        recording the current mergeability/conflict set (plan §12.5).

        ``reviewers`` makes approval a merge precondition: every listed reviewer
        must :meth:`approve_pr` before the PR can merge (plan §17 #5)."""
        async with self._session() as s:
            fork = await s.get(GraphORM, source_graph_id)
            if fork is None or not fork.fork_parent_graph_id:
                raise ValueError("source graph is not a fork")
            fork_main = await self._main_branch_id(s, source_graph_id)
            merged, conflicts, _theirs = await self._compute_fork_merge(s, fork, {})
            revs = list(dict.fromkeys(reviewers or []))      # dedup, keep order
            pr = MergeRequestORM(
                graph_id=source_graph_id,
                source_branch_id=fork_main,
                target_graph_id=fork.fork_parent_graph_id,
                target_branch="main",
                base_commit_seq=fork.fork_base_commit_seq,
                status="conflicts" if conflicts else "mergeable",
                title=(title or None),
                description=(description or None),
                conflicts=conflicts or None,
                reviewers=revs or None,
                approval_status="pending" if revs else None,
                actor=actor,
            )
            s.add(pr)
            await s.flush()
            return pr.id

    async def approve_pr(self, *, pr_id: str, actor: str) -> dict:
        """Record ``actor``'s approval of a PR. The author can't approve their own
        PR; once every requested reviewer has approved, ``approval_status`` flips
        to ``approved`` (and an otherwise-mergeable PR to status ``approved``)."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            if pr.status in ("merged", "closed"):
                raise ValueError(f"pr {pr_id} is {pr.status}")
            if actor == pr.actor:
                raise AccessDenied("author cannot approve their own PR")
            approved = list(dict.fromkeys((pr.approved_by or []) + [actor]))
            pr.approved_by = approved
            reviewers = set(pr.reviewers or [])
            pr.approval_status = "approved" if reviewers <= set(approved) else "pending"
            if pr.approval_status == "approved" and pr.status == "mergeable":
                pr.status = "approved"
            pr.updated_at = _now()
            return self._pr_meta(pr)

    async def close_pr(self, *, pr_id: str, actor: Optional[str] = None) -> dict:
        """Close a PR without merging — terminal: approve_pr and merge_pr both
        reject a closed PR. Idempotent; an already-merged PR cannot be closed."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            if pr.status == "closed":
                return self._pr_meta(pr)              # idempotent
            if pr.status == "merged":
                raise ValueError(f"pr {pr_id} is merged")
            pr.status = "closed"
            pr.closed_at = _now()
            pr.closed_by = actor
            pr.updated_at = _now()
            return self._pr_meta(pr)

    async def update_pr(
        self, *, pr_id: str, title: Optional[str] = None, description: Optional[str] = None,
    ) -> dict:
        """Edit a PR's human title + description (review metadata only — does not touch the
        merge or status). PATCH semantics: a field left ``None`` is untouched, an empty
        string clears it."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            if title is not None:
                pr.title = title.strip() or None
            if description is not None:
                pr.description = description.strip() or None
            pr.updated_at = _now()
            return self._pr_meta(pr)

    @staticmethod
    def _pr_ontology_check(parent: GraphORM, deltas, kind_by_entity) -> dict:
        """Re-validate a PR's merged result against the *target* graph's ontology
        (the PR checks gate, §16.5 #6).  ``ok`` is false only under ``strict``
        enforcement with violations; ``permissive`` records warnings but passes."""
        ontology = Ontology.from_spec(parent.ontology_spec)
        violations = validate_entities(
            [(d.entity_id, kind_by_entity.get(d.entity_id, "node"), d.payload)
             for d in deltas if d.op != "delete"], ontology)
        ok = not violations or parent.ontology_enforcement != "strict"
        return {"ontology": {"ok": ok, "violations": violations}}

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
            if pr.status in ("merged", "closed"):
                raise ValueError(f"pr {pr_id} is {pr.status}")
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
            self._cascade_incident_edges(merged)
            self._assert_referential_integrity(merged)

            deltas = net_delta(theirs, merged)
            if not deltas:
                pr.status = "merged"
                return ""

            # PR gates (P8): re-validate the merged result against the target's
            # ontology, then require every requested reviewer's approval — both
            # checked before any write to main.
            kind_by_entity = await self._kind_map_multi(
                s, [(fork.id, fork_main), (parent.id, parent_main)]
            )
            checks = self._pr_ontology_check(parent, deltas, kind_by_entity)
            pr.checks_status = checks
            if not checks["ontology"]["ok"]:
                raise OntologyViolation(checks["ontology"]["violations"])
            reviewers = set(pr.reviewers or [])
            if reviewers and pr.approval_status != "approved":
                raise ApprovalRequired(pr_id, sorted(reviewers - set(pr.approved_by or [])))

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

            await self._write_deltas(s, parent.id, parent_main, squash, deltas, kind_by_entity, actor)

            main.head_commit_id = squash.id
            parent.main_head_commit_seq = new_seq      # advance head before merkle
            parent.updated_at = _now()
            squash.merkle_root = await self._commit_merkle(s, parent.id, parent_main, squash, deltas)
            squash.stats = _delta_stats(deltas)

            pr.status = "merged"
            pr.resulting_commit_id = squash.id
            pr.merged_at = _now()
            pr.merged_by = actor
            pr.updated_at = _now()
            ps = await s.get(ProjectionStateORM, parent.id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return squash.id

    # ---- draft → main merge request (reviewed publish) ------------------- #
    @staticmethod
    def _is_draft_mr(pr: MergeRequestORM) -> bool:
        """A same-graph draft→main MR (vs a legacy fork PR, where source_graph_id is
        NULL or the parent)."""
        return bool(pr.source_graph_id and pr.source_graph_id == pr.target_graph_id)

    async def open_draft_mr(
        self, *, graph_id: str, branch_id: str, actor: str,
        title: Optional[str] = None, description: Optional[str] = None,
        reviewers: Optional[Sequence[str]] = None,
    ) -> str:
        """Open a merge request from a per-user ``draft`` back to its own graph's
        ``main`` — the reviewed alternative to a bare :meth:`publish`. Records the
        current mergeability/conflict set + the ``title``/``description``;
        ``reviewers`` makes approval a merge precondition (plan §17 #5)."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            draft = await s.get(BranchORM, branch_id)
            if graph is None or draft is None or draft.graph_id != graph_id:
                raise ValueError("unknown graph/branch")
            if draft.kind == "main":
                raise ValueError("cannot open a merge request for main")
            self._require_open(draft)
            main_id = await self._main_branch_id(s, graph_id)
            _merged, conflicts, _theirs = await self._compute_merge(
                s, graph_id, graph, draft, main_id, {}
            )
            revs = list(dict.fromkeys(reviewers or []))      # dedup, keep order
            pr = MergeRequestORM(
                graph_id=graph_id,
                source_graph_id=graph_id,                    # source == target ⇒ draft MR
                source_branch_id=branch_id,
                target_graph_id=graph_id,
                target_branch="main",
                base_commit_seq=draft.base_commit_seq,
                status="conflicts" if conflicts else "mergeable",
                title=(title or None),
                description=(description or None),
                conflicts=conflicts or None,
                reviewers=revs or None,
                approval_status="pending" if revs else None,
                actor=actor,
            )
            s.add(pr)
            await s.flush()
            return pr.id

    async def preview_mr(self, *, mr_id: str) -> Dict[str, object]:
        """Dry-run a merge request's merge (conflicts + change counts), dispatching
        draft→main vs fork→parent."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, mr_id)
            if pr is None:
                raise ValueError(f"unknown merge request {mr_id}")
            if self._is_draft_mr(pr):
                graph = await s.get(GraphORM, pr.target_graph_id)
                draft = await s.get(BranchORM, pr.source_branch_id)
                main_id = await self._main_branch_id(s, graph.id)
                merged, conflicts, theirs = await self._compute_merge(
                    s, graph.id, graph, draft, main_id, {}
                )
            else:
                fork = await s.get(GraphORM, pr.graph_id)
                merged, conflicts, theirs = await self._compute_fork_merge(s, fork, {})
            return {
                "clean": not conflicts,
                "conflicts": conflicts,
                "changes": _delta_stats(net_delta(theirs, merged)),
            }

    async def _pr_merge_states(self, s, pr):
        """``(merged, theirs)`` for a PR — the 3-way merge result and the target side, the
        shared basis for both the flat diff and the hierarchical summary. Dispatches
        draft→main vs fork→parent (same as :meth:`diff_pr` / :meth:`preview_mr`)."""
        if self._is_draft_mr(pr):
            graph = await s.get(GraphORM, pr.target_graph_id)
            draft = await s.get(BranchORM, pr.source_branch_id)
            main_id = await self._main_branch_id(s, graph.id)
            merged, _conflicts, theirs = await self._compute_merge(
                s, graph.id, graph, draft, main_id, {}
            )
        else:
            fork = await s.get(GraphORM, pr.graph_id)
            merged, _conflicts, theirs = await self._compute_fork_merge(s, fork, {})
        return merged, theirs

    async def diff_pr(self, *, pr_id: str) -> Dict[str, object]:
        """Itemised **Files Changed** for a PR — the SAME 3-way computation as
        :meth:`preview_mr` (so the diff's item count equals the preview's change count),
        reshaped into the UI's ``DiffVsMainResponse`` overlay shape. Dispatches draft→main
        vs fork→parent; the diff is the merge's net effect on the target
        (``net_delta(theirs, merged)``), i.e. what merging this PR changes in the base."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pull request {pr_id}")
            merged, theirs = await self._pr_merge_states(s, pr)
        return _deltas_to_diff_vs_main(net_delta(theirs, merged), theirs)

    async def diff_pr_summary(
        self, *, pr_id: str, containment_edge_types, limit: int = 200,
    ) -> Dict[str, object]:
        """Top level of a PR's **hierarchical** Files Changed: changed entities grouped into
        a containment tree (top-level containers + type buckets) with rolled-up counts and an
        entityType impact summary, capped at ``limit``. Same 3-way merge as :meth:`diff_pr`
        (so the global counts equal the flat diff's), reshaped lazily so a huge change set
        stays a bounded response (children load per :meth:`diff_pr_children`)."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pull request {pr_id}")
            merged, theirs = await self._pr_merge_states(s, pr)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_summary_view(index, limit)

    async def diff_pr_children(
        self, *, pr_id: str, container_key: str, containment_edge_types,
        limit: int = 200, offset: int = 0,
    ) -> Dict[str, object]:
        """One container's (or bucket's) direct children in a PR's hierarchical diff — the
        lazy-load step behind :meth:`diff_pr_summary`. Sub-containers come back as expandable
        group rows; leaves carry whole-payload before/after for the diff overlay."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pull request {pr_id}")
            merged, theirs = await self._pr_merge_states(s, pr)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_children_view(index, container_key, limit, offset)

    async def merge_mr(
        self, *, mr_id: str, actor: str, message: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
    ) -> str:
        """Merge a merge request, dispatching on its kind: a fork PR delegates to
        :meth:`merge_pr`; a draft→main MR recomputes the 3-way merge at merge time
        (main may have advanced under continued editing), enforces the
        reviewer-approval gate, then squashes via the shared :meth:`_apply_draft_squash`."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, mr_id)
            if pr is None:
                raise ValueError(f"unknown merge request {mr_id}")
            is_draft = self._is_draft_mr(pr)
        if not is_draft:
            return await self.merge_pr(
                pr_id=mr_id, actor=actor, message=message, resolutions=resolutions
            )
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, mr_id)
            if pr.status in ("merged", "closed"):
                raise ValueError(f"merge request {mr_id} is {pr.status}")
            graph = await s.get(GraphORM, pr.target_graph_id)
            draft = await s.get(BranchORM, pr.source_branch_id)
            if graph is None or draft is None:
                raise ValueError("merge request endpoints missing")
            self._require_open(draft)
            main_id = await self._main_branch_id(s, graph.id)
            merged_state, conflicts, theirs = await self._compute_merge(
                s, graph.id, graph, draft, main_id, dict(resolutions or {})
            )
            if conflicts:
                raise MergeConflict(conflicts)
            reviewers = set(pr.reviewers or [])              # approval gate (plan §17 #5)
            if reviewers and pr.approval_status != "approved":
                raise ApprovalRequired(mr_id, sorted(reviewers - set(pr.approved_by or [])))
            commit_id = await self._apply_draft_squash(
                s, graph, draft, main_id, merged_state, theirs, actor, message
            )
            pr.status = "merged"
            pr.resulting_commit_id = commit_id
            pr.merged_at = _now()
            pr.merged_by = actor
            pr.updated_at = _now()
            return commit_id

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
        self, *, graph_id: str, branch_id: str, as_of_seq: Optional[int] = None,
    ) -> Dict[str, Dict[str, dict]]:
        """Node/edge payloads for a branch (fork-aware composition). ``as_of_seq``
        reconstructs the state at ``commit_seq <= as_of_seq`` (time-travel); ``None``
        is the branch's current head.

        Read straight from the version store (the source of truth); the FalkorDB
        projection is the hot read path and sits behind the same API.
        """
        async with self._session() as s:
            state = (
                await self._composed_state(s, graph_id, branch_id)
                if as_of_seq is None
                else await self._composed_state_as_of(s, graph_id, branch_id, as_of_seq)
            )
            nodes, edges = {}, {}
            for eid, p in state.items():
                if p is None:
                    continue
                (edges if _is_edge_payload(p) else nodes)[eid] = p
            return {"nodes": nodes, "edges": edges}

    async def state_at_commit(
        self, *, graph_id: str, commit_id: str
    ) -> Dict[str, Dict[str, dict]]:
        """Full branch state as of a specific commit (time-travel by commit id)."""
        async with self._session() as s:
            c = await s.get(CommitORM, (graph_id, commit_id))
            if c is None:
                raise ValueError(f"unknown commit {commit_id}")
            branch_id, seq = c.branch_id, c.commit_seq
        return await self.materialize_state(graph_id=graph_id, branch_id=branch_id, as_of_seq=seq)

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
        self, *, graph_id: str, urn: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, depth: int = 1,
        direction: str = "both", edge_types: Optional[Sequence[str]] = None,
        limit: int = 500,
    ) -> Dict[str, List[dict]]:
        """Bounded neighborhood of a node on a branch (default `main`), served from
        Postgres — the fallback for the FalkorDB traversal when the projection
        lags/evicts, and the only path for drafts and as-of reads.

        Cost is **O(neighborhood)**, not O(graph): a hop-by-hop BFS that resolves only
        the start node and, per hop, the frontier's incident live edges via
        ix_ev_source/ix_ev_target (bounded by degree) — never composing full state.
        Reader-compatible shapes (GraphNode/GraphEdge by alias).
        """
        et = set(edge_types) if edge_types else None
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            start = await self._eid_for_urn(s, graph_id, branch_id, urn, as_of_seq)
            if start is None:
                return {"nodes": [], "edges": []}

            seen_nodes = {start}
            seen_edges: Dict[str, dict] = {}
            frontier = {start}
            for _ in range(max(1, depth)):
                if not frontier or len(seen_nodes) >= limit:
                    break
                inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
                nxt: set = set()
                for eid, p in inc.items():
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
                    if hit is None:
                        continue
                    seen_edges[eid] = p
                    if hit not in seen_nodes:
                        if len(seen_nodes) >= limit:
                            continue
                        seen_nodes.add(hit)
                        nxt.add(hit)
                frontier = nxt

            payloads = await self._current_values(s, graph_id, branch_id, seen_nodes, as_of_seq)

        nodes = {eid: p for eid, p in payloads.items() if p is not None and not _is_edge_payload(p)}
        urn_of = {eid: (p.get("urn") or f"gv:{eid}") for eid, p in nodes.items()}
        out_nodes = [_graphnode_dict(eid, urn_of[eid], nodes[eid]) for eid in nodes]
        out_edges = [
            _graphedge_dict(eid, p, urn_of) for eid, p in seen_edges.items()
            if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes
        ]
        return {"nodes": out_nodes, "edges": out_edges}

    async def _branch_read_seqs(
        self, s, graph_id: str, branch_id: str, main_id: str, as_of_seq: Optional[int],
    ) -> Tuple[int, Optional[int]]:
        """The two sequence bounds a branch read composes over: the discovery cap on the
        shared ``main`` base and the overlay cap on the branch. ``main`` itself has no
        overlay (``None``); ``as_of_seq`` caps both for time-travel."""
        if branch_id == main_id:
            g = await s.get(GraphORM, graph_id)
            head = g.main_head_commit_seq if g else 0
            return (head if as_of_seq is None else min(head, as_of_seq)), None
        b = await s.get(BranchORM, branch_id)
        base_seq = b.base_commit_seq or 0
        base = base_seq if as_of_seq is None else min(base_seq, as_of_seq)
        overlay = (1 << 62) if as_of_seq is None else as_of_seq
        return base, overlay

    async def _latest_live_ids(
        self, s, model, graph_id: str, branch_id: str, seq: int,
        *, where: Optional[Callable] = None, limit: Optional[int] = None,
    ) -> List[str]:
        """Entity ids whose latest version on ``branch_id`` at ``commit_seq <= seq`` is live
        (not a tombstone), optionally narrowed by ``where`` (predicates over the denormalised
        version columns). DISTINCT ON picks the latest row per entity *before* the live/where
        filter, so a stale revision can never shadow the current one. Bounded by ``limit`` and
        ordered by entity_id for a stable window."""
        latest = (
            select(model)
            .where(model.graph_id == graph_id, model.branch_id == branch_id,
                   model.commit_seq <= seq)
            .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
            .distinct(model.entity_id)
            .subquery()
        )
        stmt = select(latest.c.entity_id).where(latest.c.op != "delete")
        if where is not None:
            preds = where(latest.c)
            if preds:
                stmt = stmt.where(*preds)
        stmt = stmt.order_by(latest.c.entity_id)
        if limit is not None:
            stmt = stmt.limit(limit)
        return list((await s.execute(stmt)).scalars().all())

    async def _eids_for_urns(
        self, s, graph_id: str, branch_id: str, urns, as_of_seq: Optional[int] = None,
    ) -> set:
        """Resolve a small set of seed urns to live entity_ids on a branch (bounded)."""
        out: set = set()
        for u in urns or []:
            eid = await self._eid_for_urn(s, graph_id, branch_id, u, as_of_seq)
            if eid is not None:
                out.add(eid)
        return out

    async def get_node_from_state(
        self, *, graph_id: str, urn: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, containment_edge_types: Optional[Sequence[str]] = None,
    ) -> Optional[dict]:
        """A single node by urn on a branch (default ``main``), branch/as-of composed — the
        draft/as-of counterpart of the provider's ``get_node``. Reader-shaped or ``None``;
        carries ``childCount`` (parity with FalkorDB) when containment types are supplied."""
        cset = {t.upper() for t in (containment_edge_types or [])}
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            eid = await self._eid_for_urn(s, graph_id, branch_id, urn, as_of_seq)
            if eid is None:
                return None
            p = (await self._current_values(s, graph_id, branch_id, [eid], as_of_seq)).get(eid)
            if p is None or _is_edge_payload(p):
                return None
            nd = _graphnode_dict(eid, p.get("urn") or f"gv:{eid}", p)
            await self._attach_child_counts(s, graph_id, branch_id, [nd], cset, as_of_seq)
        return nd

    async def _attach_child_counts(self, s, graph_id, branch_id, node_dicts, cset, as_of_seq):
        """Attach each node's OUT-containment child count to its reader dict — the single
        count-shaping path shared by every branch/as-of node read (``get_nodes_from_state``,
        ``get_children_with_edges_from_state``, ``top_level_from_state``), so the Postgres
        reader can't drift from FalkorDB (which counts children in every read). One bounded
        ``_incident_live_edges`` scan over the page's ids; ``childCount`` is always set (0 when
        there are no containment children), matching FalkorDB's ``0 as childCount``."""
        ids = {nd["entityId"] for nd in node_dicts}
        counts: Dict[str, int] = {}
        if cset and ids:
            inc = await self._incident_live_edges(s, graph_id, branch_id, ids, as_of_seq)
            for _eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, _b = _edge_src_tgt(p)
                if a in ids:
                    counts[a] = counts.get(a, 0) + 1
        for nd in node_dicts:
            _set_child_count(nd, counts.get(nd["entityId"], 0))

    async def get_nodes_from_state(
        self, *, graph_id: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, urns: Optional[Sequence[str]] = None,
        entity_types: Optional[Sequence[str]] = None,
        search_query: Optional[str] = None, limit: int = 100, offset: int = 0,
        containment_edge_types: Optional[Sequence[str]] = None,
        include_child_count: bool = True,
    ) -> List[dict]:
        """Branch- and as-of-aware node filter read, served from Postgres — the draft/as-of
        counterpart of the provider's ``get_nodes``, so a user working in a draft sees their
        draft's view, not ``main``'s. Bounded: discover candidate ids from the shared ``main``
        base (pushed-down denorm-column filters, capped) ∪ the draft's tiny overlay, compose
        the authoritative value via ``_current_values``, then re-apply the predicate (so an
        overlay edit that flips whether a base node matches is honoured). Never composes full
        state. Reader-shaped GraphNode dicts, sorted by display name.

        Pagination is exact for a page that fits the fetch window (the common draft case); a
        very large filtered set at a deep ``offset`` is best-effort — the hot, deeply-paged
        path is ``main`` via FalkorDB, not this fallback."""
        urn_set = set(urns) if urns else None
        type_set = set(entity_types) if entity_types else None
        q = (search_query or "").strip().lower()

        def matches(p: dict) -> bool:
            if urn_set is not None and p.get("urn") not in urn_set:
                return False
            if type_set is not None and p.get("entityType") not in type_set:
                return False
            if q:
                hay = " ".join(str(p.get(k) or "")
                               for k in ("displayName", "qualifiedName", "urn")).lower()
                if q not in hay:
                    return False
            return True

        def where(c):
            preds = []
            if type_set is not None:
                preds.append(c.entity_type.in_(list(type_set)))
            if urn_set is not None:
                preds.append(c.urn.in_(list(urn_set)))
            if q:
                like = f"%{q}%"
                preds.append(or_(func.lower(c.display_name).like(like),
                                 func.lower(c.qualified_name).like(like),
                                 func.lower(c.urn).like(like)))
            return preds

        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            base_seq, overlay_seq = await self._branch_read_seqs(
                s, graph_id, branch_id, main_id, as_of_seq)
            overlay_ids: List[str] = []
            if overlay_seq is not None:
                overlay_ids = list((await s.execute(
                    select(NodeVersionORM.entity_id).where(
                        NodeVersionORM.graph_id == graph_id,
                        NodeVersionORM.branch_id == branch_id,
                        NodeVersionORM.commit_seq <= overlay_seq,
                    ).distinct()
                )).scalars().all())
            window = offset + limit + len(overlay_ids) + 1
            cand = set(await self._latest_live_ids(
                s, NodeVersionORM, graph_id, main_id, base_seq, where=where, limit=window))
            cand.update(overlay_ids)
            vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
            rows = [
                _graphnode_dict(eid, p.get("urn") or f"gv:{eid}", p)
                for eid, p in vals.items()
                if p is not None and not _is_edge_payload(p) and matches(p)
            ]
            rows.sort(key=lambda r: ((r.get("displayName") or ""), r["entityId"]))
            page = rows[offset: offset + limit]
            if include_child_count:
                cset = {t.upper() for t in (containment_edge_types or [])}
                await self._attach_child_counts(s, graph_id, branch_id, page, cset, as_of_seq)
        return page

    async def search_from_state(
        self, *, graph_id: str, query: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, limit: int = 25,
    ) -> List[dict]:
        """Name/qualified-name/urn substring search on a branch (default ``main``) — the
        draft/as-of counterpart of the provider's search. Thin wrapper over
        ``get_nodes_from_state``."""
        return await self.get_nodes_from_state(
            graph_id=graph_id, branch_id=branch_id, as_of_seq=as_of_seq,
            search_query=query, limit=limit)

    async def get_edges_from_state(
        self, *, graph_id: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, source_urns: Optional[Sequence[str]] = None,
        target_urns: Optional[Sequence[str]] = None, any_urns: Optional[Sequence[str]] = None,
        edge_types: Optional[Sequence[str]] = None, min_confidence: Optional[float] = None,
        limit: int = 100, offset: int = 0,
    ) -> List[dict]:
        """Branch- and as-of-aware edge filter read, served from Postgres — the draft/as-of
        counterpart of the provider's ``get_edges``. With endpoint urns it walks the
        endpoints' incident live edges (bounded by degree via ix_ev_source/ix_ev_target);
        otherwise it discovers edges by type from the shared base ∪ the draft overlay.
        Endpoints are resolved to urns for reader-shaped GraphEdge dicts."""
        et = set(edge_types) if edge_types else None
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)

            src_ids = await self._eids_for_urns(s, graph_id, branch_id, source_urns, as_of_seq) if source_urns else None
            tgt_ids = await self._eids_for_urns(s, graph_id, branch_id, target_urns, as_of_seq) if target_urns else None
            any_ids = await self._eids_for_urns(s, graph_id, branch_id, any_urns, as_of_seq) if any_urns else None

            cand_edges: Dict[str, dict] = {}
            if src_ids is not None or tgt_ids is not None or any_ids is not None:
                seeds: set = set()
                for grp in (src_ids, tgt_ids, any_ids):
                    if grp:
                        seeds.update(grp)
                inc = await self._incident_live_edges(s, graph_id, branch_id, seeds, as_of_seq)
                for eid, p in inc.items():
                    a, b = _edge_src_tgt(p)
                    if src_ids is not None and a not in src_ids:
                        continue
                    if tgt_ids is not None and b not in tgt_ids:
                        continue
                    if any_ids is not None and not (a in any_ids or b in any_ids):
                        continue
                    cand_edges[eid] = p
            else:
                base_seq, overlay_seq = await self._branch_read_seqs(
                    s, graph_id, branch_id, main_id, as_of_seq)
                overlay_ids: List[str] = []
                if overlay_seq is not None:
                    overlay_ids = list((await s.execute(
                        select(EdgeVersionORM.entity_id).where(
                            EdgeVersionORM.graph_id == graph_id,
                            EdgeVersionORM.branch_id == branch_id,
                            EdgeVersionORM.commit_seq <= overlay_seq,
                        ).distinct()
                    )).scalars().all())
                window = offset + limit + len(overlay_ids) + 1
                cand = set(await self._latest_live_ids(
                    s, EdgeVersionORM, graph_id, main_id, base_seq,
                    where=(lambda c: [c.edge_type.in_(list(et))]) if et is not None else None,
                    limit=window))
                cand.update(overlay_ids)
                vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
                cand_edges = {eid: p for eid, p in vals.items()
                              if p is not None and _is_edge_payload(p)}

            sel: Dict[str, dict] = {}
            for eid, p in cand_edges.items():
                if et is not None and p.get("edgeType") not in et:
                    continue
                if min_confidence is not None and (p.get("confidence") or 0.0) < min_confidence:
                    continue
                sel[eid] = p

            endpoint_ids: set = set()
            for p in sel.values():
                a, b = _edge_src_tgt(p)
                endpoint_ids.add(a)
                endpoint_ids.add(b)
            node_vals = await self._current_values(s, graph_id, branch_id, endpoint_ids, as_of_seq)

        urn_of = {
            eid: ((p.get("urn") if (p is not None and not _is_edge_payload(p)) else None) or f"gv:{eid}")
            for eid, p in node_vals.items()
        }
        out = [_graphedge_dict(eid, p, urn_of) for eid, p in sel.items()]
        out.sort(key=lambda r: r["id"])
        return out[offset: offset + limit]

    async def get_children_with_edges_from_state(
        self, *, graph_id: str, parent_urn: str, containment_edge_types: Sequence[str],
        lineage_edge_types: Optional[Sequence[str]] = None, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, include_lineage_edges: bool = True,
        include_child_count: bool = True, limit: int = 100, offset: int = 0,
    ) -> Dict[str, object]:
        """Branch/as-of-aware children-with-edges — the draft/as-of counterpart of the
        provider's ``get_children_with_edges``. One bounded round trip: the parent's OUT
        containment edges give the children (in = ancestors), then the page children's
        cross-edges give the lineage edges within {parent} ∪ children. Bounded by the
        parent's and the page's degree (ix_ev_source/target); mirrors ChildrenWithEdgesResult.
        Edge-type classification is the graph's ontology sets, matched case-insensitively."""
        cset = {t.upper() for t in (containment_edge_types or [])}
        lset = {t.upper() for t in lineage_edge_types} if lineage_edge_types else None
        empty = {"children": [], "containmentEdges": [], "lineageEdges": [],
                 "totalChildren": 0, "hasMore": False, "nextCursor": None}
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            parent = await self._eid_for_urn(s, graph_id, branch_id, parent_urn, as_of_seq)
            if parent is None:
                return empty
            # parent's live incident edges → OUT containment edges name the children
            inc = await self._incident_live_edges(s, graph_id, branch_id, {parent}, as_of_seq)
            cont_edge: Dict[str, Tuple[str, dict]] = {}   # child_eid -> (edge_id, payload)
            for eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)
                if a == parent and b != parent:
                    cont_edge[b] = (eid, p)
            child_vals = await self._current_values(s, graph_id, branch_id, list(cont_edge), as_of_seq)
            live = [(eid, p) for eid, p in child_vals.items()
                    if p is not None and not _is_edge_payload(p)]
            live.sort(key=lambda kv: ((kv[1].get("displayName") or ""), kv[0]))
            total = len(live)
            page = live[offset: offset + limit]
            page_ids = {eid for eid, _ in page}

            lineage: List[Tuple[str, dict]] = []
            child_cc: Dict[str, int] = {}
            if page_ids and (include_lineage_edges or include_child_count):
                scope = page_ids | {parent}
                # One incident scan over the page serves both the lineage edges and each child's
                # OUT-containment count (so an expanded child shows its own chevron) — no extra query.
                for eid, p in (await self._incident_live_edges(s, graph_id, branch_id, page_ids, as_of_seq)).items():
                    et = (p.get("edgeType") or "").upper()
                    a, b = _edge_src_tgt(p)
                    if et in cset:
                        if include_child_count and a in page_ids:
                            child_cc[a] = child_cc.get(a, 0) + 1
                        continue
                    if include_lineage_edges and (lset is None or et in lset) and a in scope and b in scope:
                        lineage.append((eid, p))

            need = page_ids | {parent}
            for _, p in lineage:
                a, b = _edge_src_tgt(p)
                need.update((a, b))
            node_vals = await self._current_values(s, graph_id, branch_id, need, as_of_seq)

        urn_of = {
            eid: ((p.get("urn") if (p is not None and not _is_edge_payload(p)) else None) or f"gv:{eid}")
            for eid, p in node_vals.items()
        }
        children_out = [_graphnode_dict(eid, urn_of.get(eid, f"gv:{eid}"), p) for eid, p in page]
        if include_child_count:
            for nd in children_out:
                _set_child_count(nd, child_cc.get(nd["entityId"], 0))
        cont_out = [_graphedge_dict(cont_edge[eid][0], cont_edge[eid][1], urn_of) for eid, _ in page]
        lin_out = [_graphedge_dict(eid, p, urn_of) for eid, p in lineage]
        has_more = offset + len(page) < total
        return {
            "children": children_out,
            "containmentEdges": cont_out,
            "lineageEdges": lin_out,
            "totalChildren": total,
            "hasMore": has_more,
            "nextCursor": (children_out[-1]["displayName"] if (children_out and has_more) else None),
        }

    async def top_level_from_state(
        self, *, graph_id: str, containment_edge_types: Sequence[str],
        root_entity_types: Optional[Sequence[str]] = None,
        branch_id: Optional[str] = None, as_of_seq: Optional[int] = None,
        entity_types: Optional[Sequence[str]] = None, search_query: Optional[str] = None,
        limit: int = 100, cursor: Optional[str] = None, include_child_count: bool = True,
    ) -> Dict[str, object]:
        """Branch/as-of-aware top-level/orphan read — the draft/as-of counterpart of the
        provider's ``get_top_level_or_orphan_nodes``. A node is "top-level" iff no live edge of
        a containment type points *at* it (root instances ∪ orphans of non-root types). Bounded:
        discover candidate ids from the shared base ∪ the draft overlay (capped), then one
        incident-edge scan over the candidates (bounded by their degree) classifies each and,
        optionally, counts its OUT containment children. Keyset-paginated by displayName; mirrors
        TopLevelNodesResult. Best-effort for very large sets — the hot path is ``main`` via FalkorDB."""
        cset = {t.upper() for t in (containment_edge_types or [])}
        rset = {str(t) for t in (root_entity_types or [])}
        type_set = set(entity_types) if entity_types else None
        q = (search_query or "").strip().lower()

        def matches(p: dict) -> bool:
            if type_set is not None and p.get("entityType") not in type_set:
                return False
            if q:
                hay = " ".join(str(p.get(k) or "")
                               for k in ("displayName", "qualifiedName", "urn")).lower()
                if q not in hay:
                    return False
            return True

        def where(c):
            preds = []
            if type_set is not None:
                preds.append(c.entity_type.in_(list(type_set)))
            if q:
                like = f"%{q}%"
                preds.append(or_(func.lower(c.display_name).like(like),
                                 func.lower(c.qualified_name).like(like),
                                 func.lower(c.urn).like(like)))
            return preds

        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            base_seq, overlay_seq = await self._branch_read_seqs(
                s, graph_id, branch_id, main_id, as_of_seq)
            overlay_ids: List[str] = []
            if overlay_seq is not None:
                overlay_ids = list((await s.execute(
                    select(NodeVersionORM.entity_id).where(
                        NodeVersionORM.graph_id == graph_id,
                        NodeVersionORM.branch_id == branch_id,
                        NodeVersionORM.commit_seq <= overlay_seq,
                    ).distinct()
                )).scalars().all())
            # Over-fetch: the incoming-containment filter prunes after discovery.
            window = (limit * 4) + len(overlay_ids) + 1
            cand = set(await self._latest_live_ids(
                s, NodeVersionORM, graph_id, main_id, base_seq, where=where, limit=window))
            cand.update(overlay_ids)
            vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
            nodes = {eid: p for eid, p in vals.items()
                     if p is not None and not _is_edge_payload(p) and matches(p)}
            inc = await self._incident_live_edges(s, graph_id, branch_id, set(nodes), as_of_seq)
            has_incoming_cont: set = set()
            child_count: Dict[str, int] = {}
            for eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)
                if b in nodes:
                    has_incoming_cont.add(b)
                if include_child_count and a in nodes:
                    child_count[a] = child_count.get(a, 0) + 1
            top = [(eid, p) for eid, p in nodes.items() if eid not in has_incoming_cont]

        top.sort(key=lambda kv: ((kv[1].get("displayName") or ""), kv[0]))
        total = len(top)
        after = [kv for kv in top if (kv[1].get("displayName") or "") > cursor] if cursor else top
        page = after[:limit]
        has_more = len(after) > limit
        out_nodes: List[dict] = []
        root_count = 0
        orphan_count = 0
        for eid, p in page:
            nd = _graphnode_dict(eid, p.get("urn") or f"gv:{eid}", p)
            if include_child_count:
                _set_child_count(nd, child_count.get(eid, 0))
            out_nodes.append(nd)
            if rset and p.get("entityType") in rset:
                root_count += 1
            else:
                orphan_count += 1
        return {
            "nodes": out_nodes,
            "totalCount": total,
            "hasMore": has_more,
            "nextCursor": (out_nodes[-1]["displayName"] if (out_nodes and has_more) else None),
            "rootTypeCount": root_count,
            "orphanCount": orphan_count,
        }

    async def _containment_ancestors(
        self, s, graph_id: str, branch_id: str, node_ids: set,
        cset: set, as_of_seq: Optional[int], max_climb: int = 64,
    ) -> Tuple[set, Dict[str, dict]]:
        """Climb live IN containment edges from *node_ids* to their roots — bounded by the
        hierarchy depth. Returns (all node ids incl. inputs + ancestors, {edge_id: payload})."""
        seen = set(node_ids)
        edges: Dict[str, dict] = {}
        frontier = set(node_ids)
        for _ in range(max_climb):
            if not frontier:
                break
            inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
            nxt: set = set()
            for eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)   # a = parent (source), b = child (target)
                if b in frontier and a:
                    edges[eid] = p
                    if a not in seen:
                        seen.add(a)
                        nxt.add(a)
            frontier = nxt
        return seen, edges

    async def _containment_descendants(
        self, s, graph_id: str, branch_id: str, root_ids: set,
        cset: set, as_of_seq: Optional[int], cap: int, max_depth: int = 64,
    ) -> set:
        """Walk live OUT containment edges down from *root_ids* — the subtree, bounded by ``cap``."""
        seen = set(root_ids)
        frontier = set(root_ids)
        for _ in range(max_depth):
            if not frontier or len(seen) >= cap:
                break
            inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
            nxt: set = set()
            for eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)   # a = parent (source), b = child (target)
                if a in frontier and b and b not in seen:
                    if len(seen) >= cap:
                        break
                    seen.add(b)
                    nxt.add(b)
            frontier = nxt
        return seen

    async def trace_from_state(
        self, *, graph_id: str, urn: str, level: int,
        upstream_depth: int, downstream_depth: int,
        lineage_edge_types: Sequence[str], containment_edge_types: Sequence[str],
        max_nodes: int, branch_id: Optional[str] = None, as_of_seq: Optional[int] = None,
        include_containment_edges: bool = True,
    ) -> Dict[str, object]:
        """Branch/as-of-aware RAW lineage trace — the draft/as-of counterpart of the provider's
        ``trace_at_level``. A bounded hop-by-hop BFS over lineage edges (upstream follows IN,
        downstream follows OUT), capped at ``max_nodes``; then every result node's containment
        ancestor chain is added so the canvas layer-assignment invariant holds. RAW only — a draft
        has no AGGREGATED rollups (those are FalkorDB-only), so ``level`` is informational and
        ``effectiveLevel`` echoes it. Mirrors TraceResult."""
        lset = {t.upper() for t in lineage_edge_types} if lineage_edge_types else None
        cset = {t.upper() for t in (containment_edge_types or [])}
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            focus = await self._eid_for_urn(s, graph_id, branch_id, urn, as_of_seq)
            if focus is None:
                return {
                    "nodes": [], "edges": [], "containmentEdges": [],
                    "upstreamUrns": [], "downstreamUrns": [],
                    "focus": {"urn": urn, "level": level, "entityType": "unknown"},
                    "effectiveLevel": level, "truncated": False, "truncationReason": "orphan",
                }
            seen_nodes = {focus}
            lineage_edges: Dict[str, dict] = {}
            upstream_ids: set = set()
            downstream_ids: set = set()
            truncated = False

            async def _bfs(direction: str, depth: int, collected: set):
                nonlocal truncated
                frontier = {focus}
                for _ in range(max(0, depth)):
                    if not frontier or len(seen_nodes) >= max_nodes:
                        truncated = truncated or len(seen_nodes) >= max_nodes
                        break
                    inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
                    nxt: set = set()
                    for eid, p in inc.items():
                        et = (p.get("edgeType") or "").upper()
                        if et in cset or (lset is not None and et not in lset):
                            continue
                        src, tgt = _edge_src_tgt(p)
                        hit = tgt if (direction == "down" and src in frontier) else (
                            src if (direction == "up" and tgt in frontier) else None)
                        if not hit:
                            continue
                        lineage_edges[eid] = p
                        if hit not in seen_nodes:
                            if len(seen_nodes) >= max_nodes:
                                truncated = True
                                continue
                            seen_nodes.add(hit)
                            collected.add(hit)
                            nxt.add(hit)
                    frontier = nxt

            await _bfs("up", upstream_depth, upstream_ids)
            await _bfs("down", downstream_depth, downstream_ids)

            cont_edges: Dict[str, dict] = {}
            if include_containment_edges and cset:
                seen_nodes, cont_edges = await self._containment_ancestors(
                    s, graph_id, branch_id, set(seen_nodes), cset, as_of_seq)
            node_vals = await self._current_values(s, graph_id, branch_id, seen_nodes, as_of_seq)

        nodes = {eid: p for eid, p in node_vals.items() if p is not None and not _is_edge_payload(p)}
        urn_of = {eid: (p.get("urn") or f"gv:{eid}") for eid, p in nodes.items()}
        out_nodes = [_graphnode_dict(eid, urn_of[eid], nodes[eid]) for eid in nodes]
        out_lineage = [_graphedge_dict(eid, p, urn_of) for eid, p in lineage_edges.items()
                       if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes]
        out_cont = [_graphedge_dict(eid, p, urn_of) for eid, p in cont_edges.items()
                    if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes]
        focus_type = (nodes.get(focus) or {}).get("entityType") or "unknown"
        return {
            "nodes": out_nodes,
            "edges": out_lineage,
            "containmentEdges": out_cont,
            "upstreamUrns": [urn_of[e] for e in upstream_ids if e in nodes],
            "downstreamUrns": [urn_of[e] for e in downstream_ids if e in nodes],
            "focus": {"urn": urn, "level": level, "entityType": focus_type},
            "effectiveLevel": level,
            "truncated": truncated,
            "truncationReason": ("max_nodes" if truncated else None),
        }

    async def expand_from_state(
        self, *, graph_id: str, source_urn: str, target_urn: str, next_level: int,
        lineage_edge_types: Sequence[str], containment_edge_types: Sequence[str],
        max_nodes: int, branch_id: Optional[str] = None, as_of_seq: Optional[int] = None,
        include_containment_edges: bool = True,
    ) -> Dict[str, object]:
        """Branch/as-of-aware RAW expand — the draft/as-of counterpart of the provider's
        ``expand_aggregated``. A draft carries only RAW lineage, so this returns the raw lineage
        edges from the source anchor's containment subtree to the target anchor's subtree (bounded
        by ``max_nodes``), plus the ancestor chains for the canvas invariant. ``next_level`` is
        informational (no level rollup on a draft). Mirrors TraceResult, focused on the source."""
        lset = {t.upper() for t in lineage_edge_types} if lineage_edge_types else None
        cset = {t.upper() for t in (containment_edge_types or [])}
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            src = await self._eid_for_urn(s, graph_id, branch_id, source_urn, as_of_seq)
            tgt = await self._eid_for_urn(s, graph_id, branch_id, target_urn, as_of_seq)
            if src is None or tgt is None:
                return {
                    "nodes": [], "edges": [], "containmentEdges": [],
                    "upstreamUrns": [], "downstreamUrns": [],
                    "focus": {"urn": source_urn, "level": next_level, "entityType": "unknown"},
                    "effectiveLevel": next_level, "truncated": False, "truncationReason": "orphan",
                }
            src_sub = await self._containment_descendants(
                s, graph_id, branch_id, {src}, cset, as_of_seq, max_nodes) if cset else {src}
            tgt_sub = await self._containment_descendants(
                s, graph_id, branch_id, {tgt}, cset, as_of_seq, max_nodes) if cset else {tgt}
            lineage_edges: Dict[str, dict] = {}
            result_nodes: set = set()
            for eid, p in (await self._incident_live_edges(
                    s, graph_id, branch_id, src_sub, as_of_seq)).items():
                et = (p.get("edgeType") or "").upper()
                if et in cset or (lset is not None and et not in lset):
                    continue
                a, b = _edge_src_tgt(p)
                if a in src_sub and b in tgt_sub:
                    lineage_edges[eid] = p
                    result_nodes.add(a)
                    result_nodes.add(b)
            truncated = len(result_nodes) >= max_nodes
            cont_edges: Dict[str, dict] = {}
            if include_containment_edges and cset and result_nodes:
                result_nodes, cont_edges = await self._containment_ancestors(
                    s, graph_id, branch_id, set(result_nodes), cset, as_of_seq)
            node_vals = await self._current_values(s, graph_id, branch_id, result_nodes, as_of_seq)

        nodes = {eid: p for eid, p in node_vals.items() if p is not None and not _is_edge_payload(p)}
        urn_of = {eid: (p.get("urn") or f"gv:{eid}") for eid, p in nodes.items()}
        out_nodes = [_graphnode_dict(eid, urn_of[eid], nodes[eid]) for eid in nodes]
        out_lineage = [_graphedge_dict(eid, p, urn_of) for eid, p in lineage_edges.items()
                       if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes]
        out_cont = [_graphedge_dict(eid, p, urn_of) for eid, p in cont_edges.items()
                    if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes]
        focus_type = (nodes.get(src) or {}).get("entityType") or "unknown"
        return {
            "nodes": out_nodes,
            "edges": out_lineage,
            "containmentEdges": out_cont,
            "upstreamUrns": [],
            "downstreamUrns": [urn_of[e] for e in (result_nodes - {src}) if e in nodes],
            "focus": {"urn": source_urn, "level": next_level, "entityType": focus_type},
            "effectiveLevel": next_level,
            "truncated": truncated,
            "truncationReason": ("max_nodes" if truncated else None),
        }

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

    @staticmethod
    def _commit_meta(c: "CommitORM") -> dict:
        return {
            "commit_id": c.id, "commit_seq": c.commit_seq,
            "parent_commit_id": c.parent_commit_id, "kind": c.kind,
            "message": c.message, "actor": c.actor, "contributors": c.contributors,
            "source_branch_id": c.source_branch_id,
            "source_commit_count": c.source_commit_count,
            "originating_view_id": c.originating_view_id,
            "merkle_root": c.merkle_root, "stats": c.stats, "created_at": c.created_at,
        }

    async def commit_log(
        self, *, graph_id: str, branch_id: Optional[str] = None,
        originating_view_id: Optional[str] = None, limit: int = 100, offset: int = 0,
    ) -> List[dict]:
        """Newest-first commit log for a graph (plan §7). Default: a branch (``main`` if
        unset). When ``originating_view_id`` is given, scope to commits attributed to that
        view across branches instead (the view's change history). A fork's log holds only its
        own divergence — inherited history lives on the parent."""
        async with self._session() as s:
            stmt = select(CommitORM).where(CommitORM.graph_id == graph_id)
            if originating_view_id is not None:
                stmt = stmt.where(CommitORM.originating_view_id == originating_view_id)
            else:
                if branch_id is None:
                    branch_id = await self._main_branch_id(s, graph_id)
                stmt = stmt.where(CommitORM.branch_id == branch_id)
            rows = (await s.execute(
                stmt.order_by(CommitORM.commit_seq.desc()).limit(limit).offset(offset)
            )).scalars().all()
            return [self._commit_meta(r) for r in rows]
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

    async def diff_branch_vs_base(self, *, graph_id: str, branch_id: str) -> Dict[str, object]:
        """UI-shaped net diff of a draft against its base (``main`` at the branch
        point): full node/edge payloads with before/after, classified
        added/removed/modified. This is the shape the canvas diff overlay needs —
        a removed entity renders as a ghost, so it carries its whole payload, not
        just an id.

        Unlike :meth:`diff_commits` (two seqs on one branch), this is a *cross-branch*
        diff: a draft numbers its commits in its own seq space, so the change set is
        the entities the draft wrote rows for (bounded by draft size). ``before`` is
        each entity's value on ``main`` at the branch point; ``after`` its effective
        value on the draft (base overlaid with the draft's edits)."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            main_id = await self._main_branch_id(s, graph_id)
            base_seq = branch.base_commit_seq or 0
            changed: set = set()
            for model in (NodeVersionORM, EdgeVersionORM):
                rows = (await s.execute(
                    select(model.entity_id).where(
                        model.graph_id == graph_id, model.branch_id == branch_id,
                    ).distinct()
                )).scalars().all()
                changed.update(rows)
            if not changed:
                return {"added": [], "removed": [], "modified": []}
            before = await self._values_at(s, graph_id, main_id, changed, base_seq)
            after = await self._current_values(s, graph_id, branch_id, list(changed))
        added: List[dict] = []
        removed: List[dict] = []
        modified: List[dict] = []
        for eid in changed:
            b, a = before.get(eid), after.get(eid)
            if b is None and a is None:
                continue
            kind = "edge" if _is_edge_payload(a or b or {}) else "node"
            if b is None:
                added.append({"entityId": eid, "kind": kind, "after": a})
            elif a is None:
                removed.append({"entityId": eid, "kind": kind, "before": b})
            elif b != a:
                modified.append({"entityId": eid, "kind": kind, "before": b, "after": a})
        return {"added": added, "removed": removed, "modified": modified}

    async def diff_branch_summary(
        self, *, graph_id: str, branch_id: str, containment_edge_types, limit: int = 200,
    ) -> Dict[str, object]:
        """Hierarchical counterpart of :meth:`diff_branch_vs_base` — the draft's changes as a
        containment tree for the canvas Changes panel. Built on the same O(draft) change set,
        augmented with the *unchanged* containment ancestors of the changed nodes so edits nest
        under their real container (a column under its table) without composing full state."""
        async with self._session() as s:
            merged, theirs = await self._branch_diff_states(
                s, graph_id, branch_id, containment_edge_types)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_summary_view(index, limit)

    async def diff_branch_children(
        self, *, graph_id: str, branch_id: str, container_key: str, containment_edge_types,
        limit: int = 200, offset: int = 0,
    ) -> Dict[str, object]:
        """One container's direct children in a draft's hierarchical diff (lazy-load step)."""
        async with self._session() as s:
            merged, theirs = await self._branch_diff_states(
                s, graph_id, branch_id, containment_edge_types)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_children_view(index, container_key, limit, offset)

    async def diff_commit_summary(
        self, *, graph_id: str, commit_id: str, containment_edge_types, limit: int = 200,
    ) -> Dict[str, object]:
        """Hierarchical summary of ONE commit's changes — the History tab's drill-down. Same
        containment tree as the draft/PR diff, scoped to exactly the rows this commit wrote; the
        global counts equal the flat ``diff_commits`` tally for the commit's window."""
        async with self._session() as s:
            merged, theirs = await self._commit_diff_states(s, graph_id, commit_id, containment_edge_types)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_summary_view(index, limit)

    async def diff_commit_children(
        self, *, graph_id: str, commit_id: str, container_key: str, containment_edge_types,
        limit: int = 200, offset: int = 0,
    ) -> Dict[str, object]:
        """One container's direct children in a commit's hierarchical diff (lazy-load step)."""
        async with self._session() as s:
            merged, theirs = await self._commit_diff_states(s, graph_id, commit_id, containment_edge_types)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_children_view(index, container_key, limit, offset)

    async def _branch_diff_states(self, s, graph_id, branch_id, containment_edge_types):
        """``(merged, theirs)`` for a draft restricted to its own changes PLUS the unchanged
        containment skeleton (ancestor nodes + the containment edges linking them) of the
        changed nodes. The skeleton is added identically to both sides, so ``net_delta`` still
        yields exactly the draft's changes — the extra entries only give the hierarchy real
        containers to nest under. Stays O(draft + ancestors): no full-state composition."""
        branch = await self._get_branch(s, graph_id, branch_id)
        main_id = await self._main_branch_id(s, graph_id)
        base_seq = branch.base_commit_seq or 0
        changed: set = set()
        for model in (NodeVersionORM, EdgeVersionORM):
            rows = (await s.execute(
                select(model.entity_id).where(
                    model.graph_id == graph_id, model.branch_id == branch_id,
                ).distinct()
            )).scalars().all()
            changed.update(rows)
        if not changed:
            return {}, {}
        before = await self._values_at(s, graph_id, main_id, changed, base_seq)
        after = await self._current_values(s, graph_id, branch_id, list(changed))
        theirs: Dict[str, Optional[dict]] = {eid: before.get(eid) for eid in changed}
        merged: Dict[str, Optional[dict]] = {eid: after.get(eid) for eid in changed}
        cset = {t.upper() for t in (containment_edge_types or [])}
        await self._augment_containment_skeleton(
            s, graph_id, branch_id, changed, after, theirs, merged, cset)
        return merged, theirs

    async def _augment_containment_skeleton(
        self, s, graph_id, branch_id, changed, after, theirs, merged, cset,
    ):
        """Add the *unchanged* containment skeleton (ancestor nodes + the containment edges linking
        them) of the changed nodes to BOTH ``theirs`` and ``merged`` identically — so ``net_delta``
        still yields exactly the changes, while the hierarchy gets real containers to nest under.
        Shared by the draft and per-commit diff paths so they can't drift. Resolved at branch head
        (containment is stable); mutates ``theirs``/``merged`` in place; no-op when ``cset`` empty."""
        if not cset:
            return
        skel_nodes, skel_edges = await self._containment_skeleton(
            s, graph_id, branch_id, changed, after, cset)
        for eid, p in {**skel_edges, **skel_nodes}.items():
            if eid not in changed:                 # add only the unchanged structure
                theirs[eid] = p
                merged[eid] = p
        # Label any container referenced by a containment edge but not yet present — e.g. the
        # surviving parent of a deleted subtree (the skeleton walk seeds from live nodes only, so
        # it never reaches it). Bounded: one lookup of the missing parents.
        referenced: set = set()
        for p in theirs.values():
            if p and _is_edge_payload(p) and (p.get("edgeType") or "").upper() in cset:
                src = p.get("sourceEntityId") or p.get("source_entity_id")
                if src:
                    referenced.add(src)
        missing = referenced - merged.keys()
        if missing:
            for eid, p in (await self._current_values(s, graph_id, branch_id, missing)).items():
                if p is not None:
                    theirs[eid] = p
                    merged[eid] = p

    async def _commit_diff_states(self, s, graph_id, commit_id, containment_edge_types):
        """``(merged, theirs)`` for a single commit — exactly the rows it wrote (the
        ``(seq-1, seq]`` window). before/after are resolved with the SAME primitives as
        :meth:`diff_commits` (``_values_at`` + the fork copy-on-write 'before' fallback), so a
        commit's hierarchical summary counts equal the flat ``diff_commits`` tally for every kind
        of commit; the containment skeleton (resolved at branch head) gives the changes their
        containers to nest under."""
        commit = await s.get(CommitORM, (graph_id, commit_id))
        if commit is None:
            raise ValueError(f"unknown commit {commit_id}")
        branch_id, seq = commit.branch_id, commit.commit_seq
        changed = await self._changed_in_window(s, graph_id, branch_id, seq - 1, seq)
        if not changed:
            return {}, {}
        before = await self._values_at(s, graph_id, branch_id, changed, seq - 1)
        after = await self._values_at(s, graph_id, branch_id, changed, seq)
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            for eid in changed:                    # fork CoW: inherited 'before' value
                if eid not in before:
                    v = await self._entity_value_at(s, graph_id, branch_id, eid, seq - 1)
                    if v is not None:
                        before[eid] = v
        theirs: Dict[str, Optional[dict]] = {eid: before.get(eid) for eid in changed}
        merged: Dict[str, Optional[dict]] = {eid: after.get(eid) for eid in changed}
        cset = {t.upper() for t in (containment_edge_types or [])}
        await self._augment_containment_skeleton(
            s, graph_id, branch_id, changed, after, theirs, merged, cset)
        return merged, theirs

    async def _containment_skeleton(self, s, graph_id, branch_id, changed, changed_after, cset):
        """Walk UP from the changed *live* nodes to their roots via incoming containment edges,
        returning ``({node_eid: payload}, {edge_eid: payload})`` for the unchanged structure
        linking changes to their containers. Bounded by (changed nodes × containment depth)."""
        skel_nodes: Dict[str, dict] = {}
        skel_edges: Dict[str, dict] = {}
        frontier = {
            eid for eid in changed
            if changed_after.get(eid) is not None and not _is_edge_payload(changed_after.get(eid) or {})
        }
        seen = set(frontier)
        depth = 0
        while frontier and depth < 64:
            links = await self._incoming_containment_edges(s, graph_id, branch_id, frontier, cset)
            to_fetch: set = set()
            next_frontier: set = set()
            for _child, (edge_eid, parent_eid, edge_p) in links.items():
                skel_edges.setdefault(edge_eid, edge_p)
                if parent_eid not in seen:
                    seen.add(parent_eid)
                    next_frontier.add(parent_eid)
                    if parent_eid not in changed:
                        to_fetch.add(parent_eid)
            if to_fetch:
                vals = await self._current_values(s, graph_id, branch_id, to_fetch)
                for eid, p in vals.items():
                    if p is not None:
                        skel_nodes[eid] = p
            frontier = next_frontier
            depth += 1
        return skel_nodes, skel_edges

    async def _incoming_containment_edges(self, s, graph_id, branch_id, child_ids, cset):
        """Live containment edges whose TARGET is in *child_ids* →
        ``{child_eid: (edge_eid, parent_eid, payload)}`` — the child→parent step of the
        upward walk, bounded by ``|child_ids|`` (≈ one parent each) via ix_ev_target."""
        ids = list(child_ids)
        if not ids:
            return {}
        cand: set = set()
        for chunk in _chunks(ids, _IN_LIST_MAX):
            rows = (await s.execute(
                select(EdgeVersionORM.entity_id).where(
                    EdgeVersionORM.graph_id == graph_id,
                    EdgeVersionORM.target_entity_id.in_(chunk),
                ).distinct()
            )).scalars().all()
            cand.update(rows)
        vals = await self._current_values(s, graph_id, branch_id, cand)
        out: Dict[str, Tuple[str, str, dict]] = {}
        child_set = set(child_ids)
        for eid, p in vals.items():
            if p is None or not _is_edge_payload(p):
                continue
            if (p.get("edgeType") or "").upper() not in cset:
                continue
            src = p.get("sourceEntityId") or p.get("source_entity_id")
            tgt = p.get("targetEntityId") or p.get("target_entity_id")
            if src and tgt and tgt in child_set:
                out[tgt] = (eid, src, p)
        return out

    async def get_graph(self, graph_id: str) -> Optional[Dict[str, object]]:
        """Graph metadata (or ``None``) — also the API's tenant-isolation guard."""
        async with self._session() as s:
            g = await s.get(GraphORM, graph_id)
            return None if g is None else self._graph_meta(g)

    async def get_graph_by_data_source(self, data_source_id: str) -> Optional[Dict[str, object]]:
        """Reverse lookup: the versioned graph backing a data source (1:1 via the
        ``uq_graphs_data_source`` unique constraint), or ``None``."""
        async with self._session() as s:
            g = (await s.execute(
                select(GraphORM).where(GraphORM.data_source_id == data_source_id)
            )).scalar_one_or_none()
            return None if g is None else self._graph_meta(g)

    @staticmethod
    def _draft_ref(b: BranchORM) -> dict:
        return {"branch_id": b.id, "head_commit_id": b.head_commit_id,
                "base_commit_seq": b.base_commit_seq}

    async def resolve_graph(
        self, *, data_source_id: str, actor: str, workspace_id: Optional[str] = None,
        open_draft_if_absent: bool = True, originating_view_id: Optional[str] = None,
    ) -> Optional[Dict[str, object]]:
        """Resolve a data source to its versioned graph plus the caller's editing
        draft — the UI's boot lookup. Returns the graph's ``main`` head and the
        actor's newest open draft (opening one when absent if requested), or ``None``
        when no versioned graph backs the data source (optionally scoped to a
        workspace for tenant isolation)."""
        async with self._session() as s:
            g = (await s.execute(
                select(GraphORM).where(GraphORM.data_source_id == data_source_id)
            )).scalar_one_or_none()
            if g is None or (workspace_id is not None and g.workspace_id != workspace_id):
                return None
            graph_id, main_head = g.id, g.main_head_commit_seq
            main_id = await self._main_branch_id(s, graph_id)
            draft = (await s.execute(
                select(BranchORM).where(
                    BranchORM.graph_id == graph_id, BranchORM.owner == actor,
                    BranchORM.kind == "draft", BranchORM.status == "open",
                ).order_by(BranchORM.created_at.desc())
            )).scalars().first()
            my_draft = self._draft_ref(draft) if draft is not None else None
        if my_draft is None and open_draft_if_absent:
            branch_id = await self.open_draft(
                graph_id=graph_id, owner=actor, originating_view_id=originating_view_id)
            async with self._session() as s:
                my_draft = self._draft_ref(await s.get(BranchORM, branch_id))
        return {
            "graph_id": graph_id, "main_branch_id": main_id,
            "main_head_commit_seq": main_head, "my_draft": my_draft,
        }

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

    @staticmethod
    def _pulls_filtered(stmt, *, target_graph_id, data_source_id, originating_view_id,
                        status, active_only):
        """Apply the optional PR scope filters shared by :meth:`list_pulls`/:meth:`count_pulls`.
        ``data_source_id`` joins the target graph (all PRs on a data source & its views);
        ``originating_view_id`` joins the source branch (PRs raised from one view) — both stay
        within the versioning store, so the join is local. ``active_only`` drops the terminal
        (merged/closed) PRs — the "still needs attention" set the indicator counts."""
        if data_source_id is not None:
            stmt = stmt.join(GraphORM, GraphORM.id == MergeRequestORM.target_graph_id).where(
                GraphORM.data_source_id == data_source_id)
        if target_graph_id is not None:
            stmt = stmt.where(MergeRequestORM.target_graph_id == target_graph_id)
        if originating_view_id is not None:
            stmt = stmt.join(BranchORM, BranchORM.id == MergeRequestORM.source_branch_id).where(
                BranchORM.originating_view_id == originating_view_id)
        if status is not None:
            stmt = stmt.where(MergeRequestORM.status == status)
        if active_only:
            stmt = stmt.where(MergeRequestORM.status.notin_(_TERMINAL_PR_STATUS))
        return stmt

    async def list_pulls(
        self, *, target_graph_id: Optional[str] = None, data_source_id: Optional[str] = None,
        originating_view_id: Optional[str] = None, status: Optional[str] = None,
        active_only: bool = False, limit: int = 100, offset: int = 0,
    ) -> List[dict]:
        """PRs in scope, newest first. Scope is any combination of: a target graph's ``main``
        (the base owner's review queue), a data source (every view's PRs against it), or a
        single originating view — optionally narrowed to one ``status`` or to ``active_only``
        (not merged/closed)."""
        async with self._session() as s:
            stmt = self._pulls_filtered(
                select(MergeRequestORM), target_graph_id=target_graph_id,
                data_source_id=data_source_id, originating_view_id=originating_view_id,
                status=status, active_only=active_only,
            ).order_by(MergeRequestORM.created_at.desc()).limit(limit).offset(offset)
            rows = (await s.execute(stmt)).scalars().all()
            return [self._pr_meta(pr) for pr in rows]

    async def count_pulls(
        self, *, target_graph_id: Optional[str] = None, data_source_id: Optional[str] = None,
        originating_view_id: Optional[str] = None, status: Optional[str] = None,
        active_only: bool = False,
    ) -> int:
        """Count PRs matching the same scope filters as :meth:`list_pulls` — for the view's
        PR indicator (active PRs from this view vs on its whole data source)."""
        async with self._session() as s:
            stmt = self._pulls_filtered(
                select(func.count(MergeRequestORM.id)), target_graph_id=target_graph_id,
                data_source_id=data_source_id, originating_view_id=originating_view_id,
                status=status, active_only=active_only,
            )
            return int((await s.execute(stmt)).scalar_one())

    @staticmethod
    def _graph_meta(g: GraphORM) -> Dict[str, object]:
        return {
            "graph_id": g.id, "workspace_id": g.workspace_id, "tenant_id": g.tenant_id,
            "data_source_id": g.data_source_id,
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
            "pr_id": pr.id, "graph_id": pr.graph_id, "source_graph_id": pr.source_graph_id,
            "source_branch_id": pr.source_branch_id,
            "target_graph_id": pr.target_graph_id, "target_branch": pr.target_branch,
            "base_commit_seq": pr.base_commit_seq, "status": pr.status,
            "title": pr.title, "description": pr.description,
            "conflicts": pr.conflicts, "resulting_commit_id": pr.resulting_commit_id,
            "reviewers": pr.reviewers, "approved_by": pr.approved_by,
            "approval_status": pr.approval_status, "checks_status": pr.checks_status,
            "actor": pr.actor, "created_at": pr.created_at, "updated_at": pr.updated_at,
            "merged_at": pr.merged_at, "merged_by": pr.merged_by,
            "closed_at": pr.closed_at, "closed_by": pr.closed_by,
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

    async def _get_branch(self, s, graph_id: str, branch_id: str) -> BranchORM:
        b = await s.get(BranchORM, branch_id)
        if b is None or b.graph_id != graph_id:
            raise ValueError("unknown branch")
        return b

    async def _branch_role(self, s, branch: BranchORM, actor: str, groups: Sequence[str] = ()):
        """Effective role of *actor* on *branch*: the owner is an implicit
        maintainer; otherwise the highest role from matching user/group members
        (group resolution depends on the caller supplying ``groups``)."""
        if branch.owner == actor:
            return "maintainer"
        rows = (await s.execute(select(BranchMemberORM).where(
            BranchMemberORM.branch_id == branch.id
        ))).scalars().all()
        best = None
        for r in rows:
            if (r.subject_type == "user" and r.subject_id == actor) or \
               (r.subject_type == "group" and r.subject_id in groups):
                if best is None or ROLE_RANK[r.role] > ROLE_RANK[best]:
                    best = r.role
        return best

    @staticmethod
    def _require_open(branch: BranchORM) -> None:
        """Edits/checkpoints/publish need an ``open`` draft. Merged or abandoned
        drafts are inert (plan §17 #8); ``main`` stays open for its lifetime."""
        if branch.status != "open":
            raise ValueError(f"branch {branch.id} is {branch.status}")

    async def _require_edit(self, s, branch: BranchORM, actor: str, groups: Sequence[str]) -> None:
        if not branch.is_shared:                          # private draft → workspace RBAC governs
            return
        role = await self._branch_role(s, branch, actor, groups)
        if role is None or ROLE_RANK[role] < ROLE_RANK["editor"]:
            raise AccessDenied(f"{actor} lacks editor access to draft {branch.id}")

    async def _require_manage(self, s, branch: BranchORM, actor: str, groups: Sequence[str]) -> None:
        role = await self._branch_role(s, branch, actor, groups)
        if role != "maintainer":
            raise AccessDenied(f"{actor} lacks maintainer access to draft {branch.id}")

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

    async def _composed_state_as_of(
        self, s, graph_id: str, branch_id: str, as_of_seq: int
    ) -> Dict[str, Optional[dict]]:
        """As-of analogue of :meth:`_composed_state` — branch state at
        ``commit_seq <= as_of_seq`` (fork-aware). ``main`` reconstructs at the seq;
        a draft seeds from ``main`` at its branch point (capped at the seq) overlaid
        with the draft's own version rows ≤ the seq."""
        main_id = await self._main_branch_id(s, graph_id)
        if branch_id == main_id:
            return await self._state_as_of(s, graph_id, main_id, as_of_seq)
        branch = await s.get(BranchORM, branch_id)
        base_seq = min(as_of_seq, branch.base_commit_seq or 0)
        base = await self._state_as_of(s, graph_id, main_id, base_seq)
        base.update(await self._state_as_of(s, graph_id, branch_id, as_of_seq))
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

    async def bulk_ingest(
        self, *, graph_id: str, rows, actor: str,
        idempotency_key: Optional[str] = None, message: str = "bulk import",
        session=None,
    ) -> Dict[str, object]:
        """Day-0 / large-delta import (plan §4, §10): validate rows, assign stable
        entity_ids (urn-keyed for idempotent re-sync), and write ONE ``import``
        commit on ``main`` via **chunked bulk inserts** — never row-by-row. Invalid
        rows are skipped and returned in a ``rejected`` report; valid rows still
        land. Idempotent on ``idempotency_key`` (a retry returns the first commit).

        ATOMIC: the whole import (every insert chunk + the Merkle update + the commit
        row) runs in one transaction — any chunk failing rolls the entire commit back,
        so a graph is never left partially seeded. Pass ``session`` to fold this into a
        larger transaction (e.g. create-graph + seed as one unit)."""
        async with self._session_scope(session) as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)

            if idempotency_key:
                prior = await s.scalar(select(CommitORM).where(
                    CommitORM.graph_id == graph_id,
                    CommitORM.idempotency_key == idempotency_key,
                ))
                if prior is not None:
                    st = prior.stats or {}
                    return {"commit_id": prior.id, "commit_seq": prior.commit_seq,
                            "ingested": st.get("nodes", 0) + st.get("edges", 0),
                            "rejected": [], "idempotent_replay": True}

            rejected: List[dict] = []
            node_deltas: List[Delta] = []
            edge_src: List[tuple] = []
            urn_to_eid: Dict[str, str] = {}

            for i, row in enumerate(rows):
                kind = (row or {}).get("kind")
                if kind == "node":
                    if not row.get("entityType"):
                        rejected.append({"row": i, "reason": "node missing entityType"})
                        continue
                    eid = row.get("entity_id") or row.get("id") or prefixed_id("ent")
                    payload = {k: v for k, v in row.items() if k not in ("kind", "id", "entity_id")}
                    node_deltas.append(Delta(eid, "create", payload, None, content_hash(payload)))
                    if row.get("urn"):
                        urn_to_eid[row["urn"]] = eid
                    urn_to_eid.setdefault(row.get("id") or eid, eid)
                    urn_to_eid[eid] = eid
                elif kind == "edge":
                    edge_src.append((i, row))
                else:
                    rejected.append({"row": i, "reason": f"unknown kind {kind!r}"})

            edge_deltas: List[Delta] = []
            for i, row in edge_src:
                et, src, tgt = row.get("edgeType"), row.get("source"), row.get("target")
                if not (et and src and tgt):
                    rejected.append({"row": i, "reason": "edge missing edgeType/source/target"})
                    continue
                seid, teid = urn_to_eid.get(src), urn_to_eid.get(tgt)
                if not (seid and teid):
                    rejected.append({"row": i, "reason": "edge endpoint not found"})
                    continue
                eid = row.get("entity_id") or row.get("id") or prefixed_id("ent")
                payload = {"edgeType": et, "sourceEntityId": seid, "targetEntityId": teid,
                           **{k: v for k, v in row.items()
                              if k not in ("kind", "id", "entity_id", "source", "target", "edgeType")}}
                edge_deltas.append(Delta(eid, "create", payload, None, content_hash(payload)))

            deltas = node_deltas + edge_deltas
            if not deltas:
                return {"commit_id": None, "ingested": 0, "rejected": rejected}

            new_seq = graph.main_head_commit_seq + 1
            main = await s.get(BranchORM, main_id)
            commit = CommitORM(
                graph_id=graph_id, branch_id=main_id, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="import", message=message,
                actor=actor, idempotency_key=idempotency_key,
                stats={"nodes": len(node_deltas), "edges": len(edge_deltas)},
            )
            s.add(commit)
            await s.flush()
            await self._bulk_insert_versions(s, graph_id, main_id, commit, node_deltas, edge_deltas, actor)
            main.head_commit_id = commit.id
            graph.main_head_commit_seq = new_seq
            commit.merkle_root = await self._commit_merkle(s, graph_id, main_id, commit, deltas)
            graph.updated_at = _now()
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return {"commit_id": commit.id, "commit_seq": new_seq, "ingested": len(deltas),
                    "nodes": len(node_deltas), "edges": len(edge_deltas), "rejected": rejected}

    async def sync_ingest(
        self, *, graph_id: str, rows, actor: str, source: str = "external",
        idempotency_key: Optional[str] = None, message: str = "external sync",
        strategy: str = "merge", resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        containment_edge_types: Optional[Sequence[str]] = None,
    ) -> Dict[str, object]:
        """Re-sync an authoritative/external snapshot into ``main`` as a single ``sync``
        commit **without clobbering user edits** (plan §D5). 3-way merge: base = the
        previous import/sync snapshot, ours = current main (the user's edits since),
        theirs = the external snapshot. A field both sides changed conflicts under
        ``strategy='merge'`` (resubmit with ``resolutions``) or takes the external value
        under ``strategy='external_wins'``. The snapshot is authoritative: an entity it
        drops is deleted if the user hadn't touched it. Idempotent on ``idempotency_key``."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)

            if idempotency_key:
                prior = await s.scalar(select(CommitORM).where(
                    CommitORM.graph_id == graph_id,
                    CommitORM.idempotency_key == idempotency_key,
                ))
                if prior is not None:
                    st = prior.stats or {}
                    return {"commit_id": prior.id, "commit_seq": prior.commit_seq,
                            "applied": st.get("nodes", 0) + st.get("edges", 0),
                            "rejected": [], "idempotent_replay": True}

            last_seq = await s.scalar(select(CommitORM.commit_seq).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                CommitORM.kind.in_(("import", "sync")),
            ).order_by(CommitORM.commit_seq.desc()).limit(1)) or 0
            base = await self._state_as_of(s, graph_id, main_id, last_seq)
            ours = await self._state_as_of(s, graph_id, main_id, graph.main_head_commit_seq)
            theirs, rejected = self._external_state(rows, ours)

            set_fields = frozenset(config.SET_FIELDS)
            res = dict(resolutions or {})
            merged: Dict[str, Optional[dict]] = {}
            conflicts: List[dict] = []
            for eid in sorted(set(base) | set(ours) | set(theirs)):
                if eid in res:
                    merged[eid] = res[eid]
                    continue
                out = three_way_merge(base.get(eid), ours.get(eid), theirs.get(eid), set_fields)
                if out.conflicts and strategy == "external_wins":
                    merged[eid] = theirs.get(eid)            # external overrides the user edit
                    continue
                merged[eid] = out.merged
                for c in out.conflicts:
                    conflicts.append({
                        "entity_id": eid, "path": list(c.path),
                        "base": c.base, "ours": c.ours, "theirs": c.theirs, "kind": c.kind,
                    })
            if conflicts:
                raise MergeConflict(conflicts)

            self._cascade_containment(merged, containment_edge_types)   # drop orphaned descendants
            self._cascade_incident_edges(merged)                        # then their dangling edges
            self._assert_referential_integrity(merged)
            deltas = net_delta(ours, merged)                 # changes to apply on top of current main
            if not deltas:
                return {"commit_id": None, "commit_seq": graph.main_head_commit_seq,
                        "applied": 0, "rejected": rejected, "idempotent_replay": False}

            kind_by_entity = {eid: ("edge" if _is_edge_payload(p) else "node")
                              for eid, p in ours.items() if p is not None}
            kind_by_entity.update({eid: ("edge" if _is_edge_payload(p) else "node")
                                   for eid, p in merged.items() if p is not None})

            new_seq = graph.main_head_commit_seq + 1
            main = await s.get(BranchORM, main_id)
            commit = CommitORM(
                graph_id=graph_id, branch_id=main_id, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="sync", message=message,
                actor=actor, idempotency_key=idempotency_key, change_reason=source,
            )
            s.add(commit)
            await s.flush()
            await self._write_deltas(s, graph_id, main_id, commit, deltas, kind_by_entity, actor)
            main.head_commit_id = commit.id
            graph.main_head_commit_seq = new_seq
            commit.merkle_root = await self._commit_merkle(s, graph_id, main_id, commit, deltas)
            graph.updated_at = _now()
            commit.stats = _delta_stats(deltas)
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return {"commit_id": commit.id, "commit_seq": new_seq,
                    "applied": len(deltas), "rejected": rejected, "idempotent_replay": False}

    @staticmethod
    def _external_state(rows, ours: Mapping[str, Optional[dict]]):
        """Parse external rows into a desired ``{entity_id: payload}`` state, matching
        each row to an EXISTING main entity so a re-sync updates in place rather than
        duplicating: nodes by ``urn``, edges by ``(source, target, edgeType)``. New
        external entities get a stable id. Returns ``(state, rejected)``."""
        urn_index: Dict[str, str] = {}
        edge_index: Dict[tuple, str] = {}
        for eid, p in ours.items():
            if p is None:
                continue
            if _is_edge_payload(p):
                edge_index[(p.get("sourceEntityId"), p.get("targetEntityId"), p.get("edgeType"))] = eid
            elif p.get("urn"):
                urn_index[p["urn"]] = eid

        theirs: Dict[str, dict] = {}
        rejected: List[dict] = []
        urn_to_eid: Dict[str, str] = {}
        for i, row in enumerate(rows):
            if (row or {}).get("kind") != "node":
                continue
            if not row.get("entityType"):
                rejected.append({"row": i, "reason": "node missing entityType"})
                continue
            urn = row.get("urn")
            eid = (urn_index.get(urn) or row.get("entity_id") or row.get("id")
                   or (f"sync:{urn}" if urn else prefixed_id("ent")))
            payload = {k: v for k, v in row.items() if k not in ("kind", "id", "entity_id")}
            theirs[eid] = payload
            if urn:
                urn_to_eid[urn] = eid
            if row.get("id"):
                urn_to_eid[row["id"]] = eid
            urn_to_eid[eid] = eid

        for i, row in enumerate(rows):
            if (row or {}).get("kind") != "edge":
                continue
            et, src, tgt = row.get("edgeType"), row.get("source"), row.get("target")
            if not (et and src and tgt):
                rejected.append({"row": i, "reason": "edge missing edgeType/source/target"})
                continue
            seid = urn_to_eid.get(src) or urn_index.get(src)
            teid = urn_to_eid.get(tgt) or urn_index.get(tgt)
            if not (seid and teid):
                rejected.append({"row": i, "reason": "edge endpoint not found"})
                continue
            eid = (edge_index.get((seid, teid, et)) or row.get("entity_id")
                   or row.get("id") or f"sync:e:{seid}->{teid}:{et}")
            payload = {"edgeType": et, "sourceEntityId": seid, "targetEntityId": teid,
                       **{k: v for k, v in row.items()
                          if k not in ("kind", "id", "entity_id", "source", "target", "edgeType")}}
            theirs[eid] = payload
        return theirs, rejected

    async def apply_ops(
        self, *, graph_id: str, ops: Sequence[Mapping], actor: str,
        message: str = "edit", branch_id: Optional[str] = None,
        containment_edge_types: Optional[Sequence[str]] = None,
    ) -> Optional[str]:
        """Apply create/update/delete ops as ONE audited commit (default on ``main``) —
        the 'versioned write' primitive behind provider write-through, so an ordinary
        graph write becomes a durable, attributed commit without a draft round-trip.
        Each op is ``{op, entity_kind, entity_id, payload}``. Returns the commit id, or
        ``None`` if the ops are a no-op against current state.

        Cost is **O(ops)**, not O(graph): it resolves only the affected entities' current
        values (``_current_values``), cascades node deletes to their live incident edges
        via a bounded degree query (``_incident_live_edges``), and checks referential
        integrity only for the edges this commit writes — never composing full state.

        Concurrent writers to the same branch race for the next ``commit_seq``; on the
        unique-constraint collision this retries (bounded backoff) before giving up with
        :class:`ConcurrencyError`. Under ``strict`` ontology enforcement the written
        entities are validated (the write-through gate, parity with publish/stage).
        """
        for attempt in range(config.COMMIT_MAX_RETRIES):
            try:
                return await self._apply_ops_once(
                    graph_id=graph_id, ops=ops, actor=actor, message=message, branch_id=branch_id,
                    containment_edge_types=containment_edge_types)
            except IntegrityError:
                if attempt + 1 >= config.COMMIT_MAX_RETRIES:
                    raise ConcurrencyError(
                        f"apply_ops commit-seq contention on {graph_id}/{branch_id or 'main'}")
                await asyncio.sleep(0.02 * (2 ** attempt))

    async def _apply_ops_once(
        self, *, graph_id: str, ops: Sequence[Mapping], actor: str,
        message: str, branch_id: Optional[str],
        containment_edge_types: Optional[Sequence[str]] = None,
    ) -> Optional[str]:
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            bid = branch_id or await self._main_branch_id(s, graph_id)

            # Resolve ops → new payloads for the AFFECTED entities only.
            new_vals: Dict[str, Optional[dict]] = {}
            kind_by_entity: Dict[str, str] = {}
            for op in ops:
                eid = op["entity_id"]
                payload = op.get("payload") or {}
                kind_by_entity[eid] = (op.get("entity_kind")
                                       or ("edge" if _is_edge_payload(payload) else "node"))
                new_vals[eid] = None if op["op"] == "delete" else dict(payload)

            # Prior values of just the affected entities (bounded; base+overlay for a draft).
            cur_vals = await self._current_values(s, graph_id, bid, list(new_vals))

            # Cascade a node delete to its containment subtree (ontology-driven) AND every
            # live edge incident to any deleted node (source or target, ANY type) — so no
            # descendant is orphaned and no edge dangles. One commit ⇒ the cascade is atomic.
            deleted_nodes = {eid for eid, v in new_vals.items()
                             if v is None and kind_by_entity.get(eid) == "node"}
            if deleted_nodes:
                subtree, inc_edges = await self._cascade_deletes(
                    s, graph_id, bid, deleted_nodes, containment_edge_types)
                new_desc = [d for d in subtree if d not in new_vals]
                if new_desc:
                    desc_vals = await self._current_values(s, graph_id, bid, new_desc)
                    for d in new_desc:
                        if desc_vals.get(d) is not None:        # a live descendant node
                            new_vals[d] = None
                            cur_vals[d] = desc_vals[d]
                            kind_by_entity[d] = "node"
                for eid, payload in inc_edges.items():           # all incident edges, any type
                    if eid in new_vals:
                        continue
                    new_vals[eid] = None
                    cur_vals.setdefault(eid, payload)
                    kind_by_entity[eid] = "edge"

            # Referential integrity (bounded): every edge written here must have live
            # endpoints in the resulting state. Resolve only unknown endpoints.
            endpoints: set = set()
            for v in new_vals.values():
                if v is None:
                    continue
                src = v.get("sourceEntityId") or v.get("source_entity_id")
                tgt = v.get("targetEntityId") or v.get("target_entity_id")
                if src is not None or tgt is not None:
                    endpoints.update((src, tgt))
            endpoints.discard(None)
            unknown = [e for e in endpoints if e not in new_vals and e not in cur_vals]
            if unknown:
                cur_vals.update(await self._current_values(s, graph_id, bid, unknown))

            def _live(eid) -> bool:
                return (new_vals[eid] if eid in new_vals else cur_vals.get(eid)) is not None

            for eid, v in new_vals.items():
                if v is None:
                    continue
                src = v.get("sourceEntityId") or v.get("source_entity_id")
                tgt = v.get("targetEntityId") or v.get("target_entity_id")
                if src is None and tgt is None:
                    continue                                   # a node
                if not _live(src) or not _live(tgt):
                    raise ConcurrencyError(f"edge {eid} would dangle: {src}->{tgt}")

            ontology = Ontology.from_spec(graph.ontology_spec)   # write-through ontology gate
            if ontology is not None and graph.ontology_enforcement == "strict":
                viol = validate_entities(
                    [(eid, kind_by_entity.get(eid, "node"), v)
                     for eid, v in new_vals.items() if v is not None], ontology)
                if viol:
                    raise OntologyViolation(viol)

            deltas = net_delta({k: cur_vals.get(k) for k in new_vals}, new_vals)
            if not deltas:
                return None
            for d in deltas:
                kind_by_entity.setdefault(
                    d.entity_id, "edge" if _is_edge_payload(cur_vals.get(d.entity_id) or {}) else "node")

            last = await s.scalar(select(CommitORM.commit_seq).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == bid,
            ).order_by(CommitORM.commit_seq.desc()).limit(1)) or 0
            new_seq = last + 1
            branch = await s.get(BranchORM, bid)
            commit = CommitORM(
                graph_id=graph_id, branch_id=bid, commit_seq=new_seq,
                parent_commit_id=branch.head_commit_id, kind="edit",
                message=message, actor=actor,
            )
            s.add(commit)
            await s.flush()
            await self._write_deltas(s, graph_id, bid, commit, deltas, kind_by_entity, actor)
            branch.head_commit_id = commit.id
            commit.merkle_root = await self._commit_merkle(s, graph_id, bid, commit, deltas)
            commit.stats = _delta_stats(deltas)
            graph.updated_at = _now()
            if branch.kind == "main":
                graph.main_head_commit_seq = new_seq
                ps = await s.get(ProjectionStateORM, graph_id)
                if ps is not None:
                    ps.target_commit_seq = new_seq
            return commit.id

    async def _bulk_insert_versions(self, s, graph_id, branch_id, commit, node_deltas, edge_deltas, actor) -> None:
        """Chunked multi-row INSERTs into the version tables + a bulk head upsert
        (the COPY-style bulk path; never one INSERT per row)."""
        now = _now()
        head_rows: List[dict] = []
        node_dicts: List[dict] = []
        for d in node_deltas:
            vid = prefixed_id("nv"); p = d.payload or {}
            node_dicts.append(dict(
                graph_id=graph_id, id=vid, entity_id=d.entity_id, commit_id=commit.id,
                commit_seq=commit.commit_seq, branch_id=branch_id, op="create",
                content_hash=d.content_hash, prev_content_hash=None, payload=d.payload,
                actor=actor, created_at=now, urn=p.get("urn"), entity_type=p.get("entityType"),
                display_name=p.get("displayName"), qualified_name=p.get("qualifiedName"),
            ))
            head_rows.append(dict(graph_id=graph_id, branch_id=branch_id, entity_id=d.entity_id,
                                  entity_kind="node", head_version_id=vid, content_hash=d.content_hash,
                                  is_tombstone=False, updated_at=now))
        edge_dicts: List[dict] = []
        for d in edge_deltas:
            vid = prefixed_id("ev"); p = d.payload or {}
            edge_dicts.append(dict(
                graph_id=graph_id, id=vid, entity_id=d.entity_id, commit_id=commit.id,
                commit_seq=commit.commit_seq, branch_id=branch_id, op="create",
                content_hash=d.content_hash, prev_content_hash=None, payload=d.payload,
                actor=actor, created_at=now,
                source_entity_id=p.get("sourceEntityId") or "", target_entity_id=p.get("targetEntityId") or "",
                edge_type=p.get("edgeType"), confidence=p.get("confidence"), discriminator=p.get("discriminator"),
            ))
            head_rows.append(dict(graph_id=graph_id, branch_id=branch_id, entity_id=d.entity_id,
                                  entity_kind="edge", head_version_id=vid, content_hash=d.content_hash,
                                  is_tombstone=False, updated_at=now))
        # PostgreSQL caps bind parameters at 65535 PER statement. A multi-row INSERT
        # uses rows × columns params, so chunking purely by row count (e.g. 5000 rows ×
        # 17 edge columns = 85k) overflows it. Size each batch by the column count so a
        # large bootstrap commit (thousands of nodes/edges) stays under the cap.
        for batch in _chunks(node_dicts, _rows_per_insert(node_dicts)):
            await s.execute(pg_insert(NodeVersionORM).values(batch))
        for batch in _chunks(edge_dicts, _rows_per_insert(edge_dicts)):
            await s.execute(pg_insert(EdgeVersionORM).values(batch))
        for batch in _chunks(head_rows, _rows_per_insert(head_rows)):
            stmt = pg_insert(EntityHeadORM).values(batch)
            await s.execute(stmt.on_conflict_do_update(
                index_elements=["graph_id", "branch_id", "entity_id"],
                set_={"head_version_id": stmt.excluded.head_version_id,
                      "content_hash": stmt.excluded.content_hash,
                      "is_tombstone": stmt.excluded.is_tombstone,
                      "entity_kind": stmt.excluded.entity_kind,
                      "updated_at": stmt.excluded.updated_at},
            ))

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
        id_list = list(ids)
        if not id_list:
            return out
        for model in (NodeVersionORM, EdgeVersionORM):
            # Chunk the IN-list — asyncpg caps bind params at 32767 and a cascade delete
            # can touch tens of thousands of entities in one pass.
            for chunk in _chunks(id_list, _IN_LIST_MAX):
                stmt = (
                    select(model.entity_id, model.op, model.payload)
                    .where(model.graph_id == graph_id, model.branch_id == branch_id,
                           model.entity_id.in_(chunk), model.commit_seq <= seq)
                    .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                    .distinct(model.entity_id)
                )
                for eid, op, payload in (await s.execute(stmt)).all():
                    out[eid] = None if op == "delete" else payload
        return out

    async def _current_values(
        self, s, graph_id: str, branch_id: str, ids, as_of_seq: Optional[int] = None,
    ) -> Dict[str, Optional[dict]]:
        """Value of each id on a branch, bounded to *ids* (absent ids omitted).
        ``as_of_seq`` reconstructs the value at that commit (time-travel); ``None`` = head.
        ``main`` → values at the seq; a draft → ``main`` at its branch point overlaid with
        the draft's own rows. O(ids) via ``_values_at`` — never composes full state."""
        ids = list(ids)
        if not ids:
            return {}
        main_id = await self._main_branch_id(s, graph_id)
        if branch_id == main_id:
            graph = await s.get(GraphORM, graph_id)
            seq = graph.main_head_commit_seq if as_of_seq is None else as_of_seq
            return await self._values_at(s, graph_id, main_id, ids, seq)
        branch = await s.get(BranchORM, branch_id)
        base_seq = branch.base_commit_seq or 0
        if as_of_seq is not None:
            base_seq = min(base_seq, as_of_seq)
        out = await self._values_at(s, graph_id, main_id, ids, base_seq)
        overlay_seq = (1 << 62) if as_of_seq is None else as_of_seq
        out.update(await self._values_at(s, graph_id, branch_id, ids, overlay_seq))
        return out

    async def _incident_live_edges(
        self, s, graph_id: str, branch_id: str, node_ids, as_of_seq: Optional[int] = None,
    ) -> Dict[str, dict]:
        """Currently-live edges on a branch incident to any of *node_ids* — bounded by
        node degree via ix_ev_source/ix_ev_target. Returns {edge_entity_id: payload}."""
        ids = list(node_ids)
        if not ids:
            return {}
        cand: set = set()
        for col in (EdgeVersionORM.source_entity_id, EdgeVersionORM.target_entity_id):
            for chunk in _chunks(ids, _IN_LIST_MAX):   # bind-param-safe IN-list (see _values_at)
                rows = (await s.execute(
                    select(EdgeVersionORM.entity_id).where(
                        EdgeVersionORM.graph_id == graph_id, col.in_(chunk),
                    ).distinct()
                )).scalars().all()
                cand.update(rows)
        vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
        return {eid: p for eid, p in vals.items() if p is not None}

    async def _cascade_subtree(
        self, s, graph_id: str, branch_id: str, root_ids: set,
        cset: set, as_of_seq: Optional[int], cap: int, max_depth: int = 64,
    ) -> set:
        """Containment subtree to delete when *root_ids* are deleted, respecting SHARED
        children: a descendant is included only when ALL of its containment parents are in
        the delete set — a child that still has a surviving parent is re-parented, not
        deleted. BFS from the roots; a child is (re)considered whenever any of its parents is
        newly deleted, so multi-parent (DAG) containment converges correctly."""
        deleted = set(root_ids)
        frontier = set(root_ids)
        for _ in range(max_depth):
            if not frontier or len(deleted) >= cap:
                break
            # Children reachable via containment OUT-edges from the newly-deleted frontier.
            inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
            candidates: set = set()
            for p in inc.values():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)              # a = parent (source), b = child (target)
                if a in frontier and b and b not in deleted:
                    candidates.add(b)
            if not candidates:
                break
            # Gather EVERY containment parent of each candidate; delete it only when they're
            # all already in the delete set (otherwise a surviving parent keeps it alive).
            cand_inc = await self._incident_live_edges(s, graph_id, branch_id, candidates, as_of_seq)
            parents_of: Dict[str, set] = {}
            for p in cand_inc.values():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)
                if b in candidates and a:
                    parents_of.setdefault(b, set()).add(a)
            nxt: set = set()
            for c in candidates:
                ps = parents_of.get(c)
                if ps and ps <= deleted and len(deleted) < cap:
                    deleted.add(c)
                    nxt.add(c)
            frontier = nxt
        return deleted

    async def _cascade_deletes(
        self, s, graph_id: str, branch_id: str, root_node_ids,
        containment_edge_types, as_of_seq: Optional[int] = None,
    ) -> Tuple[set, Dict[str, dict]]:
        """The full tombstone set for deleting *root_node_ids* on a branch:

        * the **containment subtree** of nodes (transitive children via the ontology's
          containment edge types — `containment_edge_types`, resolved live by the caller,
          never hardcoded; shared children with a surviving parent are kept), and
        * **every live edge incident** to any of those nodes (source OR target, ANY type —
          containment, lineage, aggregated — so nothing dangles).

        Lineage-connected nodes are NOT added to the node set; only their edges are cleaned.
        Returns ``(subtree_node_ids, {edge_entity_id: payload})``. The same helper backs the
        read-only delete-impact preview AND the commit-time cascade, so they always agree."""
        roots = {r for r in root_node_ids if r}
        if not roots:
            return set(), {}
        cset = {t.upper() for t in (containment_edge_types or [])}
        subtree = await self._cascade_subtree(
            s, graph_id, branch_id, set(roots), cset, as_of_seq, _CASCADE_MAX_NODES,
        ) if cset else set(roots)
        subtree |= roots
        edges = await self._incident_live_edges(s, graph_id, branch_id, subtree, as_of_seq)
        return subtree, edges

    async def delete_impact(
        self, *, graph_id: str, branch_id: str, root_urn: str, containment_edge_types,
        limit: int = 1000,
    ) -> Dict[str, object]:
        """Read-only preview: what deleting the node at *root_urn* would remove on this
        branch — the containment subtree (node payloads) + all incident edges (edge
        payloads), with accurate totals (the lists are capped at ``limit`` for the UI, the
        totals are not). Same traversal as the commit-time cascade, so the preview matches
        the result. Empty when the urn doesn't resolve to a live node."""
        async with self._session() as s:
            root = await self._eid_for_urn(s, graph_id, branch_id, root_urn)
            if root is None:
                return {"nodes": [], "edges": [], "node_total": 0, "edge_total": 0}
            subtree, edges = await self._cascade_deletes(
                s, graph_id, branch_id, {root}, containment_edge_types)
            node_vals = await self._current_values(s, graph_id, branch_id, list(subtree))
            live_node_ids = [eid for eid in subtree if node_vals.get(eid) is not None]
            edge_ids = list(edges)
            nodes = [{"entityId": eid, **(node_vals[eid] or {})} for eid in live_node_ids[:limit]]
            edge_list = [{"entityId": eid, **(edges[eid] or {})} for eid in edge_ids[:limit]]
            return {"nodes": nodes, "edges": edge_list,
                    "node_total": len(live_node_ids), "edge_total": len(edge_ids)}

    async def _eid_for_urn(
        self, s, graph_id: str, branch_id: str, urn: str, as_of_seq: Optional[int] = None,
    ) -> Optional[str]:
        """Resolve a seed urn to its live node's entity_id on a branch (bounded via
        ix_nv_urn + the ``gv:<eid>`` fast path); ``None`` if absent/tombstoned/not a node."""
        cand: List[str] = [urn[3:]] if urn.startswith("gv:") else []
        cand.extend((await s.execute(
            select(NodeVersionORM.entity_id).where(
                NodeVersionORM.graph_id == graph_id, NodeVersionORM.urn == urn,
            ).distinct()
        )).scalars().all())
        if not cand:
            return None
        vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
        for eid in cand:
            p = vals.get(eid)
            if p is not None and not _is_edge_payload(p) and (p.get("urn") == urn or f"gv:{eid}" == urn):
                return eid
        return None

    async def entity_value(
        self, *, graph_id: str, entity_id: str, branch_id: Optional[str] = None,
    ) -> Optional[dict]:
        """Current payload of one entity on a branch (default ``main``), or ``None`` — a
        bounded lookup for provider write-through (no full-state materialize)."""
        async with self._session() as s:
            bid = branch_id or await self._main_branch_id(s, graph_id)
            return (await self._current_values(s, graph_id, bid, [entity_id])).get(entity_id)

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
    def _cascade_incident_edges(state: Dict[str, Optional[dict]]) -> List[str]:
        """Tombstone every live edge incident to a tombstoned node so that deleting
        a node cascades to its edges within the same commit (plan §16.5 #8). Mutates
        ``state`` in place and returns the cascaded edge ids. Edges pointing at an
        endpoint that *never existed* are left for the integrity guard to reject."""
        tomb = {eid for eid, p in state.items() if p is None}
        if not tomb:
            return []
        cascaded = [
            eid for eid, p in state.items()
            if p is not None
            and (p.get("sourceEntityId") or p.get("source_entity_id")) is not None
            and ((p.get("sourceEntityId") or p.get("source_entity_id")) in tomb
                 or (p.get("targetEntityId") or p.get("target_entity_id")) in tomb)
        ]
        for eid in cascaded:
            state[eid] = None
        return cascaded

    @staticmethod
    def _cascade_containment(state: Dict[str, Optional[dict]], containment_edge_types) -> List[str]:
        """Tombstone the containment-descendants of every tombstoned node, in-memory over a
        FULL state (the sync/merge path's analog of the DB-backed `_cascade_deletes`).
        Ontology-driven via *containment_edge_types* — walks parent→child along containment
        edges present in the state. Mutates ``state``; returns the cascaded node ids.
        (Incident-edge cleanup runs separately via `_cascade_incident_edges`.)"""
        cset = {t.upper() for t in (containment_edge_types or [])}
        if not cset:
            return []
        children: Dict[str, set] = {}
        parents_of: Dict[str, set] = {}
        for p in state.values():
            if p is None or not _is_edge_payload(p):
                continue
            if (p.get("edgeType") or "").upper() not in cset:
                continue
            src = p.get("sourceEntityId") or p.get("source_entity_id")
            tgt = p.get("targetEntityId") or p.get("target_entity_id")
            if src and tgt:
                children.setdefault(src, set()).add(tgt)
                parents_of.setdefault(tgt, set()).add(src)
        cascaded: List[str] = []
        deleted = {eid for eid, p in state.items() if p is None}
        frontier = set(deleted)
        while frontier:
            nxt: set = set()
            for parent in frontier:
                for child in children.get(parent, ()):
                    if child in deleted:
                        continue
                    ps = parents_of.get(child)               # delete only if NO parent survives
                    if ps and ps <= deleted:
                        state[child] = None
                        deleted.add(child)
                        cascaded.append(child)
                        nxt.add(child)
            frontier = nxt
        return cascaded

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


def _fold_shared(
    base_state: Mapping[str, Optional[dict]],
    changes: Sequence["WorkingChangeORM"],
    set_fields: frozenset,
    resolutions: Mapping[str, Optional[dict]],
) -> Tuple[Dict[str, Optional[dict]], List[dict]]:
    """Fold a shared draft's working changes into head state with per-collaborator
    3-way field merge (shared-draft OCC, plan §8).

    A single actor's edits to an entity fold by seq order (full replace) — exactly
    as a private draft would, so behaviour is unchanged when only one person
    touched it.  When *different* actors touched the same entity, each actor's net
    payload is 3-way merged over the committed base (``base_state`` — the common
    ancestor every concurrent edit was staged against, per ``base_content_hash``):
    disjoint fields union, a same-field clash becomes a conflict unless
    ``resolutions`` (``{entity_id: payload|None}``) settles it.
    """
    head: Dict[str, Optional[dict]] = dict(base_state)
    conflicts: List[dict] = []
    by_entity: Dict[str, List["WorkingChangeORM"]] = {}
    for c in changes:                                    # arrive in seq order
        by_entity.setdefault(c.entity_id, []).append(c)

    for eid, chs in by_entity.items():
        if eid in resolutions:                           # caller settled this entity
            head[eid] = resolutions[eid]
            continue
        ancestor = base_state.get(eid)
        order: List[str] = []                            # actors, first-seen order
        net: Dict[str, Optional[dict]] = {}
        for c in chs:
            if c.actor not in net:
                order.append(c.actor)
            net[c.actor] = None if c.op == "delete" else (
                dict(c.payload) if c.payload is not None else None
            )
        merged = net[order[0]]
        for a in order[1:]:                              # iterative 3-way over one ancestor
            out = three_way_merge(ancestor, merged, net[a], set_fields)
            merged = out.merged
            for cf in out.conflicts:
                conflicts.append({
                    "entity_id": eid, "path": list(cf.path),
                    "base": cf.base, "ours": cf.ours, "theirs": cf.theirs, "kind": cf.kind,
                })
        head[eid] = merged
    return head, conflicts


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
    """Reader-compatible GraphNode shape (by alias) from a version payload. Surfaces the same
    top-level denormalised fields FalkorDB returns (``_node_from_props``) so a draft node is
    shaped identically to main; ``childCount`` is stamped separately by ``_attach_child_counts``."""
    return {
        "urn": urn,
        "entityId": entity_id,
        "entityType": payload.get("entityType"),
        "displayName": payload.get("displayName") or "",
        "qualifiedName": payload.get("qualifiedName"),
        "description": payload.get("description"),
        "properties": payload.get("properties") or {},
        "tags": payload.get("tags") or [],
        "layerAssignment": payload.get("layerAssignment"),
        "sourceSystem": payload.get("sourceSystem"),
        "lastSyncedAt": payload.get("lastSyncedAt"),
    }


def _set_child_count(nd: dict, cc: int) -> None:
    """Stamp a reader node dict with its containment ``childCount`` (top-level field + mirrored
    into ``properties`` — the canvas reads either). The one attach shape every branch/as-of node
    read shares, so drafts stay at parity with FalkorDB's per-read child counts."""
    nd["childCount"] = cc
    nd["properties"] = {**(nd.get("properties") or {}), "childCount": cc}


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


def _chunks(seq, n):
    for i in range(0, len(seq), max(1, n)):
        yield seq[i:i + max(1, n)]


# asyncpg caps bind parameters at 32767 (signed int16) per statement — stricter than
# PostgreSQL's own 65535. Stay under it with headroom. A multi-row INSERT costs
# rows × columns params.
_PG_MAX_BIND_PARAMS = 32000

# Max ids in a single ``... IN (:ids)`` predicate (the list dominates the param count;
# a handful of fixed predicates add the rest) — keeps a cascade's bounded reads safe.
_IN_LIST_MAX = 20000

# Upper bound on a single cascade-delete's containment subtree, so a pathological graph
# can't run unbounded. Generous; the chunked writes handle the volume.
_CASCADE_MAX_NODES = 1_000_000


def _rows_per_insert(dicts: List[dict]) -> int:
    """Rows per multi-row INSERT so rows × columns stays under the bind-param cap.
    Bounded by ``INGEST_BATCH_SIZE`` so it never exceeds the configured batch size."""
    ncols = len(dicts[0]) if dicts else 1
    return max(1, min(config.INGEST_BATCH_SIZE, _PG_MAX_BIND_PARAMS // ncols))


def _delta_stats(deltas: List[Delta]) -> dict:
    out = {"create": 0, "update": 0, "delete": 0}
    for d in deltas:
        out[d.op] += 1
    return out


def _deltas_to_diff_vs_main(
    deltas: List[Delta], theirs: Mapping[str, Optional[dict]],
) -> Dict[str, list]:
    """Reshape a squash (``net_delta(theirs, merged)``) into the UI's
    ``DiffVsMainResponse`` shape — added/removed/modified with whole-payload
    before/after, exactly what :meth:`diff_branch_vs_base` emits — so a PR's Files
    Changed renders through the identical canvas/diff overlay. ``before`` is the
    target-side payload (``theirs``; a delete carries ``payload=None``, so its before
    must come from here); ``after`` is the merged payload."""
    added: List[dict] = []
    removed: List[dict] = []
    modified: List[dict] = []
    for d in deltas:
        before = theirs.get(d.entity_id)
        kind = "edge" if _is_edge_payload(d.payload or before or {}) else "node"
        if d.op == "create":
            added.append({"entityId": d.entity_id, "kind": kind, "after": d.payload})
        elif d.op == "delete":
            removed.append({"entityId": d.entity_id, "kind": kind, "before": before})
        else:
            modified.append({"entityId": d.entity_id, "kind": kind, "before": before, "after": d.payload})
    return {"added": added, "removed": removed, "modified": modified}


# --------------------------------------------------------------------------- #
# Hierarchical diff — reshape a flat squash into a lazy-loadable containment    #
# tree for the review UIs (canvas Changes panel + PR Files Changed). Pure /     #
# in-memory over two materialised states, so it is unit-testable without a DB.  #
# --------------------------------------------------------------------------- #
_OP_STATUS = {"create": "added", "update": "modified", "delete": "removed"}


def _build_diff_hierarchy(
    merged: Mapping[str, Optional[dict]],
    theirs: Mapping[str, Optional[dict]],
    containment_edge_types,
) -> dict:
    """Index a flat squash (``net_delta(theirs, merged)``) as a containment tree.

    Changed nodes nest under their real containment parent, walked up to a root; a change with
    no containment parent is bucketed by entityType; a non-containment edge change is bucketed
    by edgeType. Containment-edge changes are *structural* — implied by their child node's
    create/delete — so they count toward the global totals but never get their own row. The PR
    path passes full merge states (every container present); the branch path passes its changes
    plus the unchanged ancestor skeleton. O(changed + containment edges in the states).

    Returns an index consumed by :func:`_hierarchy_summary_view` / `_hierarchy_children_view`.
    """
    cset = {t.upper() for t in (containment_edge_types or [])}
    deltas = net_delta(theirs, merged)
    delta_by_eid: Dict[str, Delta] = {d.entity_id: d for d in deltas}

    def payload_of(eid: str) -> dict:
        p = merged.get(eid)
        return (p if p is not None else theirs.get(eid)) or {}

    def is_edge(eid: str) -> bool:
        return _is_edge_payload(payload_of(eid))

    # child -> parent from containment edges (theirs first so merged wins on a reparent; a
    # deleted edge survives only in theirs, keeping a deleted child under its old parent).
    parent_of: Dict[str, str] = {}
    for state in (theirs, merged):
        for p in state.values():
            if not p or not _is_edge_payload(p):
                continue
            if (p.get("edgeType") or "").upper() not in cset:
                continue
            src = p.get("sourceEntityId") or p.get("source_entity_id")
            tgt = p.get("targetEntityId") or p.get("target_entity_id")
            if src and tgt:
                parent_of[tgt] = src

    changed_nodes = [eid for eid in delta_by_eid if not is_edge(eid)]
    changed_edges = [eid for eid in delta_by_eid if is_edge(eid)]

    def ancestors(eid: str) -> List[str]:
        chain: List[str] = []
        cur = parent_of.get(eid)
        while cur is not None and cur not in chain and len(chain) < 64:
            chain.append(cur)
            cur = parent_of.get(cur)
        return chain

    # relevant tree nodes = changed nodes + their (possibly unchanged) containment ancestors
    relevant: set = set(changed_nodes)
    for eid in changed_nodes:
        relevant.update(ancestors(eid))

    children_of: Dict[str, List[str]] = {}              # forest: each node has ≤1 parent
    for eid in relevant:
        par = parent_of.get(eid)
        if par in relevant:
            children_of.setdefault(par, []).append(eid)

    buckets: Dict[str, List[str]] = {}
    roots: List[str] = []
    for eid in relevant:
        if parent_of.get(eid) in relevant:
            continue                                     # nested under a relevant container
        if eid in children_of:
            roots.append(eid)                            # top-level container w/ changed descendants
        else:                                            # parent-less changed leaf → type bucket
            buckets.setdefault("type:" + (payload_of(eid).get("entityType") or "Other"), []).append(eid)
    for eid in changed_edges:
        p = payload_of(eid)
        if (p.get("edgeType") or "").upper() in cset:
            continue                                     # structural containment edge — suppressed
        buckets.setdefault("edge:" + (p.get("edgeType") or "Relationship"), []).append(eid)

    # per-container rollup of changed-node counts (memoised DFS over the forest)
    subtree: Dict[str, dict] = {}

    def rollup(eid: str) -> dict:
        if eid in subtree:
            return subtree[eid]
        c = {"added": 0, "modified": 0, "removed": 0}
        d = delta_by_eid.get(eid)
        if d is not None and not is_edge(eid):
            c[_OP_STATUS[d.op]] += 1
        for ch in children_of.get(eid, ()):
            cc = rollup(ch)
            for k in c:
                c[k] += cc[k]
        subtree[eid] = c
        return c

    def node_view(eid: str) -> dict:
        d = delta_by_eid.get(eid)
        child = children_of.get(eid, [])
        p = payload_of(eid)
        single = {"added": 0, "modified": 0, "removed": 0}
        if d is not None:
            single[_OP_STATUS[d.op]] += 1
        return {
            "key": eid,
            "kind": "container" if child else "leaf",
            "label": p.get("displayName") or p.get("urn") or eid,
            "entityType": p.get("entityType"),
            "status": _OP_STATUS[d.op] if d else "unchanged",
            "counts": rollup(eid) if child else single,
            "childTotal": len(child),
            "deleted": bool(d and d.op == "delete"),
            "before": theirs.get(eid),
            "after": merged.get(eid),
        }

    def bucket_view(key: str) -> dict:
        members = buckets[key]
        c = {"added": 0, "modified": 0, "removed": 0}
        for m in members:
            d = delta_by_eid.get(m)
            if d:
                c[_OP_STATUS[d.op]] += 1
        kind, _, name = key.partition(":")
        return {
            "key": key, "kind": "bucket", "label": name,
            "entityType": name if kind == "type" else None,
            "status": None, "counts": c, "childTotal": len(members),
            "deleted": False, "before": None, "after": None,
        }

    root_views = sorted(
        (node_view(e) for e in roots),
        key=lambda g: (-sum(g["counts"].values()), g["label"].lower()),
    )
    bucket_views = sorted((bucket_view(k) for k in buckets), key=lambda g: g["label"].lower())

    counts = {"added": 0, "modified": 0, "removed": 0}
    for d in deltas:
        counts[_OP_STATUS[d.op]] += 1
    impact: Dict[str, int] = {}
    for eid in relevant:
        et = payload_of(eid).get("entityType") or "Other"
        impact[et] = impact.get(et, 0) + 1

    return {
        "top": root_views + bucket_views,
        "counts": counts,
        "impact": impact,
        "children_of": children_of,
        "buckets": buckets,
        "node_view": node_view,
    }


def _hierarchy_summary_view(index: dict, limit: int) -> dict:
    """Top-level groups (capped) + global counts + the entityType impact rollup."""
    top = index["top"]
    return {
        "groups": top[: max(0, limit)],
        "groupTotal": len(top),
        "counts": index["counts"],
        "impact": index["impact"],
    }


def _hierarchy_children_view(index: dict, key: str, limit: int, offset: int) -> dict:
    """One group's direct children (a page) — containers first, then leaves, label-ordered."""
    member_eids = index["children_of"].get(key) or index["buckets"].get(key) or []
    views = [index["node_view"](e) for e in member_eids]
    views.sort(key=lambda v: (0 if v["kind"] == "container" else 1, v["label"].lower(), v["key"]))
    return {"entries": views[offset: offset + max(0, limit)], "total": len(views)}

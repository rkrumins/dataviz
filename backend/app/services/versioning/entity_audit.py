"""One entity's audit trail, bounded: who created it and who last changed it on the line of work the
reader is looking at (its *summary*), and its revisions, a page at a time (its *history*).

Both answer for ONE entity on ONE line — ``main``, or a draft seen the way the draft sees it:
``main`` at the draft's branch point, overlaid with the draft's own edits. Every query is served by
the per-entity index (``ix_nv_entity_hist`` / ``ix_ev_entity_hist``), so the cost follows the
entity's own revision count, never the graph's.

The drawers used to download an entity's WHOLE history to show two timestamps, and computed
"Updated" from whatever row was newest on any branch — so a draft showed main's later edit as the
last change to what the draft still had at its branch point.
"""
from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import TIMESTAMP, cast, func, literal, select, tuple_

from .merkle import content_hash
from .models import BranchORM, CommitORM, EdgeVersionORM, GraphORM, NodeVersionORM

__all__ = [
    "HISTORY_DEFAULT_LIMIT",
    "HISTORY_MAX_LIMIT",
    "ENTITY_VIEW_CAP",
    "InvalidCursor",
    "encode_cursor",
    "decode_cursor",
    "field_changes",
    "history_branches",
    "entity_views",
    "entity_summary",
    "entity_history_page",
]

HISTORY_DEFAULT_LIMIT = 50
HISTORY_MAX_LIMIT = 200
#: Entities a save answers with (``/graph/changes`` → ``entities``); a bigger save says it was cut.
ENTITY_VIEW_CAP = 500


class InvalidCursor(ValueError):
    """A ``before`` cursor this service did not issue."""


# --------------------------------------------------------------------------- #
# Pure helpers                                                                 #
# --------------------------------------------------------------------------- #
def encode_cursor(created_at: str, row_id: str) -> str:
    """An opaque position in one entity's history: the last row a page showed. Rows order by
    ``(created_at, id)`` — ``commit_seq`` is per branch, so it cannot order main and a draft."""
    raw = json.dumps([created_at, row_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> Tuple[datetime, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        at, row_id = json.loads(raw)
        if not isinstance(at, str) or not isinstance(row_id, str) or not row_id:
            raise ValueError
        return datetime.fromisoformat(at), row_id
    except (ValueError, TypeError) as exc:
        raise InvalidCursor("not a history cursor") from exc


def _change(path: List[str], before: Mapping, after: Mapping, key: str) -> dict:
    had, has = key in before, key in after
    return {"path": path, "kind": "added" if not had else "removed" if not has else "changed",
            "before": before.get(key), "after": after.get(key)}


def field_changes(before: Optional[Mapping], after: Optional[Mapping]) -> List[dict]:
    """What one revision changed, field by field and property by property:
    ``[{path, kind: added|removed|changed, before, after}]`` — ``path`` is ``[field]`` or
    ``["properties", name]``. A creation lists what it set; a deletion what it removed."""
    b, a = before or {}, after or {}
    out: List[dict] = []
    for key in sorted((set(b) | set(a)) - {"properties"}):
        if key not in b or key not in a or b[key] != a[key]:
            out.append(_change([key], b, a, key))
    bp, ap = b.get("properties") or {}, a.get("properties") or {}
    for key in sorted(set(bp) | set(ap)):
        if key not in bp or key not in ap or bp[key] != ap[key]:
            out.append(_change(["properties", key], bp, ap, key))
    return out


def history_branches(scope: str, main_id: str, draft_id: Optional[str]) -> List[str]:
    """The lines a history ``scope`` reads: ``all`` (main and the draft being viewed), ``draft``
    (that draft only) or ``published`` (main only). Never another user's draft."""
    if scope == "published":
        return [main_id]
    if scope == "draft":
        return [draft_id] if draft_id else []
    return [main_id] + ([draft_id] if draft_id else [])


class _UrnOf(dict):
    """entity_id → urn, answering the id itself when unknown (a node's id IS its urn unless it
    was stored under a separate one, which the batch then knows)."""

    def get(self, key, default=None):  # noqa: D401 - dict protocol
        return super().get(key, key)


def entity_views(
    values: Mapping[str, Tuple[str, Optional[dict]]],
    urns: Optional[Mapping[str, str]] = None,
    *,
    cap: Optional[int] = None,
) -> Tuple[Dict[str, dict], bool]:
    """Each entity as a reader returns it: ``{id: {kind, version, node|edge}}``, a deleted one as
    ``{kind, version: None, deleted: True}``. ``version`` is the optimistic-concurrency token the
    next edit echoes. Returns ``(views, truncated)``."""
    from .service import _graphedge_dict, _graphnode_dict   # the one reader shape

    urn_of = _UrnOf(urns or {})
    for eid, (kind, v) in values.items():
        if kind == "node" and v:
            urn_of[eid] = v.get("urn") or eid
    views: Dict[str, dict] = {}
    for i, (eid, (kind, v)) in enumerate(values.items()):
        if cap is not None and i >= cap:
            return views, True
        if v is None:
            views[eid] = {"kind": kind, "version": None, "deleted": True}
        elif kind == "edge":
            views[eid] = {"kind": "edge", "version": content_hash(v), "edge": _graphedge_dict(eid, v, urn_of)}
        else:
            views[eid] = {"kind": "node", "version": content_hash(v),
                          "node": _graphnode_dict(eid, v.get("urn") or eid, v)}
    return views, False


# --------------------------------------------------------------------------- #
# Queries                                                                      #
# --------------------------------------------------------------------------- #
_MODELS = {"node": NodeVersionORM, "edge": EdgeVersionORM}


async def _kind_of(s, graph_id: str, entity_id: str, kind: Optional[str]) -> str:
    if kind in _MODELS:
        return kind
    hit = await s.scalar(select(NodeVersionORM.id).where(
        NodeVersionORM.graph_id == graph_id, NodeVersionORM.entity_id == entity_id).limit(1))
    return "node" if hit is not None else "edge"


def _event(row, main_id: str) -> dict:
    return {"at": row.created_at, "actor": row.actor, "op": row.op, "commitId": row.commit_id,
            "inDraft": row.branch_id != main_id}


async def _line_of(s, svc, graph_id: str, branch_id: Optional[str]):
    """``(graph, main_id, draft_id | None, base_seq)`` — the line a read sees; ``base_seq`` is the
    main seq it sees up to (a draft's branch point, else main's head)."""
    graph = await s.get(GraphORM, graph_id)
    if graph is None:
        raise ValueError(f"unknown graph {graph_id}")
    main_id = await svc._main_branch_id(s, graph_id)
    if not branch_id or branch_id == main_id:
        return graph, main_id, None, graph.main_head_commit_seq or 0
    branch = await s.get(BranchORM, branch_id)
    if branch is None or branch.graph_id != graph_id:
        raise ValueError(f"branch {branch_id} is not a branch of graph {graph_id}")
    return graph, main_id, branch_id, branch.base_commit_seq or 0


async def _edge_endpoint_urns(s, svc, graph_id: str, line: str, value: Optional[dict]) -> Dict[str, str]:
    if not value or not ("sourceEntityId" in value or "source_entity_id" in value):
        return {}
    ends = [e for e in (value.get("sourceEntityId") or value.get("source_entity_id"),
                        value.get("targetEntityId") or value.get("target_entity_id")) if e]
    vals = await svc._current_values(s, graph_id, line, ends)
    return {e: (v.get("urn") or e) for e, v in vals.items() if v}


async def entity_summary(
    svc, *, graph_id: str, entity_id: str, branch_id: Optional[str] = None,
    kind: Optional[str] = None, include_value: bool = False,
) -> dict:
    """Who created the entity and who last changed it, as the line being viewed has it, with its
    revision counts and — ``include_value`` — its current value and token (an edit's baseline).

    On a draft: an entity the draft never touched is ``main`` AT THE BRANCH POINT (a later main
    edit is not this draft's value — ``changedOnMainSinceBranch`` says one exists). On a fork, an
    entity with no revisions of its own is its parent's at the fork point (``inherited``)."""
    async with svc._session() as s:
        graph, main_id, draft_id, base_seq = await _line_of(s, svc, graph_id, branch_id)
        kind = await _kind_of(s, graph_id, entity_id, kind)
        model = _MODELS[kind]
        line = draft_id or main_id

        def rows(branch: str, *, upto: Optional[int] = None, after: Optional[int] = None):
            q = select(model).where(model.graph_id == graph_id, model.entity_id == entity_id,
                                    model.branch_id == branch)
            if upto is not None:
                q = q.where(model.commit_seq <= upto)
            if after is not None:
                q = q.where(model.commit_seq > after)
            return q

        async def first(q):
            return (await s.execute(q.order_by(model.commit_seq, model.created_at).limit(1))).scalars().first()

        async def last(q):
            return (await s.execute(
                q.order_by(model.commit_seq.desc(), model.created_at.desc()).limit(1))).scalars().first()

        async def count(q):
            return int(await s.scalar(select(func.count()).select_from(q.subquery())) or 0)

        main_q = rows(main_id, upto=base_seq)
        main_first, main_last, published = await first(main_q), await last(main_q), await count(main_q)
        draft_first = draft_last = None
        in_draft = 0
        changed_on_main = False
        if draft_id:
            draft_q = rows(draft_id)
            draft_first, draft_last, in_draft = await first(draft_q), await last(draft_q), await count(draft_q)
            changed_on_main = (await s.scalar(
                select(model.id).where(model.graph_id == graph_id, model.entity_id == entity_id,
                                       model.branch_id == main_id, model.commit_seq > base_seq).limit(1))
            ) is not None

        value = (await svc._current_values(s, graph_id, line, [entity_id])).get(entity_id)
        created = main_first or draft_first
        updated = draft_last or main_last
        inherited = False
        if created is None and graph.fork_parent_graph_id:
            # A fork holds only its divergence: an entity it never changed is its parent's.
            pgraph = graph.fork_parent_graph_id
            pmain = await svc._main_branch_id(s, pgraph)
            fork_seq = graph.fork_base_commit_seq or 0
            pq = select(model).where(model.graph_id == pgraph, model.entity_id == entity_id,
                                     model.branch_id == pmain, model.commit_seq <= fork_seq)
            created, updated = await first(pq), await last(pq)
            if created is not None:
                inherited = True
                published = await count(pq)
                if value is None and not draft_last:
                    value = await svc._entity_value_at(s, graph_id, main_id, entity_id,
                                                       graph.main_head_commit_seq or 0)

        out: Dict[str, Any] = {
            "entityId": entity_id,
            "kind": kind,
            "exists": value is not None,
            "version": content_hash(value) if value is not None else None,
            "inherited": inherited,
            "created": _event(created, main_id) if created is not None else None,
            "updated": _event(updated, main_id) if updated is not None else None,
            "revisions": {"published": published, "draft": in_draft},
            "changedOnMainSinceBranch": changed_on_main,
            "baseCommitSeq": base_seq if draft_id else None,
        }
        if include_value and value is not None:
            urns = await _edge_endpoint_urns(s, svc, graph_id, line, value) if kind == "edge" else {}
            views, _ = entity_views({entity_id: (kind, value)}, urns)
            out["value"] = views[entity_id]
        return out


async def entity_history_page(
    svc, *, graph_id: str, entity_id: str, branch_id: Optional[str] = None, scope: str = "all",
    limit: int = HISTORY_DEFAULT_LIMIT, before: Optional[str] = None, include_payload: bool = False,
    kind: Optional[str] = None,
) -> dict:
    """One page of an entity's revisions, newest first, on ``main`` and the draft being viewed.

    Each row says what it changed (``changes``, property by property, against the value it was
    made from), which commit made it and why, whether it is the draft's own
    (``on_draft``) and whether it landed on main after the draft branched
    (``after_branch_point``). ``nextBefore`` is the cursor for the next page."""
    limit = max(1, min(int(limit), HISTORY_MAX_LIMIT))
    cursor = decode_cursor(before) if before else None
    async with svc._session() as s:
        _graph, main_id, draft_id, base_seq = await _line_of(s, svc, graph_id, branch_id)
        branches = history_branches(scope, main_id, draft_id)
        if not branches:
            return {"entityId": entity_id, "versions": [], "hasMore": False, "nextBefore": None}
        kind = await _kind_of(s, graph_id, entity_id, kind)
        model = _MODELS[kind]
        at = cast(model.created_at, TIMESTAMP(timezone=True))
        q = select(model).where(model.graph_id == graph_id, model.entity_id == entity_id,
                                model.branch_id.in_(branches))
        if cursor is not None:
            q = q.where(tuple_(at, model.id) < tuple_(literal(cursor[0]), literal(cursor[1])))
        rows = (await s.execute(q.order_by(at.desc(), model.id.desc()).limit(limit + 1))).scalars().all()
        has_more = len(rows) > limit
        rows = rows[:limit]

        prev_hashes = sorted({r.prev_content_hash for r in rows if r.prev_content_hash})
        prev: Dict[str, Optional[dict]] = {}
        if prev_hashes:
            for h, p in (await s.execute(
                select(model.content_hash, model.payload).where(
                    model.graph_id == graph_id, model.entity_id == entity_id,
                    model.content_hash.in_(prev_hashes)))).all():
                prev.setdefault(h, p)
        commits: Dict[str, Tuple[str, Optional[str]]] = {}
        commit_ids = sorted({r.commit_id for r in rows})
        if commit_ids:
            for cid, ckind, msg in (await s.execute(
                select(CommitORM.id, CommitORM.kind, CommitORM.message).where(
                    CommitORM.graph_id == graph_id, CommitORM.id.in_(commit_ids)))).all():
                commits[cid] = (ckind, msg)

        versions: List[dict] = []
        for r in rows:
            if r.prev_content_hash and r.prev_content_hash not in prev:
                changes = None                      # made from a value no longer on record
            else:
                changes = field_changes(prev.get(r.prev_content_hash) if r.prev_content_hash else None,
                                        None if r.op == "delete" else r.payload)
            ckind, message = commits.get(r.commit_id, (None, None))
            row = {
                "id": r.id, "commit_id": r.commit_id, "commit_seq": r.commit_seq, "branch_id": r.branch_id,
                "op": r.op, "content_hash": r.content_hash, "prev_content_hash": r.prev_content_hash,
                "actor": r.actor, "change_reason": r.change_reason, "created_at": r.created_at,
                "commit_kind": ckind, "commit_message": message, "changes": changes,
                "on_draft": r.branch_id != main_id,
                "after_branch_point": bool(draft_id) and r.branch_id == main_id and r.commit_seq > base_seq,
            }
            if include_payload:
                row["payload"] = r.payload
            versions.append(row)
        next_before = encode_cursor(rows[-1].created_at, rows[-1].id) if has_more and rows else None
        return {"entityId": entity_id, "kind": kind, "versions": versions,
                "hasMore": has_more, "nextBefore": next_before}

"""Comments on a review: threads on a change (or one field or property of it), or on the review as
a whole — replies, resolve and reopen, and people mentioned.

Its own small store (``graphver.review_comments``), read and written here; who may see the
review is the route's to decide (``pr_in_workspace``), as for every review read. Notifications are
the route's too: this says who to tell (``Posted.mentioned`` / ``.told``), the route tells them.
"""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import func, select

from . import db
from .ids import prefixed_id
from .models import EntityHeadORM, MergeRequestORM, ReviewCommentORM

MAX_BODY = 10_000
MAX_MENTIONS = 20


class CommentRefused(ValueError):
    """A comment that cannot be written as asked (empty, too long, a thread that isn't there)."""


class NotYours(PermissionError):
    """Only its author edits a comment (and its author or a manager deletes one)."""


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _is_draft_review(pr: MergeRequestORM) -> bool:
    return bool(pr.source_graph_id) and pr.source_graph_id == pr.target_graph_id


@dataclass
class Posted:
    comment: Dict[str, Any]
    #: People to tell they were mentioned (not the author).
    mentioned: List[str] = field(default_factory=list)
    #: Everyone else to tell of a reply or a new thread: the thread's people, the review's author.
    told: List[str] = field(default_factory=list)


def _view(c: ReviewCommentORM) -> Dict[str, Any]:
    gone = c.deleted_at is not None
    return {
        "id": c.id, "threadId": c.thread_id, "entityId": c.entity_id, "path": c.path,
        "body": "" if gone else c.body, "mentions": [] if gone else list(c.mentions or []),
        "author": c.author, "createdAt": c.created_at, "editedAt": c.edited_at,
        "deleted": gone, "resolvedAt": c.resolved_at, "resolvedBy": c.resolved_by,
    }


class ReviewComments:
    def __init__(self, session_factory=db.graphver_session):
        self._session = session_factory

    async def _pr(self, s, pr_id: str) -> MergeRequestORM:
        pr = await s.get(MergeRequestORM, pr_id)
        if pr is None:
            raise CommentRefused("unknown review")
        return pr

    async def _hashes(self, s, pr: MergeRequestORM, ids: Iterable[str]) -> Dict[str, str]:
        """The draft's content hash of each entity — what makes a thread on it outdated."""
        ids = sorted({i for i in ids if i})
        if not ids or not _is_draft_review(pr):
            return {}
        rows = await s.execute(select(EntityHeadORM.entity_id, EntityHeadORM.content_hash).where(
            EntityHeadORM.graph_id == pr.graph_id, EntityHeadORM.branch_id == pr.source_branch_id,
            EntityHeadORM.entity_id.in_(ids)))
        return {eid: h for eid, h in rows.all()}

    async def threads(self, *, pr_id: str, entity_id: Optional[str] = None, general: bool = False,
                      thread_id: Optional[str] = None, state: str = "all", offset: int = 0,
                      limit: int = 50) -> Dict[str, Any]:
        """Threads newest first — one (``thread_id``: what a notification links to), on one change
        (``entity_id``), on the review as a whole (``general``), or all — each with its replies in
        order and whether the change was edited since it was written (``outdated``). ``state``:
        open, resolved or all."""
        async with self._session() as s:
            pr = await self._pr(s, pr_id)
            roots = select(ReviewCommentORM).where(ReviewCommentORM.pr_id == pr_id,
                                                   ReviewCommentORM.id == ReviewCommentORM.thread_id)
            if thread_id is not None:
                roots = roots.where(ReviewCommentORM.id == thread_id)
            elif entity_id is not None:
                roots = roots.where(ReviewCommentORM.entity_id == entity_id)
            elif general:
                roots = roots.where(ReviewCommentORM.entity_id.is_(None))
            if state == "open":
                roots = roots.where(ReviewCommentORM.resolved_at.is_(None))
            elif state == "resolved":
                roots = roots.where(ReviewCommentORM.resolved_at.is_not(None))
            total = (await s.execute(select(func.count()).select_from(roots.subquery()))).scalar_one()
            page = (await s.execute(roots.order_by(ReviewCommentORM.created_at.desc(), ReviewCommentORM.id)
                                    .offset(offset).limit(limit))).scalars().all()
            ids = [r.id for r in page]
            replies = (await s.execute(select(ReviewCommentORM).where(
                ReviewCommentORM.thread_id.in_(ids), ReviewCommentORM.id != ReviewCommentORM.thread_id,
            ).order_by(ReviewCommentORM.created_at, ReviewCommentORM.id))).scalars().all() if ids else []
            now = await self._hashes(s, pr, (r.entity_id for r in page))
        by_thread: Dict[str, List[Dict[str, Any]]] = {}
        for r in replies:
            by_thread.setdefault(r.thread_id, []).append(_view(r))
        out = []
        for r in page:
            outdated = bool(r.entity_id and r.entity_hash and now.get(r.entity_id, r.entity_hash) != r.entity_hash)
            out.append({**_view(r), "replies": by_thread.get(r.id, []), "outdated": outdated})
        return {"threads": out, "total": total, "offset": offset, "limit": limit,
                "hasMore": offset + len(out) < total}

    async def counts(self, *, pr_id: str) -> Dict[str, Any]:
        """Per change with comments: ``{entityId: {open, total}}`` threads, plus the review's own."""
        async with self._session() as s:
            rows = (await s.execute(select(
                ReviewCommentORM.entity_id,
                func.count(),
                func.count().filter(ReviewCommentORM.resolved_at.is_(None)),
            ).where(ReviewCommentORM.pr_id == pr_id, ReviewCommentORM.id == ReviewCommentORM.thread_id,
                    ReviewCommentORM.deleted_at.is_(None))
              .group_by(ReviewCommentORM.entity_id))).all()
        by_entity = {eid: {"open": int(o), "total": int(t)} for eid, t, o in rows if eid}
        general = next(({"open": int(o), "total": int(t)} for eid, t, o in rows if not eid), {"open": 0, "total": 0})
        return {"entities": by_entity, "general": general,
                "open": sum(c["open"] for c in by_entity.values()) + general["open"]}

    async def post(self, *, pr_id: str, actor: str, body: str, entity_id: Optional[str] = None,
                   path: Optional[str] = None, thread_id: Optional[str] = None,
                   mentions: Sequence[str] = ()) -> Posted:
        """A new thread (on a change, a field of it, or the review), or — ``thread_id`` — a reply,
        which reopens nothing and is on what its thread is on."""
        text = (body or "").strip()
        if not text:
            raise CommentRefused("Write something first.")
        if len(text) > MAX_BODY:
            raise CommentRefused(f"A comment holds up to {MAX_BODY:,} characters.")
        wanted = list(dict.fromkeys(m for m in mentions if m and m != actor))[:MAX_MENTIONS]
        async with self._session() as s:
            pr = await self._pr(s, pr_id)
            root: Optional[ReviewCommentORM] = None
            if thread_id:
                root = await s.get(ReviewCommentORM, thread_id)
                if root is None or root.pr_id != pr_id or root.id != root.thread_id:
                    raise CommentRefused("That thread isn't on this review.")
                entity_id, path = root.entity_id, root.path
            hashes = await self._hashes(s, pr, [entity_id] if entity_id else [])
            new_id = prefixed_id("rc")
            row = ReviewCommentORM(
                id=new_id, thread_id=root.id if root else new_id, pr_id=pr_id, graph_id=pr.target_graph_id,
                entity_id=entity_id, path=path or None, body=text, mentions=wanted or None, author=actor,
                entity_hash=hashes.get(entity_id or ""), created_at=_now())
            s.add(row)
            await s.flush()
            people: List[str] = []
            if root is not None:
                people = [a for (a,) in (await s.execute(select(ReviewCommentORM.author).where(
                    ReviewCommentORM.thread_id == root.id).distinct())).all()]
            told = [p for p in dict.fromkeys([*people, pr.actor or ""]) if p and p != actor and p not in wanted]
            view = _view(row)
        return Posted(comment={**view, "replies": [], "outdated": False}, mentioned=wanted, told=told)

    async def edit(self, *, pr_id: str, comment_id: str, actor: str, body: str) -> Dict[str, Any]:
        text = (body or "").strip()
        if not text or len(text) > MAX_BODY:
            raise CommentRefused("A comment holds 1 to 10,000 characters.")
        async with self._session() as s:
            c = await s.get(ReviewCommentORM, comment_id)
            if c is None or c.pr_id != pr_id or c.deleted_at:
                raise CommentRefused("That comment isn't on this review.")
            if c.author != actor:
                raise NotYours("Only its author edits a comment.")
            c.body, c.edited_at = text, _now()
            return _view(c)

    async def delete(self, *, pr_id: str, comment_id: str, actor: str, may_moderate: bool) -> None:
        async with self._session() as s:
            c = await s.get(ReviewCommentORM, comment_id)
            if c is None or c.pr_id != pr_id:
                raise CommentRefused("That comment isn't on this review.")
            if c.author != actor and not may_moderate:
                raise NotYours("Only its author, or someone who manages the data source, deletes a comment.")
            c.deleted_at = c.deleted_at or _now()

    async def resolve(self, *, pr_id: str, thread_id: str, actor: str, resolved: bool) -> Dict[str, Any]:
        async with self._session() as s:
            root = await s.get(ReviewCommentORM, thread_id)
            if root is None or root.pr_id != pr_id or root.id != root.thread_id:
                raise CommentRefused("That thread isn't on this review.")
            root.resolved_at, root.resolved_by = (_now(), actor) if resolved else (None, None)
            return _view(root)


def mention_candidates_filter(ids: Iterable[str], allowed: Iterable[str]) -> List[str]:
    """The mentioned ids that may be mentioned (the workspace's people), in order, once."""
    ok = set(allowed)
    return [i for i in dict.fromkeys(ids) if i in ok]


__all__ = ["ReviewComments", "CommentRefused", "NotYours", "Posted", "mention_candidates_filter",
           "MAX_BODY"]


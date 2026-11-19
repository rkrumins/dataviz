"""What changed in a versioned graph since someone last looked, and telling the people who watch it.

Read when someone opens a graph (``GET …/graphs/{id}/digest``, :func:`read`), never on a read's
path: ``main``'s versions after their seen marker, newest first and capped, each with what it
recorded of itself (``commits.stats``); the reviews that wait on them; and the entities they watch
that changed. Every query is bounded and indexed: the versions a LIMIT on ``uq_commits_branch_seq``;
the watched entities ``ix_nv_urn``, then one ``ix_nv_entity_hist`` probe each; the reviews the live
ones asking them or a team of theirs (``ix_rr_graph``), from the review records, each decided as the
review inbox's ``needs_review`` decides it (``review_state.waits_on``).

After a publish, an undo or a restore commits (``main_activity.note`` → :func:`note`), each person
watching the graph, or an entity the version changed, who may still read it is told in their Inbox:
one notification each, however much of what they watch it changed, and never its author. An author
who had seen everything before it has seen it too: their marker moves to it. All of that is best
effort, bounded in time, and never fails the commit it follows.
"""
from __future__ import annotations

import asyncio
import logging
from collections import Counter
from datetime import datetime, timezone
from itertools import takewhile
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from sqlalchemy import Text, and_, column, func, or_, select, true, values

from . import db, review_state
from .change_index import stat_changes
from .models import BranchORM, CommitORM, GraphORM, MergeRequestORM, NodeVersionORM, ReviewRequestORM

logger = logging.getLogger(__name__)

#: The versions a digest lists, newest first; past them it says ``truncated``.
VERSIONS_MAX = 50
#: The reviews waiting on someone that a digest lists.
REVIEWS_MAX = 20
#: The live reviews asking someone that a digest reads to find those waiting on them.
ASKED_MAX = 200
#: What a watcher is told of: versions a person published (a draft's, a review's or a fork's
#: publish, an undo, a restore). Syncs, imports and writes straight to main show in the digest.
TOLD_OF = ("squash_publish", "revert", "restore")
#: How long telling the watchers of one version may take, after its commit.
TELL_TIMEOUT_SECS = 5.0
#: Watchers told, and committed, at a time.
_TELL_CHUNK = 50
KIND = "watch.new_version"
_STATS_KEYS = ("create", "update", "delete", "nodes", "edges")
_ENDED = ("merged", "closed", "merging")


def counts_of(stats: Any) -> Optional[Dict[str, int]]:
    """``{added, changed, removed}`` a version recorded of itself (``stat_changes``: an import or
    genesis records what it brought in), or None where it recorded nothing — never zeros made up."""
    if not isinstance(stats, Mapping) or not any(k in stats for k in _STATS_KEYS):
        return None
    added, changed, removed = stat_changes(stats)
    return {"added": added, "changed": changed, "removed": removed}


def _at(text: Optional[str]) -> Optional[datetime]:
    """A stored ISO time, as UTC where it names no zone; None for one that can't be read."""
    try:
        at = datetime.fromisoformat(str(text))
    except (TypeError, ValueError):
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


async def _main_id(s, graph_id: str) -> str:
    return (await s.execute(select(BranchORM.id).where(
        BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalar_one()


async def read(svc, *, graph_id: str, after: Optional[int], cutoff: datetime, actor: str,
               urns: Sequence[str], limit: Optional[int] = None) -> Dict[str, Any]:
    """What ``actor`` hasn't seen of ``graph_id``'s published line: its versions after ``after``
    (their marker), or — with none, or one past the head (of an earlier graph of the data source) —
    those published since ``cutoff``. ``urns``: the entities they watch in it.

    ``{head: {seq, commitId}, after, versions: [row], truncated, total, reviews, reviewsMore,
    watched}``; ``after`` None means the ``cutoff`` window. ``total``: how many versions the window
    holds — ``main``'s versions are numbered one after another, so ``head - after`` past a marker;
    in the time window, exact unless ``truncated`` (None). ``limit``: ``VERSIONS_MAX``."""
    limit = limit or VERSIONS_MAX
    async with svc._bounded_session() as s:
        graph = await s.get(GraphORM, graph_id)
        if graph is None:
            raise ValueError(f"unknown graph {graph_id}")
        head = graph.main_head_commit_seq or 0
        main_id = await _main_id(s, graph_id)
        if after is not None and after > head:
            after = None
        q = (select(CommitORM.commit_seq, CommitORM.id, CommitORM.kind, CommitORM.message,
                    CommitORM.actor, CommitORM.created_at, CommitORM.stats)
             .where(CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                    CommitORM.commit_seq <= head))
        if after is not None:
            q = q.where(CommitORM.commit_seq > after)
        # Newest first up to the cap — the time window is cut here, not in SQL, where a filter on
        # the time would scan every older version for the ones it rules out.
        rows = (await s.execute(q.order_by(CommitORM.commit_seq.desc()).limit(limit + 1))).all()
        if after is None:
            rows = list(takewhile(lambda r: (_at(r.created_at) or cutoff) >= cutoff, rows))
        truncated = len(rows) > limit
        rows = rows[:limit]
        if rows and rows[0].commit_seq == head:
            head_id = rows[0].id
        else:
            head_id = await s.scalar(select(CommitORM.id).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                CommitORM.commit_seq == head))
        lo = after if after is not None else (rows[-1].commit_seq - 1 if rows else head)
        watched = await _watched_changes(s, graph_id, main_id, urns, lo, head) if urns else []
        reviews, more = await _reviews_waiting(svc, s, graph_id, actor)
    total = head - after if after is not None else (None if truncated else len(rows))
    return {
        "head": {"seq": head, "commitId": head_id}, "after": after, "truncated": truncated,
        "total": total, "reviews": reviews, "reviewsMore": more, "watched": watched,
        "versions": [{"seq": r.commit_seq, "commitId": r.id, "kind": r.kind, "message": r.message,
                      "actor": r.actor, "at": r.created_at, "counts": counts_of(r.stats)}
                     for r in rows],
    }


def authors(versions: Sequence[Mapping[str, Any]]) -> List[Tuple[Optional[str], int]]:
    """Who published ``versions`` and how many each, most first (then the most recent first)."""
    tally = Counter(v["actor"] for v in versions)
    order = {a: i for i, a in reversed(list(enumerate(v["actor"] for v in versions)))}
    return sorted(tally.items(), key=lambda kv: (-kv[1], order[kv[0]]))


async def _entities_named(s, graph_id: str, urns: Sequence[str]) -> Dict[str, str]:
    """entity id → the watched urn a version of it was ever named by (``ix_nv_urn``). Through
    every version, as a deleted entity's tombstone carries no urn."""
    named = (await s.execute(select(NodeVersionORM.entity_id, NodeVersionORM.urn).where(
        NodeVersionORM.graph_id == graph_id, NodeVersionORM.urn.in_(sorted(set(urns))),
    ).distinct())).all()
    out: Dict[str, str] = {}
    for eid, urn in sorted(named):
        out.setdefault(eid, urn)
    return out


def _one_each(graph_id: str, ids: Sequence[str], *where, newest: bool = True):
    """Each of ``ids``' last (``newest``) or first version meeting ``where``: one probe of
    ``ix_nv_entity_hist`` each (``LATERAL … LIMIT 1``), however long its history or however many
    entities the window's versions changed."""
    e = values(column("id", Text), name="e").data([(i,) for i in ids])
    v = (select(NodeVersionORM.entity_id, NodeVersionORM.commit_seq, NodeVersionORM.op,
                NodeVersionORM.display_name, NodeVersionORM.created_at)
         .where(NodeVersionORM.graph_id == graph_id, NodeVersionORM.entity_id == e.c.id, *where)
         .order_by(NodeVersionORM.commit_seq.desc() if newest else NodeVersionORM.commit_seq)
         .limit(1).lateral("v"))
    return select(v).select_from(e.join(v, true()))


async def _watched_changes(s, graph_id: str, main_id: str, urns: Sequence[str], lo: int,
                           hi: int) -> List[Dict[str, Any]]:
    """The watched entities (``urns``) that ``main`` changed after ``lo`` up to ``hi``: ``{urn,
    entityId, name, change, seq, at}``, ``change`` from the window's first and last version of it
    (``added``, ``changed``, ``removed``), ``seq`` / ``at`` its last; most recent first."""
    if hi <= lo or not urns:
        return []
    by_entity = await _entities_named(s, graph_id, urns)
    if not by_entity:
        return []
    # ``main`` as an expression no index can serve: ``ix_nv_branch_changeset`` would otherwise be
    # picked for a narrow window, and read every row of a large version for each entity while the
    # statistics don't know it yet (right after it is published).
    window = (func.coalesce(NodeVersionORM.branch_id, "") == main_id,
              NodeVersionORM.commit_seq > lo, NodeVersionORM.commit_seq <= hi)
    last = {r.entity_id: r for r in (await s.execute(
        _one_each(graph_id, sorted(by_entity), *window))).all()}
    if not last:
        return []
    first = {r.entity_id: r for r in (await s.execute(
        _one_each(graph_id, sorted(last), *window, newest=False))).all()}
    names = {eid: r.display_name or first[eid].display_name for eid, r in last.items()}
    nameless = sorted(eid for eid, name in names.items() if not name)
    if nameless:                                      # a removed one: the name it last had
        for r in (await s.execute(_one_each(graph_id, nameless, NodeVersionORM.commit_seq <= hi,
                                            NodeVersionORM.display_name.is_not(None)))).all():
            names[r.entity_id] = r.display_name
    out = []
    for eid, r in last.items():
        change = ("removed" if r.op == "delete" else "added" if first[eid].op == "create"
                  else "changed")
        out.append({"urn": by_entity[eid], "entityId": eid, "name": names.get(eid),
                    "change": change, "seq": r.commit_seq, "at": r.created_at})
    # One row per urn: an urn a later entity took again names the one that changed last.
    seen: Set[str] = set()
    ordered = sorted(out, key=lambda w: (-w["seq"], w["urn"]))
    return [w for w in ordered if not (w["urn"] in seen or seen.add(w["urn"]))]


async def _reviews_waiting(svc, s, graph_id: str, actor: str) -> Tuple[List[Dict[str, Any]], bool]:
    """The live reviews into ``graph_id`` that wait on ``actor``, newest first, and whether there are
    more: of those asking them or a team of theirs (``review_requests``), each one the review inbox's
    ``needs_review`` would list (``review_state.waits_on``). A team is looked up only when one is
    asked here; a failed lookup leaves their own requests."""
    from .errors import GroupsUnavailable
    from .service import _load_actor_groups

    groups: Tuple[str, ...] = ()
    if await s.scalar(select(ReviewRequestORM.pr_id).where(
            ReviewRequestORM.graph_id == graph_id, ReviewRequestORM.subject_type == "group").limit(1)):
        try:
            groups = tuple(await _load_actor_groups(actor))
        except GroupsUnavailable:
            groups = ()
    asked = and_(ReviewRequestORM.subject_type == "user", ReviewRequestORM.subject_id == actor)
    if groups:
        asked = or_(asked, and_(ReviewRequestORM.subject_type == "group",
                                ReviewRequestORM.subject_id.in_(sorted(groups))))
    prs = (await s.execute(
        select(MergeRequestORM)
        .where(MergeRequestORM.target_graph_id == graph_id, MergeRequestORM.status.notin_(_ENDED),
               MergeRequestORM.id.in_(select(ReviewRequestORM.pr_id).where(
                   ReviewRequestORM.graph_id == graph_id, asked)))
        .order_by(MergeRequestORM.created_at.desc())
        .limit(ASKED_MAX + 1))).scalars().all()
    read, more = prs[:ASKED_MAX], len(prs) > ASKED_MAX
    requests, events = await svc._review_rows(s, [pr.id for pr in read])
    last = await svc._last_content_seqs(s, read)
    waiting = [pr for pr in read if review_state.waits_on(
        actor, pr.actor, review_state.asked_of(actor, groups, requests[pr.id]),
        review_state.standing(requests[pr.id], events[pr.id], last[pr.id]))]
    return ([{"id": pr.id, "title": pr.title, "author": pr.actor, "at": pr.created_at}
             for pr in waiting[:REVIEWS_MAX]], more or len(waiting) > REVIEWS_MAX)


# ── Telling the people who watch it ───────────────────────────────────────────────────────────
def note(session, graph, commit) -> None:
    """Tell the people watching ``graph`` of ``commit`` once ``session``'s transaction commits
    (``main_activity.note`` calls this where ``main``'s head moves): never if it rolls back."""
    if commit.kind not in TOLD_OF:
        return
    graph_id, workspace_id, data_source_id = graph.id, graph.workspace_id, graph.data_source_id

    async def tell() -> None:
        await tell_watchers(graph_id=graph_id, workspace_id=workspace_id,
                            data_source_id=data_source_id, commit=commit)

    db.after_commit(session, tell)


async def tell_watchers(*, graph_id: str, workspace_id: str, data_source_id: str, commit: Any) -> int:
    """How many people were told of ``commit``. Never raises, and gives up past
    ``TELL_TIMEOUT_SECS``: the version it tells of has landed."""
    try:
        return await asyncio.wait_for(
            _tell(graph_id=graph_id, workspace_id=workspace_id, data_source_id=data_source_id,
                  commit=commit), TELL_TIMEOUT_SECS)
    except Exception:  # noqa: BLE001 — telling people never fails the publish it tells of
        logger.warning("the watchers of %s were not told of version %s", graph_id,
                       getattr(commit, "commit_seq", None), exc_info=True)
        return 0


async def _changed_in(graph_id: str, seq: int, urns: Set[str]) -> Dict[str, Optional[str]]:
    """The watched ``urns`` version ``seq`` of ``main`` changed → each one's name."""
    async with db.graphver_session() as s:
        main_id = await _main_id(s, graph_id)
        changed = await _watched_changes(s, graph_id, main_id, sorted(urns), seq - 1, seq)
    return {w["urn"]: w["name"] for w in changed}


async def _tell(*, graph_id: str, workspace_id: str, data_source_id: str, commit: Any) -> int:
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import WorkspaceDataSourceORM
    from backend.app.db.repositories import graph_watch_repo, notification_repo
    from backend.app.services import permission_service

    seq, actor = commit.commit_seq, commit.actor
    async with get_async_session() as s:
        if actor:
            await graph_watch_repo.advance_if_caught_up(s, actor, data_source_id, seq)
        whole: Set[str] = set()
        entities: Dict[str, Set[str]] = {}
        for user_id, urn in await graph_watch_repo.watchers(s, data_source_id):
            if user_id == actor:
                continue
            if urn is None:
                whole.add(user_id)
            else:
                entities.setdefault(user_id, set()).add(urn)
        if not whole and not entities:
            return 0
        changed = (await _changed_in(graph_id, seq, {u for urns in entities.values() for u in urns})
                   if entities else {})
        ds = await s.get(WorkspaceDataSourceORM, data_source_id)
        label = (ds.label or ds.graph_name or "this graph") if ds is not None else "this graph"
        # Committed a chunk at a time: past the time allowed, those told so far stay told.
        await s.commit()
        n = 0
        by_copy: Dict[Tuple[str, str], List[str]] = {}
        recipients = [u for u in sorted(whole | set(entities))
                      if u in whole or any(urn in changed for urn in entities.get(u, ()))]
        for i, user_id in enumerate(recipients, 1):
            claims = await permission_service.resolve(s, user_id)
            if permission_service.has_permission(claims, "workspace:datasource:read",
                                                 workspace_id=workspace_id):
                names = sorted({changed[u] or u for u in entities.get(user_id, ()) if u in changed})
                by_copy.setdefault(_copy(commit, label, names, whole=user_id in whole),
                                   []).append(user_id)
            if by_copy and (i % _TELL_CHUNK == 0 or i == len(recipients)):
                for (title, body), user_ids in by_copy.items():
                    n += await notification_repo.notify(
                        s, user_ids=user_ids, kind=KIND, title=title, body=body,
                        link=f"/workspaces/{workspace_id}?ds={data_source_id}&dstab=versioning",
                        actor_id=actor, resource_type="data_source", resource_id=data_source_id)
                by_copy = {}
                await s.commit()
        return n


def _listed(names: Sequence[str], shown: int = 3) -> str:
    """"A", "A and B", "A, B and C", "A, B, C and 2 more"."""
    named = [f"“{n}”" for n in names[:shown]]
    rest = len(names) - len(named)
    if rest:
        named.append(f"{rest} more")
    return named[0] if len(named) == 1 else f"{', '.join(named[:-1])} and {named[-1]}"


def _copy(commit: Any, label: str, names: Sequence[str], *, whole: bool) -> Tuple[str, str]:
    """The notification's title and body: the graph's news for someone watching it (naming the
    entities they also watch that it changed), else what it changed of the entities they watch."""
    kind = commit.kind
    if whole:
        title = {"revert": f"A change to “{label}” was undone",
                 "restore": f"“{label}” was restored to an earlier version"}.get(
            kind, f"New version of “{label}”")
    elif len(names) == 1:
        title = f"“{names[0]}” changed in “{label}”"
    else:
        title = f"{len(names)} things you watch changed in “{label}”"
    said = f"Version #{commit.commit_seq}"
    if kind == "squash_publish" and commit.message:
        said += f": “{commit.message}”"
    parts = [said + "."]
    counts = counts_of(commit.stats)
    done = [f"{counts[k]:,} {k}" for k in ("added", "changed", "removed") if counts and counts[k]]
    if done:
        parts.append(", ".join(done) + ".")
    if whole and names:
        parts.append(f"It changed {_listed(names)}, which you watch.")
    elif len(names) > 1:
        parts.append(f"It changed {_listed(names)}.")
    return title, " ".join(parts)

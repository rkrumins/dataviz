"""What changed in a versioned graph since someone last looked, and telling the people who watch it.

Read when someone opens a graph (``GET …/graphs/{id}/digest``, :func:`read`), never on a read's
path: ``main``'s versions after their seen marker, newest first and capped, each with what it
recorded of itself (``commits.stats``); the reviews that wait on them; and the entities they watch
that changed. Every query is bounded and indexed: the versions a LIMIT on ``uq_commits_branch_seq``;
the watched entities ``ix_nv_urn``, then one ``ix_nv_entity_hist`` probe each; the reviews the live
ones asking them or a team of theirs (``ix_rr_graph``), from the review records, each decided as the
review inbox's ``needs_review`` decides it (``review_state.waits_on``).

Telling the people who watch a graph is the versioning worker's (:func:`tell_pending`, every
``TELL_POLL_SECS``), never a commit's: a publish, an undo or a restore commits and answers, whoever
watches. A pass finds each watched graph whose published line moved past its marker
(``graph_watch_told``) and tells, in one round, of every version a person published since (a
draft's, a review's or a fork's publish, an undo, a restore): each person watching the graph, or an
entity those versions changed, who may still read it — at most one unread notification per graph
each, as one still unread already points at the digest, which lists everything since they last
looked — and never anyone of only what they published themselves. A round tells its watchers by
user id, ``TELL_BATCH`` at a time, each batch committed with the marker: a restart carries on where
it stopped, nobody is told twice, and two workers never tell one graph at once (``SKIP LOCKED``).
Their access is decided for each batch at once (``permission_service.resolve_many``).

A commit does one thing more, once it has landed (``main_activity.note`` → :func:`note`): an author
who had seen everything before their own version has seen it too, so their marker moves to it.
"""
from __future__ import annotations

import asyncio
import logging
import time
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass
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
#: How often the versioning worker tells the watchers of the graphs that moved (:func:`tell_pending`).
TELL_POLL_SECS = 2.0
#: How long one pass may tell for; what it leaves, the next tells.
TELL_PASS_SECS = 5.0
#: Watchers told, and committed with their graph's marker, at a time.
TELL_BATCH = 200
#: Ids read at a time, in one IN list: data sources, or the urns watched in a graph.
_AT_ONCE = 1000
#: How long an author's own marker may take to move once their commit has landed.
CAUGHT_UP_TIMEOUT_SECS = 2.0
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
    """Once ``session``'s transaction commits (``main_activity.note`` calls this where ``main``'s
    head moves; never if it rolls back), an author who had seen everything before their own version
    has seen it too. Telling the people watching ``graph`` is the worker's (:func:`tell_pending`)."""
    if commit.kind not in TOLD_OF:
        return
    data_source_id = graph.data_source_id

    async def caught_up() -> None:
        try:
            await asyncio.wait_for(_caught_up(commit.actor, data_source_id, commit.commit_seq),
                                   CAUGHT_UP_TIMEOUT_SECS)
        except Exception:  # noqa: BLE001 — a marker never fails the commit it follows
            logger.warning("the seen marker of %s's author did not move to version %s",
                           data_source_id, getattr(commit, "commit_seq", None), exc_info=True)

    db.after_commit(session, caught_up)


async def _caught_up(actor: Optional[str], data_source_id: str, seq: int) -> None:
    from backend.app.db.engine import get_async_session
    from backend.app.db.repositories import graph_watch_repo

    if not actor:
        return
    async with get_async_session() as s:
        await graph_watch_repo.advance_if_caught_up(s, actor, data_source_id, seq)
        await s.commit()


@dataclass(frozen=True)
class _Watched:
    """A watched graph whose watchers have something to be told, as a pass found it."""
    data_source_id: str
    graph_id: str
    workspace_id: str
    head: int
    told_seq: Optional[int]
    round_to: Optional[int]

    @property
    def untold(self) -> int:
        """Versions past what its watchers were told of (0 for a marker not read yet)."""
        return max(0, self.head - self.told_seq) if self.told_seq is not None else 0


@dataclass(frozen=True)
class _Round:
    """What a round tells of: ``main``'s versions after ``span[0]`` up to ``span[1]`` that a person
    published (``TOLD_OF``) — how many, the latest, who published them, and the windows holding only
    those (for the entities they changed)."""
    span: Tuple[int, int]
    versions: int
    latest: Any
    authors: frozenset
    runs: Tuple[Tuple[int, int], ...]


async def tell_pending(*, budget_secs: Optional[float] = None) -> int:
    """One pass of the worker's telling (every ``TELL_POLL_SECS``): each watched graph whose
    published line moved past its marker has its watchers told, a round each, for at most
    ``budget_secs`` (``TELL_PASS_SECS``); a graph left over, or one that failed, carries on in the
    next pass from where its marker stands. How many were told. Never raises."""
    from backend.app.jobs import metrics

    deadline = time.monotonic() + (TELL_PASS_SECS if budget_secs is None else budget_secs)
    try:
        pending = await _pending()
    except Exception:  # noqa: BLE001 — the next pass reads them again
        logger.warning("which watched graphs moved could not be read", exc_info=True)
        return 0
    told = behind = 0
    for i, g in enumerate(pending):
        if i and time.monotonic() >= deadline:            # each pass moves at least one along
            behind += g.untold
            continue
        try:
            n, done = await _tell_graph(g, deadline)
        except Exception:  # noqa: BLE001 — its marker stands where its last batch left it
            logger.warning("the watchers of %s were not told of versions %s to %s yet",
                           g.graph_id, (g.told_seq or 0) + 1, g.head, exc_info=True)
            n, done = 0, False
        told += n
        if not done:
            behind += g.untold
    metrics.gauge_set("graphver_watch_untold_versions", behind)
    if told:
        metrics.increment("graphver_watch_notified_total", told)
    return told


async def _pending() -> List[_Watched]:
    """The watched graphs whose watchers have something to be told: a round in progress, a marker
    not read yet, or a head past (or, for a graph re-created under its data source, short of) it."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.repositories import graph_watch_repo

    out: List[_Watched] = []
    after = ""
    while True:                                       # the markers, a page at a time
        async with get_async_session() as s:
            marks = await graph_watch_repo.markers(s, after=after, limit=_AT_ONCE)
        heads = await _heads([ds for ds, _told, _to in marks]) if marks else {}
        for ds, told, round_to in marks:
            if ds not in heads:
                continue                              # no versioned graph of it now
            graph_id, workspace_id, head = heads[ds]
            if round_to is not None or told is None or head != told:
                out.append(_Watched(ds, graph_id, workspace_id, head, told, round_to))
        if len(marks) < _AT_ONCE:
            return out
        after = marks[-1][0]


async def _heads(data_source_ids: Sequence[str]) -> Dict[str, Tuple[str, str, int]]:
    """data source → its live versioned graph: ``(graph_id, workspace_id, main's head)``."""
    out: Dict[str, Tuple[str, str, int]] = {}
    async with db.graphver_session() as s:
        for i in range(0, len(data_source_ids), _AT_ONCE):
            for ds, graph_id, workspace_id, head in (await s.execute(
                    select(GraphORM.data_source_id, GraphORM.id, GraphORM.workspace_id,
                           GraphORM.main_head_commit_seq)
                    .where(GraphORM.data_source_id.in_(data_source_ids[i:i + _AT_ONCE]),
                           GraphORM.deleted_at.is_(None)))).all():
                out[ds] = (graph_id, workspace_id, head or 0)
    return out


async def _tell_graph(g: _Watched, deadline: float) -> Tuple[int, bool]:
    """Tell ``g``'s watchers, a batch per transaction holding its marker, until its round is done
    or the pass's time is up: ``(told, done)``. A marker another worker holds is theirs to tell."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.repositories import graph_watch_repo

    told = 0
    people: Optional[List[str]] = None
    watching: Dict[str, Tuple[bool, Set[str]]] = {}
    label = ""
    found: Optional[_Round] = None
    changed: Optional[Dict[str, Optional[str]]] = None
    while True:
        async with get_async_session() as s:
            mark = await graph_watch_repo.claim(s, g.data_source_id)
            if mark is None:
                return told, True
            if mark.told_seq is None or mark.told_seq > g.head or (mark.round_to or 0) > g.head:
                # Not read yet, or kept for an earlier graph of this data source: its watchers are
                # told from the head on, of nothing before.
                mark.told_seq, mark.round_to, mark.round_through = g.head, None, None
                mark.updated_at = datetime.now(timezone.utc)
                await s.commit()
                return told, True
            if mark.round_to is None:
                if mark.told_seq >= g.head:
                    return told, True                 # told already, by another worker
                mark.round_to, mark.round_through = g.head, ""
            if found is None or found.span != (mark.told_seq, mark.round_to):
                found = await _round(g.graph_id, mark.told_seq, mark.round_to)
                changed = None
            if people is None:
                watching = await graph_watch_repo.watchers(s, g.data_source_id)
                people = sorted(watching)
                label = await _label(s, g.data_source_id)
            start = bisect_right(people, mark.round_through or "")
            batch = people[start:start + TELL_BATCH] if found.versions else []
            if not batch:
                mark.told_seq, mark.round_to, mark.round_through = mark.round_to, None, None
                mark.updated_at = datetime.now(timezone.utc)
                await s.commit()
                return told, True
            if changed is None:
                urns = sorted({u for _whole, urns in watching.values() for u in urns})
                changed = await _changed_between(g.graph_id, found.runs, urns) if urns else {}
            told += await _tell_batch(s, g, label, found, batch, watching, changed)
            mark.round_through = batch[-1]
            mark.updated_at = datetime.now(timezone.utc)
            await s.commit()
        if time.monotonic() >= deadline:
            return told, False


async def _label(s, data_source_id: str) -> str:
    from backend.app.db.models import WorkspaceDataSourceORM

    ds = await s.get(WorkspaceDataSourceORM, data_source_id)
    return (ds.label or ds.graph_name or "this graph") if ds is not None else "this graph"


async def _round(graph_id: str, lo: int, hi: int) -> _Round:
    """The versions a person published on ``graph_id``'s ``main`` after ``lo`` up to ``hi``
    (``uq_commits_branch_seq``)."""
    async with db.graphver_session() as s:
        main_id = await _main_id(s, graph_id)
        told = (CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                CommitORM.commit_seq > lo, CommitORM.commit_seq <= hi, CommitORM.kind.in_(TOLD_OF))
        rows = (await s.execute(select(CommitORM.commit_seq, CommitORM.actor).where(*told)
                                .order_by(CommitORM.commit_seq))).all()
        latest = None
        if rows:
            latest = (await s.execute(
                select(CommitORM.commit_seq, CommitORM.kind, CommitORM.actor, CommitORM.message,
                       CommitORM.stats)
                .where(CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                       CommitORM.commit_seq == rows[-1].commit_seq))).one()
    runs: List[Tuple[int, int]] = []
    for seq, _actor in rows:                     # main's versions are numbered one after another
        if runs and runs[-1][1] == seq - 1:
            runs[-1] = (runs[-1][0], seq)
        else:
            runs.append((seq - 1, seq))
    return _Round(span=(lo, hi), versions=len(rows), latest=latest,
                  authors=frozenset(actor for _seq, actor in rows), runs=tuple(runs))


async def _changed_between(graph_id: str, runs: Sequence[Tuple[int, int]],
                           urns: Sequence[str]) -> Dict[str, Optional[str]]:
    """The watched ``urns`` the versions in ``runs`` changed → each one's name, as last named."""
    out: Dict[str, Optional[str]] = {}
    async with db.graphver_session() as s:
        main_id = await _main_id(s, graph_id)
        for lo, hi in runs:
            for i in range(0, len(urns), _AT_ONCE):
                for w in await _watched_changes(s, graph_id, main_id, urns[i:i + _AT_ONCE],
                                                lo, hi):
                    out[w["urn"]] = w["name"]
    return out


async def _tell_batch(s, g: _Watched, label: str, found: _Round, batch: Sequence[str],
                      watching: Mapping[str, Tuple[bool, Set[str]]],
                      changed: Mapping[str, Optional[str]]) -> int:
    """Tell those of ``batch`` with something to be told who may still read the graph, in ``s``'s
    transaction: at most one unread notification per graph each (``dedupe_unread``)."""
    from backend.app.db.repositories import notification_repo
    from backend.app.services import permission_service

    wanted: Dict[str, List[str]] = {}
    for user_id in batch:
        if found.authors == {user_id}:
            continue                                  # told only of what they published themselves
        whole, urns = watching[user_id]
        names = sorted({changed[u] or u for u in urns if u in changed})
        if whole or names:
            wanted[user_id] = names
    if not wanted:
        return 0
    claims = await permission_service.resolve_many(s, wanted)
    by_copy: Dict[Tuple[str, str], List[str]] = {}
    for user_id, names in wanted.items():
        if permission_service.has_permission(claims[user_id], "workspace:datasource:read",
                                             workspace_id=g.workspace_id):
            copy = _copy(found.latest, label, names, whole=watching[user_id][0],
                         versions=found.versions)
            by_copy.setdefault(copy, []).append(user_id)
    sole = next(iter(found.authors)) if len(found.authors) == 1 else None
    n = 0
    for (title, body), user_ids in by_copy.items():
        n += await notification_repo.notify(
            s, user_ids=user_ids, kind=KIND, title=title, body=body,
            link=f"/workspaces/{g.workspace_id}?ds={g.data_source_id}&dstab=versioning&whatsnew=1",
            actor_id=sole, resource_type="data_source", resource_id=g.data_source_id,
            dedupe_unread=True, strict=True)
    return n


def _listed(names: Sequence[str], shown: int = 3) -> str:
    """"A", "A and B", "A, B and C", "A, B, C and 2 more"."""
    named = [f"“{n}”" for n in names[:shown]]
    rest = len(names) - len(named)
    if rest:
        named.append(f"{rest} more")
    return named[0] if len(named) == 1 else f"{', '.join(named[:-1])} and {named[-1]}"


def _copy(commit: Any, label: str, names: Sequence[str], *, whole: bool,
          versions: int = 1) -> Tuple[str, str]:
    """The notification's title and body: the graph's news for someone watching it (naming the
    entities they also watch that it changed), else what it changed of the entities they watch.
    ``versions``: how many a round tells of, ``commit`` the latest of them."""
    kind = commit.kind
    if whole:
        title = (f"{versions:,} new versions of “{label}”" if versions > 1 else
                 {"revert": f"A change to “{label}” was undone",
                  "restore": f"“{label}” was restored to an earlier version"}.get(
                     kind, f"New version of “{label}”"))
    elif len(names) == 1:
        title = f"“{names[0]}” changed in “{label}”"
    else:
        title = f"{len(names)} things you watch changed in “{label}”"
    said = f"Version #{commit.commit_seq}"
    if kind == "squash_publish" and commit.message:
        said += f": “{commit.message}”"
    they = "They" if versions > 1 else "It"
    if versions > 1:
        parts = [f"The latest is v{said[1:]}." if whole else
                 f"In {versions:,} new versions, the latest v{said[1:]}."]
    else:
        parts = [said + "."]
        counts = counts_of(commit.stats)
        done = [f"{counts[k]:,} {k}" for k in ("added", "changed", "removed") if counts and counts[k]]
        if done:
            parts.append(", ".join(done) + ".")
    if whole and names:
        parts.append(f"{they} changed {_listed(names)}, which you watch.")
    elif len(names) > 1:
        parts.append(f"{they} changed {_listed(names)}.")
    return title, " ".join(parts)

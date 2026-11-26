"""What changed in a versioned graph since you last looked, and watching it or an entity in it, over
HTTP (``services/versioning/digest.py``, ``db/repositories/graph_watch_repo.py``).

* ``GET …/graphs/{graph_id}/digest`` — the published versions since your seen marker, newest first
  and capped (or those of the last 7 days, and it says so), who published them, the reviews waiting
  on you and the entities you watch that changed. Read when a graph opens, never on a read's path.
* ``POST …/digest/seen`` ``{seq}`` — "I've seen up to here". The marker only moves forward.
* ``GET`` / ``PUT`` ``{entityUrn? | edgeId?}`` / ``DELETE ?entityUrn= | ?edgeId=`` ``…/watch`` —
  what you watch in the graph: the graph itself, an entity by its urn, or a relationship by its id
  (it has no urn). A publish that changes it tells you.

Each with ``workspace:datasource:read`` in the graph's workspace, on the caller's own rows only: no
route takes a user. None is on the API-key surface (``auth/api_key_surface``): what a person has
seen and watches is their own reading, which automation would only pollute.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import graph_watch_repo
from backend.app.db.repositories.view_repo import resolve_user_ids
from backend.app.services.versioning import digest
from backend.app.services.versioning.service import GraphVersioningService
from backend.auth_service.interface import User

from .versioning import _domain_errors, get_versioning_service, graph_in_workspace

router = APIRouter()

_READ = "workspace:datasource:read"
#: What a digest covers for someone who never marked the graph seen.
WINDOW = timedelta(days=7)


class SeenRequest(BaseModel):
    seq: int = Field(ge=0, description="The version of the published line seen up to")


class WatchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    entity_urn: Optional[str] = Field(default=None, alias="entityUrn", min_length=1, max_length=2048,
                                      description="An entity to watch; absent, the whole graph")
    edge_id: Optional[str] = Field(default=None, alias="edgeId", min_length=1, max_length=2048,
                                   description="A relationship to watch, by its id")

    @model_validator(mode="after")
    def _one_thing(self) -> "WatchRequest":
        _what(self.entity_urn, self.edge_id)
        return self


def _what(entity_urn: Optional[str], edge_id: Optional[str]) -> Tuple[str, Optional[str]]:
    """``(kind, urn)`` the repository keeps a watch by: an entity's urn, a relationship's id, or
    neither (the graph). Both at once names two things: refused."""
    if entity_urn is not None and edge_id is not None:
        raise ValueError("Name an entity (entityUrn) or a relationship (edgeId), not both.")
    return ("edge", edge_id) if edge_id is not None else ("node", entity_urn)


def _iso(at: Optional[datetime]) -> Optional[str]:
    if at is None:
        return None
    return (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).isoformat()


async def _names(session: AsyncSession, ids: Iterable[Optional[str]]) -> Dict[str, Optional[str]]:
    resolved = await resolve_user_ids(session, {i for i in ids if i})
    return {uid: name for uid, (name, _email) in resolved.items()}


@router.get("/digest", summary="What changed since you last looked at this graph")
async def get_digest(
    ws_id: str,
    user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
) -> dict:
    """``{since, window, head, versions, total, truncated, authors, reviewsWaiting, reviewsMore,
    watchedChanged}`` for the caller:

    * ``since`` ``{seq, at}``: their seen marker, and ``window`` ``since_seen``; or null, and
      ``window`` ``last_7_days``: they never marked it seen (or marked an earlier graph of this data
      source), so the versions are those published in the last 7 days;
    * ``head`` ``{seq, version}``: the published line's latest version (``version``: its commit);
    * ``versions``: newest first, at most 50 (``truncated`` past them): ``{seq, version, kind, at,
      author: {id, name}, message, counts}``, ``counts`` ``{added, changed, removed}`` as the
      version recorded them, null where it recorded none; ``author.id`` null: the platform's own;
    * ``total``: how many versions the window holds, null when the time window is truncated;
    * ``authors`` ``{id, name, versions}``: who published the versions listed, most first;
    * ``reviewsWaiting`` ``{id, title, url, author, at}``: live reviews into this graph waiting on
      them, as the review inbox's ``needs_review`` has them: asked of them or of a group of theirs,
      not theirs, and not reviewed by them as it is now;
    * ``watchedChanged``: the entities and relationships they watch that changed in the window (over
      the versions listed when the time window is truncated), most recent first — an entity
      ``{kind: "node", urn, entityId, name, change, seq, at}``, a relationship ``{kind: "edge",
      entityId, edgeType, source, target, change, seq, at}`` with its ends ``{entityId, name}``;
      ``change`` ``added`` / ``changed`` / ``removed``, ``seq`` and ``at`` its last change."""
    ds = meta["data_source_id"]
    marker = await graph_watch_repo.seen(session, user.id, ds)
    rows = [w for w in await graph_watch_repo.watches(session, user.id, ds) if w.entity_urn]
    with _domain_errors():
        got = await digest.read(svc, graph_id=meta["graph_id"],
                                after=marker.seen_seq if marker is not None else None,
                                cutoff=datetime.now(timezone.utc) - WINDOW, actor=user.id,
                                urns=[w.entity_urn for w in rows if w.entity_kind != "edge"],
                                edges=[w.entity_urn for w in rows if w.entity_kind == "edge"])
    since = ({"seq": marker.seen_seq, "at": _iso(marker.seen_at)}
             if marker is not None and got["after"] is not None else None)
    names = await _names(session, [v["actor"] for v in got["versions"]]
                         + [r["author"] for r in got["reviews"]])

    def person(uid: Optional[str]) -> Dict[str, Any]:
        return {"id": uid, "name": names.get(uid) if uid else None}

    return {
        "since": since,
        "window": "since_seen" if since else "last_7_days",
        "head": {"seq": got["head"]["seq"], "version": got["head"]["commitId"]},
        "versions": [{"seq": v["seq"], "version": v["commitId"], "kind": v["kind"], "at": v["at"],
                      "author": person(v["actor"]), "message": v["message"], "counts": v["counts"]}
                     for v in got["versions"]],
        "total": got["total"],
        "truncated": got["truncated"],
        "authors": [{**person(uid), "versions": n} for uid, n in digest.authors(got["versions"])],
        "reviewsWaiting": [{"id": r["id"], "title": r["title"], "author": person(r["author"]),
                            "at": r["at"], "url": f"/workspaces/{ws_id}/reviews?pr={r['id']}"}
                           for r in got["reviews"]],
        "reviewsMore": got["reviewsMore"],
        "watchedChanged": got["watched"],
    }


@router.post("/digest/seen", summary="Mark this graph seen up to a version")
async def mark_digest_seen(
    body: SeenRequest,
    user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Move the caller's marker to ``seq``, a version of the published line: ``{seq, at}``, the
    marker after. It only moves forward — a ``seq`` below it changes nothing — and a version not
    published yet is a 422."""
    head = int(meta.get("main_head_commit_seq") or 0)
    if body.seq > head:
        raise HTTPException(status_code=422, detail={
            "type": "not_published_yet",
            "message": f"There is no version #{body.seq} yet: the latest is #{head}."})
    row = await graph_watch_repo.mark_seen(session, user.id, meta["data_source_id"], body.seq,
                                           head=head)
    return {"seq": row.seen_seq, "at": _iso(row.seen_at)}


def _watching(rows: List[Any]) -> dict:
    """``{graph, entities: [{urn, since}], edges: [{id, since}], entitiesMax}``: whether the caller
    watches the graph, and the entities and relationships in it they watch — ``entitiesMax`` of
    them in all."""
    return {"graph": any(r.entity_urn is None for r in rows),
            "entities": [{"urn": r.entity_urn, "since": _iso(r.created_at)}
                         for r in rows if r.entity_urn is not None and r.entity_kind != "edge"],
            "edges": [{"id": r.entity_urn, "since": _iso(r.created_at)}
                      for r in rows if r.entity_urn is not None and r.entity_kind == "edge"],
            "entitiesMax": graph_watch_repo.ENTITIES_MAX}


@router.get("/watch", summary="What you watch in this graph")
async def get_watch(
    user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """:func:`_watching` for the caller."""
    return _watching(await graph_watch_repo.watches(session, user.id, meta["data_source_id"]))


@router.put("/watch", summary="Watch this graph, or an entity or a relationship in it")
async def put_watch(
    body: Optional[WatchRequest] = None,
    user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Watch the graph (neither named), the entity ``entityUrn`` names or the relationship
    ``edgeId`` does; watching twice is watching once. 409 ``watch_limit`` past ``entitiesMax``
    entities and relationships. Answers :func:`_watching`."""
    ds = meta["data_source_id"]
    kind, urn = _what(body.entity_urn, body.edge_id) if body is not None else ("node", None)
    rows = await graph_watch_repo.watches(session, user.id, ds)
    if urn is not None and (kind, urn) not in {(r.entity_kind, r.entity_urn) for r in rows} \
            and await graph_watch_repo.entity_count(session, user.id, ds) >= graph_watch_repo.ENTITIES_MAX:
        raise HTTPException(status_code=409, detail={
            "type": "watch_limit", "limit": graph_watch_repo.ENTITIES_MAX,
            "message": f"You watch {graph_watch_repo.ENTITIES_MAX} entities and relationships in "
                       "this graph already: stop watching one to watch another."})
    await graph_watch_repo.watch(session, user.id, ds, urn, kind=kind)
    # Its watchers are told of what the graph publishes from now on (``digest.tell_pending``).
    await graph_watch_repo.start_telling(session, ds, int(meta.get("main_head_commit_seq") or 0))
    return _watching(await graph_watch_repo.watches(session, user.id, ds))


@router.delete("/watch", summary="Stop watching this graph, or an entity or a relationship in it")
async def delete_watch(
    entity_urn: Optional[str] = Query(None, alias="entityUrn", min_length=1, max_length=2048),
    edge_id: Optional[str] = Query(None, alias="edgeId", min_length=1, max_length=2048),
    user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Stop watching the graph (neither named), that entity or that relationship; one not watched
    is no change. Answers :func:`_watching`."""
    ds = meta["data_source_id"]
    try:
        kind, urn = _what(entity_urn, edge_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"type": "two_things", "message": str(e)})
    await graph_watch_repo.unwatch(session, user.id, ds, urn, kind=kind)
    return _watching(await graph_watch_repo.watches(session, user.id, ds))

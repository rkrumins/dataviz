"""Questions and conversations about views and data sources.

Routes (mounted from ``api.py`` at ``/discussions``):

  GET    /subjects/{type}/{id}                 threads about a subject (keyset: ?cursor=)
  GET    /subjects/{type}/{id}/summary         counts, unread, watching, latest, byEntity (ETag)
  GET    /summaries?type=&ids=                 open, answered, total, unread for up to 100 cards (ETag)
  GET    /subjects/{type}/{id}/people          who to ask: view owners, data contacts, fallback
  GET    /subjects/{type}/{id}/mentionable     people who can open it, for @mentions
  POST   /subjects/{type}/{id}                 ask (201; 200 replaying a clientKey)
  PUT    /subjects/{type}/{id}/watch           watch it: hear about each new open question
  DELETE /subjects/{type}/{id}/watch           stop watching
  GET    /{id}                                 a thread and its messages (?cursor= older, ?since=)
  POST   /{id}/messages                        reply (201; 200 replaying a clientKey)
  PATCH  /{id}/messages/{mid}                  edit (expectedVersion)
  DELETE /{id}/messages/{mid}                  delete a message
  POST   /{id}/answer, DELETE /{id}/answer     accept, un-accept an answer (expectedVersion)
  POST   /{id}/close, POST /{id}/reopen        (expectedVersion)
  DELETE /{id}                                 delete the question and its thread
  PUT    /{id}/me                              mute, follow
  POST   /{id}/read                            mark read (and its notifications)

and, mounted at ``/me`` (``me_router``):

  GET    /discussions                          ?box=to-me|mine|mentions|watching &status= &cursor=
  GET    /discussions/summary                  unread per box (ETag)
  GET    /watches                              what you watch

``conversationsEnabled`` off makes conversations read-only: asking, replying, editing
and watching are refused ``403 feature_disabled``; reading, marking read, muting,
unfollowing, unwatching, answering, closing and deleting still work. Every route
answers 404 ``not_found`` for what the caller can't see. Rules:
``backend.app.services.discussions``.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, Path, Query, Request, Response, status
from pydantic import StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.common.http_caching import make_etag, maybe_not_modified
from backend.app.db.engine import get_db_session
from backend.app.services.discussions import access, routing, service
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.discussions import (
    AnswerBody,
    AskBody,
    AskResponse,
    EditBody,
    MeState,
    MeStateResponse,
    MentionableResponse,
    MessageResponse,
    ReadResponse,
    ReplyBody,
    SubjectCounts,
    SubjectSummary,
    ThreadDetail,
    ThreadList,
    ThreadResponse,
    VersionBody,
    WatchList,
    WatchResponse,
    WhoToAskResponse,
    MySummary,
)

router = APIRouter()
me_router = APIRouter()

SubjectPath = Literal["view", "data_source"]
#: Subjects one ``/summaries`` call counts, at most: a page of cards.
SUMMARIES_MAX = 100
#: It ships off, so a definition not seeded yet means off too.
_writing = [Depends(require_feature(service.FLAG, default=False))]
_SUBJECT = "/subjects/{subject_type}/{subject_id}"


def _caller(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> access.Caller:
    return access.Caller(user=user, claims=claims)


# ── A subject's conversations ────────────────────────────────────────


@router.get(_SUBJECT, response_model=ThreadList, response_model_by_alias=True)
async def list_threads(
    subject_type: SubjectPath = Path(...),
    subject_id: str = Path(...),
    status_filter: Literal["open", "answered", "closed", "all"] = Query("all", alias="status"),
    entity_id: Optional[str] = Query(None, alias="entityId", max_length=1000),
    mine: bool = Query(False),
    cursor: Optional[str] = Query(None, max_length=500),
    updated_since: Optional[str] = Query(None, alias="updatedSince", max_length=64),
    limit: int = Query(20, ge=1, le=50),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    """The threads about a view or data source the caller may see, most recently active first."""
    return await service.list_for_subject(
        session, caller, subject_type, subject_id, status=status_filter, entity_id=entity_id, mine=mine,
        cursor=cursor, updated_since=updated_since, limit=limit,
    )


@router.get(_SUBJECT + "/summary", response_model=SubjectSummary, response_model_by_alias=True)
async def subject_summary(
    request: Request,
    response: Response,
    subject_type: SubjectPath = Path(...),
    subject_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    """Badges' numbers, polled: a 304 when nothing changed for this caller."""
    summary = await service.subject_summary(session, caller, subject_type, subject_id)
    etag = make_etag("discussion-summary", caller.id, subject_type, subject_id, summary.model_dump_json())
    not_modified = maybe_not_modified(request, etag)
    if not_modified is not None:
        return not_modified
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "private, max-age=0, must-revalidate"
    return summary


@router.get("/summaries", response_model=SubjectCounts, response_model_by_alias=True)
async def subject_summaries(
    request: Request,
    response: Response,
    subject_type: SubjectPath = Query(..., alias="type"),
    ids: list[Annotated[str, StringConstraints(min_length=1, max_length=128)]] = Query(
        ..., min_length=1, max_length=SUMMARIES_MAX),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    """A page of cards' numbers, polled: a 304 when nothing changed for this caller."""
    counts = await service.subject_counts(session, caller, subject_type, ids)
    etag = make_etag("discussion-summaries", caller.id, subject_type, *sorted(set(ids)), counts.model_dump_json())
    not_modified = maybe_not_modified(request, etag)
    if not_modified is not None:
        return not_modified
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "private, max-age=0, must-revalidate"
    return counts


@router.get(_SUBJECT + "/people", response_model=WhoToAskResponse, response_model_by_alias=True)
async def who_to_ask(
    subject_type: SubjectPath = Path(...),
    subject_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    """The people to ask about this view or data source, and whether each can open it."""
    subject = await access.readable_subject(session, caller, subject_type, subject_id)
    readers = await access.readers_of(session, subject)
    return await routing.present(session, await routing.who_to_ask(session, subject, readers))


@router.get(_SUBJECT + "/mentionable", response_model=MentionableResponse, response_model_by_alias=True)
async def mentionable(
    subject_type: SubjectPath = Path(...),
    subject_id: str = Path(...),
    q: str = Query("", max_length=200),
    limit: int = Query(10, ge=1, le=10),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.mentionable(session, caller, subject_type, subject_id, q=q, limit=limit)


@router.post(_SUBJECT, response_model=AskResponse, response_model_by_alias=True,
             status_code=status.HTTP_201_CREATED, dependencies=_writing)
async def ask(
    body: AskBody,
    response: Response,
    subject_type: SubjectPath = Path(...),
    subject_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    """Ask a question. 200 with the original when ``clientKey`` was already used."""
    out, created = await service.ask(session, caller, subject_type, subject_id, body)
    if not created:
        response.status_code = status.HTTP_200_OK
    return out


@router.put(_SUBJECT + "/watch", response_model=WatchResponse, response_model_by_alias=True,
            dependencies=_writing)
async def watch(
    subject_type: SubjectPath = Path(...),
    subject_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return WatchResponse(watching=await service.set_watch(session, caller, subject_type, subject_id, watching=True))


@router.delete(_SUBJECT + "/watch", response_model=WatchResponse, response_model_by_alias=True)
async def unwatch(
    subject_type: SubjectPath = Path(...),
    subject_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return WatchResponse(watching=await service.set_watch(session, caller, subject_type, subject_id, watching=False))


# ── One thread ───────────────────────────────────────────────────────


@router.get("/{discussion_id}", response_model=ThreadDetail, response_model_by_alias=True)
async def get_thread(
    discussion_id: str = Path(...),
    cursor: Optional[str] = Query(None, max_length=500),
    since: Optional[str] = Query(None, max_length=64),
    limit: int = Query(50, ge=1, le=100),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    op = await service.open_thread(session, caller, discussion_id)
    return await service.detail(session, op, cursor=cursor, since=since, limit=limit)


@router.post("/{discussion_id}/messages", response_model=MessageResponse, response_model_by_alias=True,
             status_code=status.HTTP_201_CREATED, dependencies=_writing)
async def reply(
    body: ReplyBody,
    response: Response,
    discussion_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    out, created = await service.reply(session, caller, discussion_id, body)
    if not created:
        response.status_code = status.HTTP_200_OK
    return out


@router.patch("/{discussion_id}/messages/{message_id}", response_model=MessageResponse,
              response_model_by_alias=True, dependencies=_writing)
async def edit_message(
    body: EditBody,
    discussion_id: str = Path(...),
    message_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.edit(session, caller, discussion_id, message_id, body)


@router.delete("/{discussion_id}/messages/{message_id}", response_model=MessageResponse,
               response_model_by_alias=True)
async def delete_message(
    discussion_id: str = Path(...),
    message_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.delete_message(session, caller, discussion_id, message_id)


@router.post("/{discussion_id}/answer", response_model=ThreadResponse, response_model_by_alias=True)
async def accept_answer(
    body: AnswerBody,
    discussion_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.answer(session, caller, discussion_id, body.message_id, body.expected_version)


@router.delete("/{discussion_id}/answer", response_model=ThreadResponse, response_model_by_alias=True)
async def unaccept_answer(
    body: VersionBody,
    discussion_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.unanswer(session, caller, discussion_id, body.expected_version)


@router.post("/{discussion_id}/close", response_model=ThreadResponse, response_model_by_alias=True)
async def close_thread(
    body: VersionBody,
    discussion_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.close(session, caller, discussion_id, body.expected_version)


@router.post("/{discussion_id}/reopen", response_model=ThreadResponse, response_model_by_alias=True)
async def reopen_thread(
    body: VersionBody,
    discussion_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.reopen(session, caller, discussion_id, body.expected_version)


@router.delete("/{discussion_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_thread(
    discussion_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    await service.delete_thread(session, caller, discussion_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{discussion_id}/me", response_model=MeStateResponse, response_model_by_alias=True)
async def set_my_state(
    body: MeState,
    discussion_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    """Mute or follow. Following needs the switch on; muting and unfollowing never do."""
    return await service.set_mine(session, caller, discussion_id, body)


@router.post("/{discussion_id}/read", response_model=ReadResponse, response_model_by_alias=True)
async def mark_read(
    discussion_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return ReadResponse(last_read_at=await service.mark_read(session, caller, discussion_id))


# ── Your own ─────────────────────────────────────────────────────────


@me_router.get("/discussions", response_model=ThreadList, response_model_by_alias=True)
async def my_discussions(
    box: Literal["to-me", "mine", "mentions", "watching"] = Query("to-me"),
    status_filter: Literal["open", "answered", "closed", "all"] = Query("all", alias="status"),
    cursor: Optional[str] = Query(None, max_length=500),
    limit: int = Query(20, ge=1, le=50),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    """Asked of you, asked by you, mentioning you, or on what you watch — most recently active first."""
    return await service.my_threads(session, caller, box=box, status=status_filter, cursor=cursor, limit=limit)


@me_router.get("/discussions/summary", response_model=MySummary, response_model_by_alias=True)
async def my_discussions_summary(
    request: Request,
    response: Response,
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    summary = await service.my_summary(session, caller)
    etag = make_etag("my-discussions", caller.id, summary.model_dump_json())
    not_modified = maybe_not_modified(request, etag)
    if not_modified is not None:
        return not_modified
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "private, max-age=0, must-revalidate"
    return summary


@me_router.get("/watches", response_model=WatchList, response_model_by_alias=True)
async def my_watches(
    cursor: Optional[str] = Query(None, max_length=500),
    limit: int = Query(50, ge=1, le=100),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.list_watches(session, caller, cursor=cursor, limit=limit)

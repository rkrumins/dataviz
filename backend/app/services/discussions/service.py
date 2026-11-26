"""Asking, replying, answering, closing and reading conversations.

Who may do what (``docs/RBAC.md`` → Conversations):

* **ask** — anyone who can open the subject, a person (not a service account);
* **reply** — anyone who sees the thread, while it is not closed;
* **edit** a message — its author, checked against ``expectedVersion``;
* **delete** a message — its author or a workspace admin; the question — its asker or
  a workspace admin, which deletes the thread;
* **accept an answer** — the asker, a maintainer (a view's creator or editor
  grantees; a source's data contacts) or a workspace admin;
* **close / reopen** — the asker, the people asked, maintainers and workspace admins.

Status and answer changes are version-checked: 409 ``stale`` with the thread as it
is, or 200 when it is already in the state asked for. A post carries a ``clientKey``:
the message is inserted in a savepoint before the thread's counters move, and a
retry is answered 200 with the original. Posts are rate-limited per person (20 a
minute; 30 questions an hour → 429 ``rate_limited`` with ``Retry-After``). A body is
1–10,000 characters, a post mentions at most 20 people — each must be able to open
the subject (422 ``cannot_mention``) — a question asks at most 20 more, a thread
holds at most 200 people (422 ``too_many_participants``) and 500 replies.

Notifications never fail a post (each is its own try), skip muted participants and
anyone who can no longer open the subject, and never tell the actor. Outbox events
carry ids only — never what anyone wrote.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Iterable, Optional

from fastapi import HTTPException
from sqlalchemy import exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import feature_disabled
from backend.app.db.models import DiscussionMessageORM, DiscussionORM, DiscussionParticipantORM, NotificationORM
from backend.app.db.repositories import (
    data_source_contact_repo,
    discussion_repo as repo,
    notification_repo,
    outbox_event_repo,
    user_repo,
)
from backend.app.jobs import metrics
from backend.app.services.discussions import access, readers as rd, routing
from backend.app.services.discussions.access import Caller, not_found, refuse, require_person
from backend.app.services.discussions.people import people_map
from backend.app.services.discussions.readers import subject_link, thread_link
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import has_permission
from backend.auth_service.ratelimit import get_account_limiter
from backend.common.service_accounts import is_service_account
from backend.common.models.discussions import (
    AskBody,
    AskResponse,
    EditBody,
    EntityCount,
    MeState,
    MeStateResponse,
    MentionableResponse,
    MentionCandidate,
    Message,
    MessageResponse,
    Mine,
    MySummary,
    NotReached,
    ReplyBody,
    SubjectCount,
    SubjectCounts,
    SubjectRef,
    SubjectSummary,
    ThreadAccess,
    ThreadDetail,
    ThreadList,
    ThreadResponse,
    ThreadSummary,
    ToMe,
    Unread,
    WatchItem,
    WatchList,
    BODY_MAX,
)

logger = logging.getLogger(__name__)

FLAG = "conversationsEnabled"
POST_RATE = "20/minute"
ASK_RATE = "30/hour"
EXCERPT_MAX = 200
#: People named in a private thread's audience, at most.
AUDIENCE_MAX = 50
_HINTS = {
    "creator": "View owner", "editor_grant": "View owner", "named_owner": "Data owner",
    "created_source": "Data owner", "named_steward": "Data steward", "data_request": "Data steward",
    "workspace_admin": "Workspace admin", "org_admin": "Org admin",
}


# ── Small helpers ────────────────────────────────────────────────────


async def switch_on() -> bool:
    return await feature_flags.is_enabled_self_session(FLAG, default=False)


def _text(raw: str) -> str:
    text = (raw or "").strip()
    if not 1 <= len(text) <= BODY_MAX:
        raise refuse(422, "body_invalid", f"A message is 1 to {BODY_MAX:,} characters.")
    return text


def _excerpt(text: str) -> str:
    return " ".join(text.split())[:EXCERPT_MAX]


async def _limit(scope: str, user_id: str, rate: str, message: str) -> None:
    limiter = get_account_limiter()
    if not await limiter.consume(scope, user_id, rate):
        retry = await limiter.retry_after_seconds(scope, user_id, rate, consumed=True)
        raise HTTPException(status_code=429, headers={"Retry-After": str(retry)},
                            detail={"type": "rate_limited", "message": message, "retryAfter": retry})


async def _posting(user_id: str, *, asking: bool) -> None:
    await _limit("discussion_post", user_id, POST_RATE, "You've posted a lot in a short time. Try again in a moment.")
    if asking:
        await _limit("discussion_ask", user_id, ASK_RATE, "You've asked a lot of questions this hour. Try again later.")


async def _mentions(session: AsyncSession, readers: rd.Readers, ids: Iterable[str], author_id: str) -> list[str]:
    """The people a post mentions — each must be able to open the subject."""
    wanted = [i for i in dict.fromkeys(ids) if i and i != author_id]
    can = await readers.among(session, wanted)
    missing = [i for i in wanted if i not in can]
    if missing:
        raise refuse(422, "cannot_mention", "You can only mention people who can open this.", personIds=missing)
    return wanted


async def _tell(session: AsyncSession, user_ids: Iterable[str], *, kind: str, title: str,
                body: Optional[str], link: str, actor_id: str, thread_id: str, dedupe: bool = False) -> None:
    """One kind of notification; a failure is logged and the post goes on."""
    ids = sorted(set(user_ids) - {actor_id})
    if not ids:
        return
    try:
        await notification_repo.notify(
            session, user_ids=ids, kind=kind, title=title, body=body, link=link, actor_id=actor_id,
            resource_type="discussion", resource_id=thread_id, dedupe_unread=dedupe,
        )
    except Exception:  # noqa: BLE001 — telling people never fails what they were told about
        logger.exception("discussion notify failed kind=%s thread=%s", kind, thread_id)


async def _emit(session: AsyncSession, event_type: str, thread: DiscussionORM, actor_id: str, **extra) -> None:
    await outbox_event_repo.emit(
        session, event_type=event_type, aggregate_id=thread.id, aggregate_type="discussion",
        payload={"discussion_id": thread.id, "subject_type": thread.subject_type, "subject_id": thread.subject_id,
                 "visibility": thread.visibility, "actor_id": actor_id, **extra},
    )


async def _name(session: AsyncSession, user_id: str) -> str:
    ident = (await user_repo.get_identities_by_ids(session, [user_id])).get(user_id)
    return (ident["name"] or ident["email"]) if ident else "Someone"


async def _listeners(session: AsyncSession, thread_id: str, readers: rd.Readers, *,
                     also: Iterable[str] = ()) -> set[str]:
    """Participants who hear about the thread: not muted, following it (or among
    ``also``, told whether they follow or not), and still able to open it."""
    also = set(also)
    rows = await repo.participants(session, thread_id)
    wanted = [u for u, p in rows.items() if not p.muted and (p.following or u in also)]
    return await readers.among(session, wanted)


# ── Presenting ───────────────────────────────────────────────────────


async def subject_refs(session: AsyncSession, subjects: Iterable[rd.Subject]) -> dict[tuple[str, str], SubjectRef]:
    subjects = list(subjects)
    names = await rd.workspace_names(session, [s.workspace_id for s in subjects])
    return {
        (s.type, s.id): SubjectRef(type=s.type, id=s.id, name=s.name, workspace_id=s.workspace_id,
                                   workspace_name=names.get(s.workspace_id), link=subject_link(s))
        for s in subjects
    }


def _unread(thread: DiscussionORM, mine: Optional[DiscussionParticipantORM], user_id: str) -> bool:
    return mine is not None and thread.last_message_by != user_id and (
        mine.last_read_at is None or thread.last_activity_at > mine.last_read_at
    )


def _entity_path(body: AskBody) -> Optional[str]:
    """The containers the entity sits in, top first, as JSON; none when it sits in none."""
    names = [n.strip() for n in body.entity_path or [] if n.strip()]
    return json.dumps(names) if names else None


def _summary(thread: DiscussionORM, ref: SubjectRef, recent: list[str],
             mine: Optional[DiscussionParticipantORM], user_id: str) -> dict:
    return dict(
        id=thread.id, subject=ref, entity_id=thread.entity_id, entity_label=thread.entity_label,
        entity_path=repo.names_of(thread.entity_path), entity_type=thread.entity_type,
        visibility=thread.visibility, status=thread.status, asked_by=thread.asked_by, excerpt=thread.excerpt,
        message_count=thread.message_count, participant_ids=recent, participant_count=thread.participant_count,
        answer_message_id=thread.answer_message_id, resolved_by=thread.resolved_by, resolved_at=thread.resolved_at,
        last_activity_at=thread.last_activity_at, last_message_by=thread.last_message_by,
        created_at=thread.created_at, unread=_unread(thread, mine, user_id),
        muted=bool(mine and mine.muted), following=bool(mine and mine.following), version=thread.version,
    )


def _referenced(summaries: Iterable[ThreadSummary]) -> set[str]:
    out: set[str] = set()
    for s in summaries:
        out |= {s.asked_by, s.last_message_by, *s.participant_ids}
        if s.resolved_by:
            out.add(s.resolved_by)
    return out


async def summaries(session: AsyncSession, user_id: str, threads: list[DiscussionORM],
                    refs: dict[tuple[str, str], SubjectRef]) -> list[ThreadSummary]:
    """A page of threads, in a fixed number of reads however long it is."""
    ids = [t.id for t in threads]
    recent = await repo.recent_people(session, ids)
    mine = await repo.mine(session, ids, user_id)
    return [ThreadSummary(**_summary(t, refs[(t.subject_type, t.subject_id)], recent.get(t.id, []),
                                     mine.get(t.id), user_id)) for t in threads]


async def _one_summary(session: AsyncSession, caller: Caller, thread: DiscussionORM,
                       subject: rd.Subject) -> ThreadSummary:
    return (await summaries(session, caller.id, [thread], await subject_refs(session, [subject])))[0]


async def _roles(session: AsyncSession, subject: rd.Subject) -> dict[str, set[str]]:
    """Who wears which badge in a thread about ``subject``."""
    out = {"view_owner": set(), "data_owner": set(), "data_steward": set(), "admin": set()}
    if subject.type == "view":
        out["view_owner"] = await rd.expand(session, await rd.maintainers_of(session, subject))
    source = subject if subject.type == "data_source" else (
        await rd.load_subject(session, "data_source", subject.data_source_id) if subject.data_source_id else None
    )
    if source is not None:
        rows = await data_source_contact_repo.list_for_source(session, source.id)
        if rows:
            for role, key in (("owner", "data_owner"), ("steward", "data_steward")):
                named = rd.Maintainers(frozenset(r.subject_id for r in rows if r.role == role and r.subject_type == "user"),
                                       frozenset(r.subject_id for r in rows if r.role == role and r.subject_type == "group"))
                out[key] = await rd.expand(session, named)
        else:
            creator, known = await rd.derived_contacts(session, source)
            out["data_owner"], out["data_steward"] = ({creator} if creator else set()), set(known)
    out["admin"] = await rd.holders(session, subject.workspace_id, rd.WORKSPACE_ADMIN, global_too=False)
    return out


def _message(m: DiscussionMessageORM, thread: DiscussionORM, roles: dict[str, set[str]]) -> Message:
    gone = m.deleted_at is not None
    badges = (["asker"] if m.author_id == thread.asked_by else []) + [
        r for r in ("view_owner", "data_owner", "data_steward", "admin") if m.author_id in roles[r]
    ]
    return Message(id=m.id, kind=m.kind, author_id=m.author_id, body="" if gone else m.body,
                   mentions=[] if gone else repo.mentions_of(m.mentions), created_at=m.created_at,
                   edited_at=m.edited_at, deleted_at=m.deleted_at, version=m.version, roles=badges)


# ── Opening a thread ─────────────────────────────────────────────────


@dataclass
class Opened:
    caller: Caller
    thread: DiscussionORM
    subject: rd.Subject
    mine: Optional[DiscussionParticipantORM]
    _maint: Optional[rd.Maintainers] = None

    async def maintains(self, session: AsyncSession) -> bool:
        if self._maint is None:
            self._maint = await rd.maintainers_of(session, self.subject)
        return self._maint.includes(self.caller.id, await self.caller.group_ids(session))

    @property
    def admin(self) -> bool:
        return self.caller.is_admin_of(self.subject)

    @property
    def asker(self) -> bool:
        return self.thread.asked_by == self.caller.id

    async def may_answer(self, session: AsyncSession) -> bool:
        return self.asker or self.admin or await self.maintains(session)

    async def may_close(self, session: AsyncSession) -> bool:
        return await self.may_answer(session) or bool(self.mine and self.mine.asked_to)


async def open_thread(session: AsyncSession, caller: Caller, discussion_id: str) -> Opened:
    """The thread, or 404 ``not_found`` — for a thread that is gone, about a subject the
    caller can't open, or private and not theirs to see."""
    thread = await repo.get(session, discussion_id)
    if thread is None or thread.deleted_at is not None or thread.archived_at is not None:
        raise not_found()
    subject = await access.readable_subject(session, caller, thread.subject_type, thread.subject_id)
    mine = await repo.participant(session, thread.id, caller.id)
    if not await access.thread_visible(session, caller, thread, subject, participant=mine):
        raise not_found()
    return Opened(caller=caller, thread=thread, subject=subject, mine=mine)


async def _audience(session: AsyncSession, op: Opened, readers: rd.Readers) -> list[str]:
    """Who can see a private thread: the people in it, the subject's maintainers and the
    workspace's admins — those who can open the subject."""
    ids = set((await repo.participants(session, op.thread.id)).keys())
    ids |= await rd.expand(session, await rd.maintainers_of(session, op.subject))
    ids |= await rd.holders(session, op.subject.workspace_id, rd.WORKSPACE_ADMIN, global_too=False)
    can = await readers.among(session, ids)
    return ([op.thread.asked_by] if op.thread.asked_by in can else []) + sorted(can - {op.thread.asked_by})[:AUDIENCE_MAX]


async def detail(session: AsyncSession, op: Opened, *, cursor: Optional[str] = None, since: Optional[str] = None,
                 limit: int = 50) -> ThreadDetail:
    thread, subject, caller = op.thread, op.subject, op.caller
    try:
        msgs, older = await repo.messages(session, thread.id, cursor=cursor, since=since, limit=limit)
    except repo.InvalidCursor:
        raise refuse(400, "invalid_cursor", "That page cursor isn't one this list gave out.")
    on, person = await switch_on(), not is_service_account(caller.id)
    roles = await _roles(session, subject)
    audience = await _audience(session, op, await rd.readers_of(session, subject)) \
        if thread.visibility == "private" else None
    summary = await _one_summary(session, caller, thread, subject)
    shown = [_message(m, thread, roles) for m in msgs]
    can_edit_contacts = None
    if subject.type == "data_source":
        can_edit_contacts = on and person and has_permission(
            caller.claims, "workspace:datasource:manage", workspace_id=subject.workspace_id)
    access_flags = ThreadAccess(
        can_reply=on and person and thread.status != "closed" and thread.message_count <= repo.REPLIES_MAX,
        can_answer=person and thread.status != "closed" and await op.may_answer(session),
        can_close=person and await op.may_close(session),
        can_moderate=person and op.admin,
        can_edit_contacts=can_edit_contacts,
    )
    ids = _referenced([summary]) | {m.author_id for m in shown} | {u for m in shown for u in m.mentions} \
        | set(audience or [])
    return ThreadDetail(**summary.model_dump(), access=access_flags, private_audience=audience, messages=shown,
                        older_cursor=older, last_read_at=op.mine.last_read_at if op.mine else None,
                        people=await people_map(session, ids))


async def _thread_response(session: AsyncSession, op: Opened) -> ThreadResponse:
    thread = await repo.get(session, op.thread.id)
    summary = await _one_summary(session, op.caller, thread, op.subject)
    return ThreadResponse(thread=summary, people=await people_map(session, _referenced([summary])))


async def _message_response(session: AsyncSession, op: Opened, message_id: str) -> MessageResponse:
    thread = await repo.get(session, op.thread.id)
    m = await repo.message(session, message_id)
    shown = _message(m, thread, await _roles(session, op.subject))
    summary = await _one_summary(session, op.caller, thread, op.subject)
    return MessageResponse(message=shown, thread=summary,
                           people=await people_map(session, _referenced([summary]) | {shown.author_id, *shown.mentions}))


# ── Asking ───────────────────────────────────────────────────────────


async def _replayed_ask(session: AsyncSession, caller: Caller, original: DiscussionMessageORM,
                        subject: rd.Subject) -> AskResponse:
    thread = await repo.get(session, original.discussion_id)
    if original.kind != "question" or thread is None or (thread.subject_type, thread.subject_id) != (
            subject.type, subject.id):
        raise refuse(422, "body_invalid", "That clientKey was already used for another post.")
    op = await open_thread(session, caller, thread.id)
    asked = [p.user_id for p in (await repo.participants(session, thread.id)).values() if p.asked_to]
    return AskResponse(thread=await detail(session, op), reached=sorted(asked))


async def ask(session: AsyncSession, caller: Caller, subject_type: str, subject_id: str,
              body: AskBody) -> tuple[AskResponse, bool]:
    """Ask a question about a subject the caller can open. ``(response, created)`` —
    ``created`` is False for a retry answered with the original."""
    require_person(caller.user)
    subject = await access.readable_subject(session, caller, subject_type, subject_id)
    original = await repo.message_by_key(session, caller.id, body.client_key)
    if original is not None:
        return await _replayed_ask(session, caller, original, subject), False
    text = _text(body.body)
    readers = await rd.readers_of(session, subject)
    mentioned = await _mentions(session, readers, body.mentions, caller.id)
    wta = await routing.who_to_ask(session, subject, readers)
    routed = await routing.route(
        session, subject, wta, view_owners=body.route.view_owners and subject.type == "view",
        data_contacts=body.route.data_contacts, recipient_ids=body.recipient_ids, asker_id=caller.id, readers=readers,
    )
    people = list(dict.fromkeys([caller.id, *routed.reached, *mentioned]))
    if len(people) > repo.PARTICIPANTS_MAX:
        raise refuse(422, "too_many_participants", f"A conversation can include at most {repo.PARTICIPANTS_MAX} people.")
    await _posting(caller.id, asking=True)

    now = repo.now_iso()
    thread = DiscussionORM(
        subject_type=subject.type, subject_id=subject.id, entity_id=body.entity_id or None,
        entity_label=(body.entity_label or None) if body.entity_id else None,
        entity_path=_entity_path(body) if body.entity_id else None,
        entity_type=(body.entity_type or None) if body.entity_id else None, visibility=body.visibility,
        status="open", asked_by=caller.id, excerpt=_excerpt(text), message_count=1, participant_count=len(people),
        last_activity_at=now, last_message_by=caller.id, version=1, created_at=now, updated_at=now,
    )
    try:
        async with session.begin_nested():
            session.add(thread)
            await session.flush()
            session.add(DiscussionMessageORM(discussion_id=thread.id, kind="question", author_id=caller.id,
                                             body=text, mentions=json.dumps(mentioned), client_key=body.client_key,
                                             created_at=now))
            await session.flush()
    except IntegrityError:
        original = await repo.message_by_key(session, caller.id, body.client_key)
        if original is None:
            raise
        return await _replayed_ask(session, caller, original, subject), False

    reached, mentions = set(routed.reached), set(mentioned)
    for uid in people:
        session.add(DiscussionParticipantORM(
            discussion_id=thread.id, user_id=uid, created_at=now,
            joined_via="asked" if uid == caller.id else "asked_to" if uid in reached else "mentioned",
            asked_to=uid in reached, mentioned_at=now if uid in mentions else None,
            last_read_at=now if uid == caller.id else None, posted_at=now if uid == caller.id else None,
        ))
    await session.flush()

    who = await _name(session, caller.id)
    link = thread_link(subject, thread.id)
    await _tell(session, reached - mentions, kind="discussion.asked", title=f"{who} asked you about {subject.name}",
                body=thread.excerpt, link=link, actor_id=caller.id, thread_id=thread.id)
    await _tell(session, mentions, kind="discussion.mentioned",
                title=f"{who} mentioned you in a question about {subject.name}", body=thread.excerpt, link=link,
                actor_id=caller.id, thread_id=thread.id)
    await _emit(session, "collaboration.discussion.asked", thread, caller.id, recipient_count=len(reached),
                used_fallback=routed.used_fallback)
    metrics.increment("discussions_asked_total", subject_type=subject.type, visibility=thread.visibility)
    metrics.observe("discussions_ask_recipients", float(len(reached)))
    logger.info("discussion asked id=%s subject=%s:%s visibility=%s reached=%d not_reached=%d fallback=%s",
                thread.id, subject.type, subject.id, thread.visibility, len(reached), len(routed.not_reached),
                routed.used_fallback)
    op = Opened(caller=caller, thread=thread, subject=subject, mine=await repo.participant(session, thread.id, caller.id))
    return AskResponse(
        thread=await detail(session, op), reached=routed.reached,
        not_reached=[NotReached(person_id=p, reason=why) for p, why in routed.not_reached],
        used_fallback=routed.used_fallback,
    ), True


# ── Replying and editing ─────────────────────────────────────────────


class _Refused(Exception):
    pass


async def _refusal_for_reply(session: AsyncSession, thread_id: str) -> HTTPException:
    thread = await repo.get(session, thread_id)
    if thread is None or thread.deleted_at is not None or thread.archived_at is not None:
        return not_found()
    if thread.status == "closed":
        return refuse(409, "wrong_status", "This conversation is closed. Reopen it to reply.")
    return refuse(422, "too_many_replies", f"This conversation has reached {repo.REPLIES_MAX} replies. "
                                           "Ask a new question to carry on.")


async def _bring_in(session: AsyncSession, op: Opened, user_ids: Iterable[str], joined_via: str, *,
                    now: str, **fields) -> None:
    for uid in user_ids:
        try:
            await repo.join(session, op.thread.id, uid, joined_via, now=now, **fields)
        except repo.TooManyParticipants:
            raise refuse(422, "too_many_participants",
                         f"A conversation can include at most {repo.PARTICIPANTS_MAX} people.")


async def reply(session: AsyncSession, caller: Caller, discussion_id: str,
                body: ReplyBody) -> tuple[MessageResponse, bool]:
    require_person(caller.user)
    original = await repo.message_by_key(session, caller.id, body.client_key)
    op = await open_thread(session, caller, discussion_id)
    if original is not None:
        if original.discussion_id != op.thread.id or original.kind != "reply":
            raise refuse(422, "body_invalid", "That clientKey was already used for another post.")
        return await _message_response(session, op, original.id), False
    if op.thread.status == "closed" or op.thread.message_count > repo.REPLIES_MAX:
        raise await _refusal_for_reply(session, op.thread.id)
    text = _text(body.body)
    readers = await rd.readers_of(session, op.subject)
    mentioned = await _mentions(session, readers, body.mentions, caller.id)
    present = await repo.participants(session, op.thread.id, [caller.id, *mentioned])
    newcomers = [u for u in [caller.id, *mentioned] if u not in present]
    if op.thread.participant_count + len(newcomers) > repo.PARTICIPANTS_MAX:
        raise refuse(422, "too_many_participants", f"A conversation can include at most {repo.PARTICIPANTS_MAX} people.")
    await _posting(caller.id, asking=False)

    now = repo.now_iso()
    msg = DiscussionMessageORM(discussion_id=op.thread.id, kind="reply", author_id=caller.id, body=text,
                               mentions=json.dumps(mentioned), client_key=body.client_key, created_at=now)
    try:
        async with session.begin_nested():
            session.add(msg)
            await session.flush()
            if not await repo.bump_for_reply(session, op.thread.id, author_id=caller.id, now=now):
                raise _Refused()
    except IntegrityError:
        original = await repo.message_by_key(session, caller.id, body.client_key)
        if original is None:
            raise
        return await _message_response(session, op, original.id), False
    except _Refused:
        raise await _refusal_for_reply(session, op.thread.id)

    if caller.id in present:
        me = present[caller.id]
        me.posted_at, me.last_read_at, me.following = now, now, True
    else:
        await _bring_in(session, op, [caller.id], "replied", now=now, posted_at=now, last_read_at=now)
    for uid in mentioned:
        if uid in present:
            present[uid].mentioned_at = now
    await _bring_in(session, op, [u for u in mentioned if u not in present], "mentioned", now=now, mentioned_at=now)
    await session.flush()

    who = await _name(session, caller.id)
    link = thread_link(op.subject, op.thread.id, msg.id)
    listening = await _listeners(session, op.thread.id, readers)
    muted = {u for u, p in (await repo.participants(session, op.thread.id, mentioned)).items() if p.muted}
    await _tell(session, set(mentioned) - muted, kind="discussion.mentioned",
                title=f"{who} mentioned you about {op.subject.name}", body=_excerpt(text), link=link,
                actor_id=caller.id, thread_id=op.thread.id)
    await _tell(session, listening - set(mentioned), kind="discussion.replied",
                title=f"{who} replied about {op.subject.name}", body=_excerpt(text), link=link,
                actor_id=caller.id, thread_id=op.thread.id, dedupe=True)
    metrics.increment("discussions_replies_total", subject_type=op.subject.type)
    return await _message_response(session, op, msg.id), True


async def _own_message(session: AsyncSession, op: Opened, message_id: str) -> DiscussionMessageORM:
    m = await repo.message(session, message_id)
    if m is None or m.discussion_id != op.thread.id:
        raise not_found("message")
    return m


async def edit(session: AsyncSession, caller: Caller, discussion_id: str, message_id: str,
               body: EditBody) -> MessageResponse:
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    m = await _own_message(session, op, message_id)
    if m.author_id != caller.id:
        raise refuse(403, "not_author", "Only whoever wrote a message can edit it.")
    text = _text(body.body)
    readers = await rd.readers_of(session, op.subject)
    mentioned = await _mentions(session, readers, body.mentions, caller.id)
    roles = await _roles(session, op.subject)
    if m.deleted_at is not None or m.version != body.expected_version:
        if m.deleted_at is None and m.body == text and repo.mentions_of(m.mentions) == mentioned:
            return await _message_response(session, op, m.id)          # already says that
        raise refuse(409, "stale", "This message changed since you opened it.",
                     current=_message(m, op.thread, roles).model_dump(by_alias=True))
    new = [u for u in mentioned if u not in repo.mentions_of(m.mentions)]
    present = await repo.participants(session, op.thread.id, new)
    if op.thread.participant_count + len([u for u in new if u not in present]) > repo.PARTICIPANTS_MAX:
        raise refuse(422, "too_many_participants", f"A conversation can include at most {repo.PARTICIPANTS_MAX} people.")
    now = repo.now_iso()
    if not await repo.edit_message(session, m.id, expected_version=body.expected_version, body=text,
                                   mentions=json.dumps(mentioned), edited_at=now):
        current = await repo.message(session, m.id)
        raise refuse(409, "stale", "This message changed since you opened it.",
                     current=_message(current, op.thread, roles).model_dump(by_alias=True))
    await repo.touch(session, op.thread.id, now, **({"excerpt": _excerpt(text)} if m.kind == "question" else {}))
    for uid in new:
        if uid in present:
            present[uid].mentioned_at = now
    await _bring_in(session, op, [u for u in new if u not in present], "mentioned", now=now, mentioned_at=now)
    await session.flush()
    muted = {u for u, p in (await repo.participants(session, op.thread.id, new)).items() if p.muted}
    await _tell(session, set(new) - muted, kind="discussion.mentioned",
                title=f"{await _name(session, caller.id)} mentioned you about {op.subject.name}",
                body=_excerpt(text), link=thread_link(op.subject, op.thread.id, m.id), actor_id=caller.id,
                thread_id=op.thread.id)
    return await _message_response(session, op, m.id)


async def delete_message(session: AsyncSession, caller: Caller, discussion_id: str, message_id: str) -> MessageResponse:
    """Its author or a workspace admin. Deleting the accepted answer un-accepts it; the
    question goes with its thread (:func:`delete_thread`)."""
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    m = await _own_message(session, op, message_id)
    if m.author_id != caller.id and not op.admin:
        raise refuse(403, "not_author", "Only whoever wrote a message, or a workspace admin, can delete it.")
    if m.kind == "question":
        raise refuse(409, "wrong_status", "To remove a question, delete the conversation.")
    if m.deleted_at is None:
        now = repo.now_iso()
        m.deleted_at, m.deleted_by, m.version = now, caller.id, m.version + 1
        await session.flush()
        if not await repo.drop_answer(session, op.thread.id, m.id, now=now):
            await repo.touch(session, op.thread.id, now)
        await outbox_event_repo.emit(
            session, event_type="collaboration.discussion_message.deleted", aggregate_id=m.id,
            aggregate_type="discussion_message",
            payload={"discussion_id": op.thread.id, "message_id": m.id, "author_id": m.author_id,
                     "actor_id": caller.id},
        )
    return await _message_response(session, op, m.id)


# ── Answering, closing, deleting ─────────────────────────────────────


def _stale(summary: ThreadSummary) -> HTTPException:
    return refuse(409, "stale", "This conversation changed since you opened it.",
                  current=summary.model_dump(by_alias=True))


async def _versioned(session: AsyncSession, op: Opened, expected: int, *, already: bool, **values) -> bool:
    """Apply a version-checked change. False when the thread is already in that state
    (an idempotent 200, whatever version was sent); True when it was applied; 409
    ``stale``, with the thread as it is, when it moved on since ``expected``."""
    if already:
        return False
    if op.thread.version == expected and await repo.change(session, op.thread.id, expected_version=expected,
                                                           **values):
        return True
    raise _stale(await _one_summary(session, op.caller, await repo.get(session, op.thread.id), op.subject))


async def answer(session: AsyncSession, caller: Caller, discussion_id: str, message_id: str,
                 expected_version: int) -> ThreadResponse:
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    if not await op.may_answer(session):
        raise refuse(403, "not_allowed", "Only the asker, the people who answer for this, or an admin can accept an answer.")
    if op.thread.status == "closed":
        raise refuse(409, "wrong_status", "This conversation is closed. Reopen it to accept an answer.")
    m = await _own_message(session, op, message_id)
    if m.kind != "reply" or m.deleted_at is not None:
        raise refuse(422, "not_a_reply", "Only a reply that is still there can be the answer.")
    now = repo.now_iso()
    done = await _versioned(session, op, expected_version, already=op.thread.answer_message_id == message_id,
                            status="answered", answer_message_id=message_id, resolved_at=now,
                            resolved_by=caller.id, updated_at=now)
    if done:
        op.thread = await repo.get(session, op.thread.id)
        readers = await rd.readers_of(session, op.subject)
        listening = await _listeners(session, op.thread.id, readers, also={op.thread.asked_by, m.author_id})
        await _tell(session, listening, kind="discussion.answered",
                    title=f"{await _name(session, caller.id)} accepted an answer about {op.subject.name}",
                    body=op.thread.excerpt, link=thread_link(op.subject, op.thread.id, message_id),
                    actor_id=caller.id, thread_id=op.thread.id)
        await _emit(session, "collaboration.discussion.answered", op.thread, caller.id, message_id=message_id)
        metrics.increment("discussions_answered_total", subject_type=op.subject.type)
    return await _thread_response(session, op)


async def unanswer(session: AsyncSession, caller: Caller, discussion_id: str, expected_version: int) -> ThreadResponse:
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    if not await op.may_answer(session):
        raise refuse(403, "not_allowed", "Only the asker, the people who answer for this, or an admin can do that.")
    if op.thread.status == "closed":
        raise refuse(409, "wrong_status", "This conversation is closed. Reopen it first.")
    now = repo.now_iso()
    await _versioned(session, op, expected_version, already=op.thread.answer_message_id is None,
                     status="open", answer_message_id=None, resolved_at=None, resolved_by=None, updated_at=now)
    return await _thread_response(session, op)


async def close(session: AsyncSession, caller: Caller, discussion_id: str, expected_version: int) -> ThreadResponse:
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    if not await op.may_close(session):
        raise refuse(403, "not_allowed", "Only the asker, the people asked, the people who answer for this, "
                                         "or an admin can close it.")
    now = repo.now_iso()
    if await _versioned(session, op, expected_version, already=op.thread.status == "closed",
                        status="closed", resolved_at=now, resolved_by=caller.id, updated_at=now):
        op.thread = await repo.get(session, op.thread.id)
        readers = await rd.readers_of(session, op.subject)
        asker = {op.thread.asked_by}
        await _tell(session, asker & await _listeners(session, op.thread.id, readers, also=asker),
                    kind="discussion.closed",
                    title=f"{await _name(session, caller.id)} closed your question about {op.subject.name}",
                    body=op.thread.excerpt, link=thread_link(op.subject, op.thread.id), actor_id=caller.id,
                    thread_id=op.thread.id)
        await _emit(session, "collaboration.discussion.closed", op.thread, caller.id)
        metrics.increment("discussions_closed_total", subject_type=op.subject.type)
    return await _thread_response(session, op)


async def reopen(session: AsyncSession, caller: Caller, discussion_id: str, expected_version: int) -> ThreadResponse:
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    if not await op.may_close(session):
        raise refuse(403, "not_allowed", "Only the asker, the people asked, the people who answer for this, "
                                         "or an admin can reopen it.")
    now = repo.now_iso()
    if await _versioned(session, op, expected_version, already=op.thread.status != "closed",
                        status="answered" if op.thread.answer_message_id else "open",
                        resolved_at=None, resolved_by=None, updated_at=now):
        await _emit(session, "collaboration.discussion.reopened", op.thread, caller.id)
        metrics.increment("discussions_reopened_total", subject_type=op.subject.type)
    return await _thread_response(session, op)


async def delete_thread(session: AsyncSession, caller: Caller, discussion_id: str) -> None:
    """The asker or a workspace admin deletes the question, and with it the thread and its
    replies."""
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    if not (op.asker or op.admin):
        raise refuse(403, "not_allowed", "Only the asker or a workspace admin can delete a question.")
    now = repo.now_iso()
    await repo.soft_delete(session, op.thread.id, actor_id=caller.id, now=now)
    await repo.soft_delete_messages(session, op.thread.id, actor_id=caller.id, now=now)
    await _emit(session, "collaboration.discussion.deleted", op.thread, caller.id)
    metrics.increment("discussions_deleted_total")


# ── The caller's own state ───────────────────────────────────────────


async def set_mine(session: AsyncSession, caller: Caller, discussion_id: str, body: MeState) -> MeStateResponse:
    """Mute or unmute, follow or unfollow. Following a thread one isn't in joins it."""
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    mine = op.mine
    if mine is None and body.following:
        if not await switch_on():
            raise feature_disabled(FLAG)
        now = repo.now_iso()
        await _bring_in(session, op, [caller.id], "followed", now=now, last_read_at=now, muted=bool(body.muted))
        mine = await repo.participant(session, op.thread.id, caller.id)
    elif mine is not None:
        if body.muted is not None:
            mine.muted = body.muted
        if body.following is not None:
            if body.following and not mine.following and not await switch_on():
                raise feature_disabled(FLAG)
            mine.following = body.following
        await session.flush()
    return MeStateResponse(muted=bool(mine and mine.muted), following=bool(mine and mine.following))


async def mark_read(session: AsyncSession, caller: Caller, discussion_id: str):
    require_person(caller.user)
    op = await open_thread(session, caller, discussion_id)
    await notification_repo.mark_read_for_resource(session, caller.id, resource_type="discussion",
                                                   resource_id=op.thread.id)
    if op.mine is None:
        return None
    op.mine.last_read_at = repo.now_iso()
    await session.flush()
    return op.mine.last_read_at


# ── Subject lists ────────────────────────────────────────────────────


async def _visible_where(session: AsyncSession, caller: Caller, subject: rd.Subject) -> list:
    where = [DiscussionORM.subject_type == subject.type, DiscussionORM.subject_id == subject.id]
    if not await access.sees_every_private_thread(session, caller, subject):
        where.append(access.private_clause(caller.id))
    return where


async def list_for_subject(
    session: AsyncSession, caller: Caller, subject_type: str, subject_id: str, *, status: str,
    entity_id: Optional[str], mine: bool, cursor: Optional[str], updated_since: Optional[str], limit: int,
) -> ThreadList:
    subject = await access.readable_subject(session, caller, subject_type, subject_id)
    visible = await _visible_where(session, caller, subject)
    where = list(visible)
    if status != "all":
        where.append(DiscussionORM.status == status)
    if entity_id:
        where.append(DiscussionORM.entity_id == entity_id)
    if mine:
        where.append(exists().where(DiscussionParticipantORM.discussion_id == DiscussionORM.id,
                                    DiscussionParticipantORM.user_id == caller.id))
    if updated_since:
        where.append(DiscussionORM.updated_at > updated_since)
    try:
        rows, more = await repo.page(session, *where, cursor=cursor, limit=limit)
    except repo.InvalidCursor:
        raise refuse(400, "invalid_cursor", "That page cursor isn't one this list gave out.")
    latest = await repo.latest(session, *visible)
    shown = await summaries(session, caller.id, rows, await subject_refs(session, [subject]))
    return ThreadList(
        threads=shown, latest=latest,
        next_cursor=repo.encode_cursor(rows[-1].last_activity_at, rows[-1].id) if more else None,
        people=await people_map(session, _referenced(shown)),
    )


async def subject_summary(session: AsyncSession, caller: Caller, subject_type: str, subject_id: str) -> SubjectSummary:
    subject = await access.readable_subject(session, caller, subject_type, subject_id)
    visible = await _visible_where(session, caller, subject)
    by_status, latest, by_entity = await repo.counts(session, *visible)
    return SubjectSummary(
        open=by_status.get("open", 0), answered=by_status.get("answered", 0), closed=by_status.get("closed", 0),
        total=sum(by_status.values()), unread=await repo.count_unread(session, caller.id, *visible),
        watching=await repo.is_watching(session, caller.id, subject.type, subject.id), latest=latest,
        by_entity={k: EntityCount(**v) for k, v in by_entity.items()},
    )


async def subject_counts(session: AsyncSession, caller: Caller, subject_type: str,
                         subject_ids: Iterable[str]) -> SubjectCounts:
    """:func:`subject_summary`'s counts for many subjects of one type — a page of cards —
    in a fixed number of reads: the counts in one GROUP BY, which of them the caller can
    open in one id-correlated pass, the unread in one more, and — only where a private
    thread is in question — who sees every one in one more. Unreadable subjects, and those
    with nothing the caller can see, are left out."""
    rows = await repo.counts_by_subject(session, subject_type, subject_ids, access.private_clause(caller.id))
    readable = sorted(i for _t, i in await access.readable_subject_ids(session, caller, {(subject_type, i) for i in rows}))
    if not readable:
        return SubjectCounts()
    hidden = {(subject_type, i) for i in readable if any(n > seen for n, seen in rows[i].values())}
    sees_all = await access.sees_every_private_thread_on(
        session, caller, (await rd.load_subjects(session, hidden)).values()) if hidden else set()
    # An unread thread is one the caller is in, so it is one they see either way.
    unread = await repo.unread_by_subject(session, caller.id, subject_type, readable)
    out: dict[str, SubjectCount] = {}
    for i in readable:
        n = {status: every if (subject_type, i) in sees_all else seen for status, (every, seen) in rows[i].items()}
        if sum(n.values()):
            out[i] = SubjectCount(open=n.get("open", 0), answered=n.get("answered", 0), total=sum(n.values()),
                                  unread=unread.get(i, 0))
    return SubjectCounts(summaries=out)


async def mentionable(session: AsyncSession, caller: Caller, subject_type: str, subject_id: str, *,
                      q: str, limit: int) -> MentionableResponse:
    """Up to ``limit`` people who can open the subject, matching ``q`` — or, with no
    ``q``, the people to ask about it — each with what they are to it."""
    subject = await access.readable_subject(session, caller, subject_type, subject_id)
    readers = await rd.readers_of(session, subject)
    wta = await routing.who_to_ask(session, subject, readers)
    hints: dict[str, str] = {}
    for r in wta.everyone():
        hints.setdefault(r.person_id, _HINTS[r.via])
    q = (q or "").strip()
    if q:
        found = [u.id for u in await user_repo.search_users(session, q=q, limit=200)]
    else:
        found = [r.person_id for r in wta.everyone() if r.can_read]
    can = await readers.among(session, found)
    ids = [u for u in dict.fromkeys(found) if u in can and u != caller.id][:limit]
    people = await people_map(session, ids)
    return MentionableResponse(people=[MentionCandidate(**people[u].model_dump(), hint=hints.get(u)) for u in ids])


# ── Watching ─────────────────────────────────────────────────────────


async def set_watch(session: AsyncSession, caller: Caller, subject_type: str, subject_id: str, *,
                    watching: bool) -> bool:
    """Watch (the route checks the switch) or unwatch a subject the caller can open.
    Unwatching works on a subject that has since gone, or is no longer readable."""
    require_person(caller.user)
    if not watching:
        await repo.unwatch(session, caller.id, subject_type, subject_id)
        return False
    subject = await access.readable_subject(session, caller, subject_type, subject_id)
    await repo.watch(session, caller.id, subject.type, subject.id, now=repo.now_iso())
    return True


#: Rows one request reads ahead past subjects the caller can no longer open, at most.
_READ_AHEAD = 3


async def _readable_page(session: AsyncSession, caller: Caller, fetch, ref, *, cursor: Optional[str],
                         limit: int, at) -> tuple[list, Optional[str], dict[tuple[str, str], rd.Subject]]:
    """A page of rows whose subjects the caller can still open, reading ahead past the
    rest (up to :data:`_READ_AHEAD` batches). The next cursor is the last row examined, so
    what was skipped is not read again."""
    shown, last, more = [], None, False
    for _ in range(_READ_AHEAD):
        try:
            rows, more = await fetch(cursor, limit)
        except repo.InvalidCursor:
            raise refuse(400, "invalid_cursor", "That page cursor isn't one this list gave out.")
        if not rows:
            more = False
            break
        readable = await access.readable_subject_ids(session, caller, {ref(r) for r in rows})
        for i, r in enumerate(rows):
            last = r
            if ref(r) in readable:
                shown.append(r)
            if len(shown) == limit:
                more = more or i < len(rows) - 1
                break
        if len(shown) == limit or not more:
            break
        cursor = repo.encode_cursor(*at(last))
    subjects = await rd.load_subjects(session, {ref(r) for r in shown})
    return shown, repo.encode_cursor(*at(last)) if more and last is not None else None, subjects


async def list_watches(session: AsyncSession, caller: Caller, *, cursor: Optional[str], limit: int) -> WatchList:
    rows, next_cursor, subjects = await _readable_page(
        session, caller, lambda c, n: repo.watches_page(session, caller.id, cursor=c, limit=n),
        lambda r: (r.subject_type, r.subject_id), cursor=cursor, limit=limit, at=lambda r: (r.created_at, r.id),
    )
    refs = await subject_refs(session, subjects.values())
    counts = await repo.open_counts(session, subjects.keys(), caller.id)
    return WatchList(items=[
        WatchItem(subject=refs[(r.subject_type, r.subject_id)], created_at=r.created_at,
                  open=counts.get((r.subject_type, r.subject_id), 0))
        for r in rows if (r.subject_type, r.subject_id) in refs
    ], next_cursor=next_cursor)


# ── Your own conversations ───────────────────────────────────────────


async def my_threads(session: AsyncSession, caller: Caller, *, box: str, status: str, cursor: Optional[str],
                     limit: int) -> ThreadList:
    """Threads asked of the caller, by them, mentioning them, or on what they watch —
    those about subjects they can still open."""
    where = [repo.box(box, caller.id)]
    if status != "all":
        where.append(DiscussionORM.status == status)
    rows, next_cursor, subjects = await _readable_page(
        session, caller, lambda c, n: repo.page(session, *where, cursor=c, limit=n),
        lambda t: (t.subject_type, t.subject_id), cursor=cursor, limit=limit,
        at=lambda t: (t.last_activity_at, t.id),
    )
    shown = await summaries(session, caller.id, rows, await subject_refs(session, subjects.values()))
    return ThreadList(threads=shown, next_cursor=next_cursor, people=await people_map(session, _referenced(shown)))


async def my_summary(session: AsyncSession, caller: Caller) -> MySummary:
    """What is waiting for the caller, box by box, counted only on subjects they can
    still open. Watching counts the unread notices of new questions on what they watch."""
    rows = await repo.my_counts(session, caller.id)
    readable = await access.readable_subject_ids(session, caller, {(r[0], r[1]) for r in rows})
    sums = [0] * 6
    for r in rows:
        if (r[0], r[1]) in readable:
            sums = [a + int(b or 0) for a, b in zip(sums, r[2:])]
    to_me_unread, waiting, mine_unread, mine_open, mentions_unread, unread = sums
    watched = await _unread_watched(session, caller.id)
    return MySummary(
        to_me=ToMe(unread=to_me_unread, waiting=waiting), mine=Mine(unread=mine_unread, open=mine_open),
        mentions=Unread(unread=mentions_unread), watching=Unread(unread=watched), total_unread=unread + watched,
    )


async def _unread_watched(session: AsyncSession, user_id: str) -> int:
    return int((await session.execute(select(func.count()).select_from(NotificationORM).where(
        NotificationORM.user_id == user_id, NotificationORM.kind == "discussion.watched",
        NotificationORM.read_at.is_(None),
    ))).scalar() or 0)


__all__ = [
    "ask", "reply", "edit", "delete_message", "answer", "unanswer", "close", "reopen", "delete_thread",
    "set_mine", "mark_read", "list_for_subject", "subject_summary", "subject_counts", "mentionable", "open_thread",
    "detail",
    "summaries", "subject_refs", "thread_link", "subject_link", "switch_on", "FLAG", "set_watch",
    "list_watches", "my_threads", "my_summary",
]

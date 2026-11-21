"""Wire shapes for questions and conversations about views and data sources, and for a
data source's named data contacts. camelCase on the wire (``response_model_by_alias``).

What the routes do: ``backend.app.api.v1.endpoints.discussions``,
``…endpoints.data_source_contacts`` and ``…endpoints.people``.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

SubjectType = Literal["view", "data_source"]
#: How someone came to be named as a person to ask.
PersonVia = Literal[
    "creator", "editor_grant", "named_owner", "named_steward", "created_source", "data_request",
    "workspace_admin", "org_admin",
]
Provenance = Literal["named", "derived", "fallback"]


class _Wire(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class Person(_Wire):
    """Someone a payload names. ``deleted`` marks a former member (their name stays)."""
    id: str
    display_name: str
    email: Optional[str] = None
    avatar_id: Optional[str] = None
    has_image: bool = False
    deleted: bool = False


PeopleMap = dict[str, Person]


class PersonRole(_Wire):
    """One person to ask, and why: ``via`` (and the group, when it was through one), and
    whether they can open the subject at all."""
    person_id: str
    via: PersonVia
    group_id: Optional[str] = None
    group_name: Optional[str] = None
    can_read: bool = False


class DataContactsPeople(_Wire):
    owner: Optional[PersonRole] = None
    stewards: list[PersonRole] = Field(default_factory=list)
    provenance: Provenance


class WhoToAskResponse(_Wire):
    """``GET /discussions/subjects/{type}/{id}/people``. ``fallback`` is who a question
    goes to when nobody above can be reached: the workspace's admins, else Org Admins.
    ``truncated`` counts the members of groups left out past the 50-member cut."""
    view_owners: list[PersonRole] = Field(default_factory=list)
    data_contacts: DataContactsPeople
    fallback: list[PersonRole] = Field(default_factory=list)
    truncated: int = 0
    people: PeopleMap = Field(default_factory=dict)


# ── Data contacts ────────────────────────────────────────────────────


class ContactRef(_Wire):
    subject_type: Literal["user", "group"]
    subject_id: str = Field(min_length=1, max_length=200)


class ContactEntry(_Wire):
    subject_type: Literal["user", "group"]
    subject_id: str
    name: str
    member_count: Optional[int] = None
    via: PersonVia


class DataContactsResponse(_Wire):
    """``GET``/``PUT /admin/workspaces/{ws}/data-sources/{ds}/contacts``."""
    owner: Optional[ContactEntry] = None
    stewards: list[ContactEntry] = Field(default_factory=list)
    provenance: Provenance
    updated_at: Optional[str] = None
    can_edit: bool = False
    can_edit_owner: bool = False
    people: PeopleMap = Field(default_factory=dict)


class DataContactsUpdate(_Wire):
    """The whole set: the Owner (or none) and up to ten Stewards. ``expectedUpdatedAt`` is
    the ``updatedAt`` the editor last read (``null`` when nobody was named yet)."""
    owner: Optional[ContactRef] = None
    stewards: list[ContactRef] = Field(default_factory=list, max_length=50)
    expected_updated_at: Optional[str] = None


# ── Threads ──────────────────────────────────────────────────────────

Visibility = Literal["open", "private"]
DiscussionStatus = Literal["open", "answered", "closed"]
MessageRole = Literal["asker", "view_owner", "data_owner", "data_steward", "admin"]
BODY_MAX = 10_000
MENTIONS_MAX = 20


def _key():
    """The client's key for a post: long enough for a UUID, short enough to index."""
    return Field(min_length=1, max_length=100)


def _body():
    """Bodies are checked (1–10,000 characters once trimmed) by the service, which says
    so as ``body_invalid``; this bound only keeps an absurd payload from being parsed."""
    return Field(max_length=BODY_MAX * 2)


class SubjectRef(_Wire):
    type: SubjectType
    id: str
    name: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    link: str


class ThreadSummary(_Wire):
    """A thread as lists show it. ``participantIds``: up to six, most recently active
    first. ``resolvedBy`` / ``resolvedAt``: who accepted its answer or closed it, and when."""
    id: str
    subject: SubjectRef
    entity_id: Optional[str] = None
    entity_label: Optional[str] = None
    visibility: Visibility
    status: DiscussionStatus
    asked_by: str
    excerpt: str
    message_count: int
    participant_ids: list[str] = Field(default_factory=list)
    participant_count: int
    answer_message_id: Optional[str] = None
    resolved_by: Optional[str] = None
    resolved_at: Optional[str] = None
    last_activity_at: str
    last_message_by: str
    created_at: str
    unread: bool = False
    muted: bool = False
    following: bool = False
    version: int


class Message(_Wire):
    id: str
    kind: Literal["question", "reply"]
    author_id: str
    body: str
    mentions: list[str] = Field(default_factory=list)
    created_at: str
    edited_at: Optional[str] = None
    deleted_at: Optional[str] = None
    version: int
    roles: list[MessageRole] = Field(default_factory=list)


class ThreadAccess(_Wire):
    can_reply: bool = False
    can_answer: bool = False
    can_close: bool = False
    can_moderate: bool = False
    can_edit_contacts: Optional[bool] = None


class ThreadDetail(ThreadSummary):
    access: ThreadAccess
    private_audience: Optional[list[str]] = None
    messages: list[Message] = Field(default_factory=list)
    older_cursor: Optional[str] = None
    last_read_at: Optional[str] = None
    people: PeopleMap = Field(default_factory=dict)


class ThreadList(_Wire):
    threads: list[ThreadSummary]
    next_cursor: Optional[str] = None
    latest: Optional[str] = None
    people: PeopleMap = Field(default_factory=dict)


class EntityCount(_Wire):
    open: int
    total: int


class SubjectSummary(_Wire):
    open: int = 0
    answered: int = 0
    closed: int = 0
    total: int = 0
    unread: int = 0
    watching: bool = False
    latest: Optional[str] = None
    by_entity: dict[str, EntityCount] = Field(default_factory=dict)


class MentionCandidate(Person):
    hint: Optional[str] = None


class MentionableResponse(_Wire):
    people: list[MentionCandidate]


class Route(_Wire):
    view_owners: bool = True
    data_contacts: bool = True


class AskBody(_Wire):
    body: str = _body()
    visibility: Visibility = "open"
    route: Route = Field(default_factory=Route)
    recipient_ids: list[str] = Field(default_factory=list, max_length=20)
    mentions: list[str] = Field(default_factory=list, max_length=MENTIONS_MAX)
    entity_id: Optional[str] = Field(default=None, max_length=1000)
    entity_label: Optional[str] = Field(default=None, max_length=500)
    client_key: str = _key()


class NotReached(_Wire):
    person_id: str
    reason: Literal["cannot_read", "not_a_person", "inactive", "group_too_large"]


class AskResponse(_Wire):
    thread: ThreadDetail
    reached: list[str] = Field(default_factory=list)
    not_reached: list[NotReached] = Field(default_factory=list)
    used_fallback: bool = False


class ReplyBody(_Wire):
    body: str = _body()
    mentions: list[str] = Field(default_factory=list, max_length=MENTIONS_MAX)
    client_key: str = _key()


class EditBody(_Wire):
    body: str = _body()
    mentions: list[str] = Field(default_factory=list, max_length=MENTIONS_MAX)
    expected_version: int


class MessageResponse(_Wire):
    message: Message
    thread: ThreadSummary
    people: PeopleMap = Field(default_factory=dict)


class AnswerBody(_Wire):
    message_id: str
    expected_version: int


class VersionBody(_Wire):
    expected_version: int


class ThreadResponse(_Wire):
    thread: ThreadSummary
    people: PeopleMap = Field(default_factory=dict)


class MeState(_Wire):
    muted: Optional[bool] = None
    following: Optional[bool] = None


class MeStateResponse(_Wire):
    muted: bool
    following: bool


class ReadResponse(_Wire):
    last_read_at: Optional[str] = None


class WatchResponse(_Wire):
    watching: bool


# ── Your own conversations, watches and profiles ─────────────────────


class Unread(_Wire):
    unread: int = 0


class ToMe(Unread):
    #: Asked of you, still open, and you haven't replied.
    waiting: int = 0


class Mine(Unread):
    open: int = 0


class MySummary(_Wire):
    """``GET /me/discussions/summary``."""
    to_me: ToMe = Field(default_factory=ToMe)
    mine: Mine = Field(default_factory=Mine)
    mentions: Unread = Field(default_factory=Unread)
    watching: Unread = Field(default_factory=Unread)
    total_unread: int = 0


class WatchItem(_Wire):
    subject: SubjectRef
    created_at: str
    open: int = 0


class WatchList(_Wire):
    items: list[WatchItem]
    next_cursor: Optional[str] = None


class ProfilePerson(Person):
    is_service_account: bool = False


class NamedRef(_Wire):
    id: str
    name: str


class ProfileDataContact(_Wire):
    data_source_id: str
    data_source_name: str
    workspace_id: str
    workspace_name: Optional[str] = None
    role: Literal["owner", "steward"]
    via: Literal["direct", "group"]


class ProfileResponse(_Wire):
    """``GET /people/{userId}``: scoped to what the reader can see."""
    person: ProfilePerson
    is_me: bool
    workspaces_they_run: list[NamedRef] = Field(default_factory=list)
    data_contacts: list[ProfileDataContact] = Field(default_factory=list)

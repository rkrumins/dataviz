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

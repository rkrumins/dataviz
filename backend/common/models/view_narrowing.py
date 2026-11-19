"""A view's saved narrowings: a reader's Narrow, kept with the view and shared.

A narrowing is a membership spec (``view_membership.MembershipSpec``) under a
name, listed for everyone who can open the view and opened by its id. It keeps
what it held when it was saved — the URNs, gzipped, and the counts — so
opening it runs it again live and says what changed since.
"""
from __future__ import annotations

from typing import Annotated, Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from backend.common.models.view_membership import MembershipCounts, MembershipTruncation

#: Narrowings one view keeps, and one person may save on it.
NARROWINGS_PER_VIEW = 200
NARROWINGS_PER_USER = 50

#: A narrowing's id, made by the client.
NARROWING_ID = r"^[A-Za-z0-9_-]{8,32}$"

#: The spec as stored (canonical JSON).
SPEC_MAX_BYTES = 64 * 1024
#: Names kept for the seeds, so a list can show them before the graph answers.
SEED_NAMES_MAX = 200

#: The URNs held: gzipped, and once unzipped.
HELD_GZIP_MAX_BYTES = 2 * 1024 * 1024
HELD_TEXT_MAX_BYTES = 8 * 1024 * 1024
HELD_LINES_MAX = 60_000
HELD_LINE_MAX_BYTES = 1024


_Urn = Annotated[str, StringConstraints(min_length=1, max_length=HELD_LINE_MAX_BYTES)]
_SeedName = Annotated[str, StringConstraints(max_length=120)]


class _Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class HeldInput(_Base):
    """What the narrowing held when saved: the URNs, one a line, gzipped and
    base64-encoded. The server sorts them, drops repeats and counts them
    itself."""
    count: int = Field(ge=0)
    complete: bool = Field(description="False when the narrowing held more than it listed.")
    urns_gzip: str = Field(alias="urnsGzip")


class SavedNarrowingInput(_Base):
    """What a client writes. The spec is checked as a membership spec; a
    query seed, as the search it runs."""
    name: str = Field(min_length=1, max_length=120)
    spec: Dict[str, Any]
    seeds_label: Optional[str] = Field(None, alias="seedsLabel", max_length=500)
    seed_names: Optional[Dict[_Urn, _SeedName]] = Field(None, alias="seedNames", max_length=SEED_NAMES_MAX)
    counts: Optional[MembershipCounts] = None
    truncated: Optional[List[MembershipTruncation]] = Field(None, max_length=20)
    data_version: Optional[str] = Field(None, alias="dataVersion", max_length=200)
    held: Optional[HeldInput] = None


class HeldSummary(_Base):
    """What was held: how many, whether that was all of it, and whether the
    URNs are kept (``GET …/held``)."""
    count: int = 0
    complete: bool = True
    kept: bool = False


class SavedNarrowing(_Base):
    id: str
    view_id: str = Field(alias="viewId")
    name: str
    spec: Dict[str, Any]
    seeds_label: Optional[str] = Field(None, alias="seedsLabel")
    seed_names: Optional[Dict[str, str]] = Field(None, alias="seedNames")
    counts: Optional[Dict[str, Any]] = None
    truncated: Optional[List[Dict[str, Any]]] = None
    data_version: Optional[str] = Field(None, alias="dataVersion")
    held: HeldSummary = Field(default_factory=HeldSummary)
    created_by: Optional[str] = Field(None, alias="createdBy")
    created_at: Optional[str] = Field(None, alias="createdAt")
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    can_change: bool = Field(False, alias="canChange",
                             description="The caller saved it, or may edit the view.")


class NarrowingLimits(_Base):
    per_view: int = Field(NARROWINGS_PER_VIEW, alias="perView")
    per_user: int = Field(NARROWINGS_PER_USER, alias="perUser")


class SavedNarrowingList(_Base):
    items: List[SavedNarrowing] = Field(default_factory=list)
    can_edit: bool = Field(False, alias="canEdit")
    limits: NarrowingLimits = Field(default_factory=NarrowingLimits)

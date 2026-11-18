"""Member sets — everything a membership spec names, resolved in full and kept to be read.

``POST /{ws_id}/graph/members`` answers a scope inside one request, up to a cap: the
Narrow filter's question. A member set answers the same question COMPLETELY, on graphs
of millions of entities — every source and consumer the seeds reach, a query seed's
every match — so it can be listed page by page and downloaded whole. It takes as many
requests as it takes: send the same body with the returned ``setId`` until ``status``
is ``complete``; that answer carries a ``downloadToken``. Everyone asking the same
question on the same data shares one set.

The spec is the one contract (``backend/common/models/view_membership.py``), counts
and truncations are its shapes, and ``via`` / ``hops`` mean what they mean there.
"""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from backend.common.models.view_membership import (
    MembershipCounts,
    MembershipSpec,
    MembershipTruncation,
    Via,
)

#: Rows one page of ``/members`` lists.
PAGE_MAX = 5000

SetStatus = Literal["running", "complete", "failed", "expired"]
SetStage = Literal["seeds", "inside", "upstream", "downstream", "partnerInside", "done"]


class _Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class MemberSetRequest(_Base):
    """``POST /{ws_id}/graph/member-sets`` — start a set, or move one on.

    ``setId`` continues the set an earlier answer named (it must be the same spec in
    the same scope); without it, the set for this question on the current data is
    found or started. ``includeEdges`` keeps the lineage between members too.
    ``waitMs`` is how long this request works on it before answering with how far
    it has got."""
    spec: MembershipSpec
    include_edges: bool = Field(False, alias="includeEdges")
    set_id: Optional[str] = Field(None, alias="setId", max_length=64)
    wait_ms: int = Field(10_000, alias="waitMs", ge=0, le=30_000)


class MemberSetProgress(_Base):
    """``steps`` taken so far; ``queued`` — entities waiting to be walked in the
    direction being walked now (0 outside a lineage stage)."""
    steps: int = 0
    queued: int = 0


class MemberSetStatus(_Base):
    """A member set and how far it has got. ``counts`` are the same parts a
    resolution counts (``total`` is every member so far); ``truncated`` every
    limit it reached. ``downloadToken`` — on a complete set only — is good for
    an hour, for the person it was issued to."""
    set_id: str = Field(alias="setId")
    spec_hash: str = Field(alias="specHash")
    status: SetStatus
    stage: SetStage
    counts: MembershipCounts = Field(default_factory=MembershipCounts)
    missing_seeds: int = Field(0, alias="missingSeeds")
    truncated: List[MembershipTruncation] = Field(default_factory=list)
    data_version: str = Field("", alias="dataVersion")
    progress: MemberSetProgress = Field(default_factory=MemberSetProgress)
    started_at: str = Field(alias="startedAt")
    completed_at: Optional[str] = Field(None, alias="completedAt")
    expires_at: Optional[str] = Field(None, alias="expiresAt")
    download_token: Optional[str] = Field(None, alias="downloadToken")


class MemberSetMember(_Base):
    """One member: why it is in (``via``), its distance for that reason (``hops``),
    its distance each way when that way was walked, and the seed it is nearest."""
    urn: str
    via: Via
    hops: Optional[int] = None
    hops_up: Optional[int] = Field(None, alias="hopsUp")
    hops_down: Optional[int] = Field(None, alias="hopsDown")
    name: Optional[str] = None
    type: Optional[str] = None
    nearest_seed: Optional[str] = Field(None, alias="nearestSeed")


class MemberSetPage(_Base):
    """``GET …/member-sets/{setId}/members`` — members in the order they joined.
    ``next`` is the ``after`` of the next page, absent on the last."""
    members: List[MemberSetMember] = Field(default_factory=list)
    next: Optional[int] = None

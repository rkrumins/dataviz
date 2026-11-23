"""Where a review stands: who has approved it and whether that still holds, who has asked for
changes and whether that still holds, and whether its approvals meet the rule — read from what is
on record (``review_requests``, ``review_events``) and the draft's last content commit, ``L``.

* A reviewer's **verdict** is their latest approve, request for changes or withdrawal (a comment is
  feedback, not a verdict). An approval **stands** while nothing has changed the draft since
  (``head_seq >= L``); one given before approvals were tied to a head never does. A request for
  changes **holds** while the draft has not changed since (``head_seq >= L``) — the author changing
  it hands the review back.
* A person asked is **satisfied** by their own approval that stands; a group asked, by any approval
  that stands and answers for it (``groups``, recorded when it was given).
* The **rule** (``requiredApprovals``): 0 — everyone asked must approve, and a review that asks no one
  needs no approval (it reads approved once someone's approval stands); N — at least N approvals
  that stand, from anyone who may approve.

Pure: callers read the rows, and ``L`` (``GraphVersioningService._last_content_seq``), once per
review.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence

GATE_VERDICTS = ("approve", "request_changes")


@dataclass(frozen=True)
class ReviewRule:
    """How many approvals a review needs (0: everyone asked), and whether open threads hold it."""

    required_approvals: int = 0
    threads_hold: bool = False


@dataclass
class Standing:
    """Where one review stands. ``subjects`` hold ``(type, id)`` pairs."""

    #: Who approved, by person: ``(at, head_seq, groups, stands)``.
    approvals: Dict[str, dict] = field(default_factory=dict)
    #: Requests for changes, by person, newest first: ``{by, at, reason, headCommitId, headSeq, holds}``.
    change_requests: List[dict] = field(default_factory=list)
    #: Each subject asked: ``{type, id, requestedAt, requestedBy, state, by, at}``.
    reviewers: List[dict] = field(default_factory=list)
    #: Each person's latest review of any verdict: ``{verdict, at, headSeq}``.
    reviewed: Dict[str, dict] = field(default_factory=dict)
    #: L: the draft's last content commit since the earliest verdict (0: none).
    last_content: int = 0

    def current(self, actor: str) -> bool:
        """Whether ``actor``'s latest review is of the draft as it is (nothing changed since)."""
        r = self.reviewed.get(actor)
        return r is not None and r["headSeq"] is not None and int(r["headSeq"]) >= self.last_content

    @property
    def standing(self) -> List[str]:
        return [a for a, v in self.approvals.items() if v["stands"]]

    @property
    def stale(self) -> List[str]:
        return [a for a, v in self.approvals.items() if not v["stands"]]

    @property
    def holding(self) -> List[dict]:
        return [r for r in self.change_requests if r["holds"]]


def since_seq(events: Sequence[Mapping]) -> Optional[int]:
    """The earliest head any verdict was given at: ``L`` need only be read after it."""
    seqs = [int(e["head_seq"]) for e in events
            if e.get("kind") == "reviewed" and e.get("head_seq") is not None]
    return min(seqs) if seqs else None


def standing(requests: Sequence[Mapping], events: Sequence[Mapping], last_content: int, *,
             live: bool = True) -> Standing:
    """Where a review stands. ``requests``: ``review_requests`` rows as dicts; ``events``: its
    ``review_events`` rows as dicts, oldest first; ``last_content``: L (0 when nothing changed the
    draft since the earliest verdict); ``live``: not merged or closed (a request for changes holds
    only on a live review)."""
    out = Standing(last_content=last_content)
    gate: Dict[str, Mapping] = {}
    for e in events:
        actor = e["actor"]
        if e["kind"] == "withdrew":
            gate.pop(actor, None)
        elif e["kind"] == "reviewed":
            out.reviewed[actor] = {"verdict": e.get("verdict"), "at": e.get("created_at"),
                                   "headSeq": e.get("head_seq")}
            if e.get("verdict") in GATE_VERDICTS:
                gate[actor] = e
    for actor, e in gate.items():
        head = e.get("head_seq")
        current = head is not None and int(head) >= last_content
        if e["verdict"] == "approve":
            out.approvals[actor] = {"at": e.get("created_at"), "headSeq": head,
                                    "groups": list(e.get("groups") or []), "stands": current}
        else:
            out.change_requests.append({
                "by": actor, "at": e.get("created_at"), "reason": e.get("body"),
                "headCommitId": e.get("head_commit_id"), "headSeq": head,
                "holds": live and (int(head or 0) >= last_content)})
    out.change_requests.sort(key=lambda r: r["at"] or "", reverse=True)
    for r in requests:
        kind, sid = r["subject_type"], r["subject_id"]
        item = {"type": kind, "id": sid, "requestedAt": r.get("requested_at"),
                "requestedBy": r.get("requested_by"), "state": "waiting", "by": None, "at": None}
        if kind == "user":
            a = out.approvals.get(sid)
            held = next((c for c in out.change_requests if c["by"] == sid and c["holds"]), None)
            if a is not None:
                item.update(state="approved" if a["stands"] else "approved_earlier", by=sid, at=a["at"])
            elif held is not None:
                item.update(state="changes_requested", by=sid, at=held["at"])
            elif (out.reviewed.get(sid) or {}).get("verdict") == "comment" and \
                    (out.reviewed[sid]["at"] or "") >= (r.get("requested_at") or ""):
                item.update(state="commented", by=sid, at=out.reviewed[sid]["at"])
        else:
            answering = [(a, v) for a, v in out.approvals.items() if sid in v["groups"]]
            standing_for = [(a, v) for a, v in answering if v["stands"]]
            pick = standing_for or answering
            if pick:
                a, v = max(pick, key=lambda av: av[1]["at"] or "")
                item.update(state="approved" if standing_for else "approved_earlier", by=a, at=v["at"])
        out.reviewers.append(item)
    return out


def apply_rule(reviewers: Sequence[Mapping], standing_count: int, rule: ReviewRule) -> dict:
    """Whether a review's approvals meet the rule: ``{required, have, satisfied, missing, status}``.
    ``reviewers``: each subject asked with its ``state`` (:func:`standing`); ``standing_count``: how
    many approvals stand. ``missing``: the subjects not yet satisfied (rule 0); ``status``: the
    approval status (``approved`` / ``pending``, or None for a review that needs no approval)."""
    if rule.required_approvals > 0:
        ok = standing_count >= rule.required_approvals
        return {"required": rule.required_approvals, "have": standing_count, "satisfied": ok,
                "missing": [], "status": "approved" if ok else "pending"}
    if not reviewers:                     # asks no one: approved once someone's approval stands
        return {"required": 0, "have": standing_count, "satisfied": True, "missing": [],
                "status": "approved" if standing_count else None}
    missing = [{"type": r["type"], "id": r["id"]} for r in reviewers if r["state"] != "approved"]
    return {"required": len(reviewers), "have": len(reviewers) - len(missing), "satisfied": not missing,
            "missing": missing, "status": "approved" if not missing else "pending"}


def asked_of(me: str, groups, requests: Sequence[Mapping]) -> List[Mapping]:
    """The requests of a review that ask ``me``: their own, or a team's they are in (``groups``)."""
    return [r for r in requests if (r["subject_type"], r["subject_id"]) == ("user", me)
            or (r["subject_type"] == "group" and r["subject_id"] in groups)]


def waits_on(me: str, author: Optional[str], asked: Sequence[Mapping], st: Standing) -> bool:
    """Whether a live review waits on ``me``, as the review inbox's ``needs_review`` has it: they
    are ``asked`` (:func:`asked_of`), it isn't theirs (``author``), and a request of theirs still
    waits for them to review it as it is now. A team's request waits on its members until one of
    them approves it, since it was asked."""
    if not asked or author == me:
        return False
    by_subject = {(x["type"], x["id"]): x for x in st.reviewers}
    waiting = [r for r in asked if r["subject_type"] == "user" or not (
        (g := by_subject.get(("group", r["subject_id"]))) and g["state"] == "approved"
        and (g["at"] or "") >= (r["requested_at"] or ""))]
    mine = st.reviewed.get(me)
    return bool(waiting) and not (mine is not None and st.current(me) and all(
        (mine["at"] or "") >= (r["requested_at"] or "") for r in waiting))


def shown_status(status: str, approval_status: Optional[str]) -> str:
    """A review's status as its approvals leave it: an otherwise mergeable review reads approved
    once its approvals are met, and back to mergeable when they no longer are."""
    if status == "mergeable" and approval_status == "approved":
        return "approved"
    if status == "approved" and approval_status != "approved":
        return "mergeable"
    return status


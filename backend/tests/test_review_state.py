"""Where a review stands (``review_state``): an approval stands until the draft changes after it; a
request for changes holds until then; a verdict replaces the reviewer's earlier one; a group asked
is satisfied by an approval that answers for it; and the rule — everyone asked, or N of anyone's.
"""
from backend.app.services.versioning.review_state import (ReviewRule, apply_rule, shown_status, since_seq,
                                                         standing)


def _ev(actor, kind="reviewed", verdict=None, head=None, at="2026-01-01T00:00:00", groups=None, body=None):
    return {"actor": actor, "kind": kind, "verdict": verdict, "head_seq": head, "created_at": at,
            "groups": groups, "body": body, "head_commit_id": None}


def _req(kind, sid, at="2026-01-01T00:00:00"):
    return {"subject_type": kind, "subject_id": sid, "requested_at": at, "requested_by": "opener"}


def test_an_approval_stands_until_the_draft_changes():
    events = [_ev("ana", verdict="approve", head=5), _ev("bo", verdict="approve", head=3)]
    st = standing([_req("user", "ana"), _req("user", "bo")], events, last_content=4)
    assert st.standing == ["ana"] and st.stale == ["bo"]
    assert [r["state"] for r in st.reviewers] == ["approved", "approved_earlier"]
    assert since_seq(events) == 3
    # One given before approvals were tied to a head never stands.
    assert standing([], [_ev("cy", verdict="approve", head=None)], 0).stale == ["cy"]


def test_a_verdict_replaces_the_earlier_one_and_withdrawing_clears_it():
    st = standing([], [_ev("ana", verdict="approve", head=5, at="1"),
                       _ev("ana", verdict="request_changes", head=5, at="2", body="fix tier")], 5)
    assert st.standing == [] and st.holding[0]["by"] == "ana" and st.holding[0]["reason"] == "fix tier"
    st = standing([], [_ev("ana", verdict="request_changes", head=5, at="1"),
                       _ev("ana", kind="withdrew", at="2")], 5)
    assert st.change_requests == [] and st.approvals == {}
    # A comment is feedback, not a verdict: it leaves the approval standing.
    st = standing([], [_ev("ana", verdict="approve", head=5, at="1"), _ev("ana", verdict="comment", head=5, at="2")], 5)
    assert st.standing == ["ana"]


def test_several_requests_for_changes_hold_at_once_until_the_draft_changes():
    events = [_ev("ana", verdict="request_changes", head=5, at="1"), _ev("bo", verdict="request_changes", head=5, at="2")]
    assert {r["by"] for r in standing([], events, 5).holding} == {"ana", "bo"}
    assert standing([], events, 6).holding == []               # the author changed it
    assert standing([], events, 5, live=False).holding == []   # a settled review holds nothing


def test_a_group_is_satisfied_by_an_approval_that_answers_for_it():
    reqs = [_req("group", "g_fin"), _req("user", "bo")]
    st = standing(reqs, [_ev("ana", verdict="approve", head=5, groups=["g_fin"])], 5)
    assert st.reviewers[0] == {**st.reviewers[0], "state": "approved", "by": "ana"}
    assert st.reviewers[1]["state"] == "waiting"
    assert apply_rule(st.reviewers, len(st.standing), ReviewRule())["missing"] == [{"type": "user", "id": "bo"}]


def test_the_rule_everyone_asked_or_n_of_anyone():
    st = standing([_req("user", "ana"), _req("user", "bo")], [_ev("ana", verdict="approve", head=5)], 5)
    everyone = apply_rule(st.reviewers, len(st.standing), ReviewRule())
    assert (everyone["required"], everyone["have"], everyone["satisfied"], everyone["status"]) == (2, 1, False, "pending")
    one = apply_rule(st.reviewers, len(st.standing), ReviewRule(required_approvals=1))
    assert (one["satisfied"], one["status"]) == (True, "approved")
    # Asking no one needs no approval — unless the rule asks for some.
    assert apply_rule([], 0, ReviewRule())["status"] is None
    assert (apply_rule([], 1, ReviewRule())["status"], apply_rule([], 1, ReviewRule())["satisfied"]) == ("approved", True)
    assert apply_rule([], 0, ReviewRule(required_approvals=1))["status"] == "pending"


def test_a_comment_answers_only_after_the_request():
    st = standing([_req("user", "bo", at="5")], [_ev("bo", verdict="comment", head=1, at="4")], 1)
    assert st.reviewers[0]["state"] == "waiting"
    st = standing([_req("user", "bo", at="3")], [_ev("bo", verdict="comment", head=1, at="4")], 1)
    assert st.reviewers[0]["state"] == "commented"


def test_the_status_follows_the_approvals():
    assert shown_status("mergeable", "approved") == "approved"
    assert shown_status("approved", "pending") == "mergeable"
    assert shown_status("conflicts", "approved") == "conflicts"

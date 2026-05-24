"""Unit tests for PR merge policy. Pure, no DB."""
from backend.app.services.graph_versioning.pr_policy import (
    ReviewRecord,
    evaluate_mergeability,
    is_approval_stale,
    latest_per_reviewer,
)


def rv(reviewer, state, at, base="B1", head="H1"):
    return ReviewRecord(reviewer, state, at, base, head)


def ev(reviews, base="B1", head="H1", status="open", has_changes=True):
    return evaluate_mergeability(
        status=status, reviews=reviews,
        base_head_commit_id=base, head_head_commit_id=head,
        has_changes=has_changes,
    )


def test_approved_against_current_heads_is_mergeable():
    r = ev([rv("alice", "approved", "2026-01-02")])
    assert r.mergeable and r.reason == "approved"


def test_no_review_not_mergeable():
    assert ev([]).mergeable is False
    assert "no approving review" in ev([]).reason


def test_changes_requested_blocks_even_with_an_approval():
    r = ev([
        rv("alice", "approved", "2026-01-01"),
        rv("bob", "changes_requested", "2026-01-02"),
    ])
    assert r.mergeable is False and "changes requested" in r.reason


def test_later_approval_clears_earlier_changes_requested():
    r = ev([
        rv("bob", "changes_requested", "2026-01-01"),
        rv("bob", "approved", "2026-01-03"),
    ])
    assert r.mergeable is True


def test_later_changes_requested_overrides_earlier_approval():
    r = ev([
        rv("bob", "approved", "2026-01-01"),
        rv("bob", "changes_requested", "2026-01-05"),
    ])
    assert r.mergeable is False


def test_commented_reviews_never_gate():
    r = ev([rv("carol", "commented", "2026-01-09")])
    assert r.mergeable is False  # still no approval
    lpr = latest_per_reviewer([rv("carol", "commented", "2026-01-09")])
    assert lpr == {}


def test_stale_approval_when_base_moved():
    # Approved against B1/H1 but base head is now B2.
    r = ev([rv("alice", "approved", "2026-01-02", base="B1", head="H1")],
           base="B2", head="H1")
    assert r.mergeable is False
    assert "stale" in r.reason and r.stale_reviewers == ["alice"]


def test_stale_approval_when_fork_head_moved():
    r = ev([rv("alice", "approved", "2026-01-02", base="B1", head="H1")],
           base="B1", head="H2")
    assert r.mergeable is False and r.stale_reviewers == ["alice"]


def test_fresh_reapproval_after_advance_makes_mergeable():
    r = ev([
        rv("alice", "approved", "2026-01-02", base="B1", head="H1"),  # stale
        rv("alice", "approved", "2026-01-09", base="B2", head="H2"),  # fresh
    ], base="B2", head="H2")
    assert r.mergeable is True


def test_empty_pr_not_mergeable():
    r = ev([rv("alice", "approved", "2026-01-02")], has_changes=False)
    assert r.mergeable is False and "empty" in r.reason


def test_merged_or_closed_not_mergeable():
    assert ev([rv("a", "approved", "t")], status="merged").mergeable is False
    assert ev([rv("a", "approved", "t")], status="closed").mergeable is False


def test_is_approval_stale_helper():
    a = rv("x", "approved", "t", base="B1", head="H1")
    assert is_approval_stale(a, base_head_commit_id="B1", head_head_commit_id="H1") is False
    assert is_approval_stale(a, base_head_commit_id="B9", head_head_commit_id="H1") is True
    # non-approval reviews are never "stale"
    cr = rv("x", "changes_requested", "t", base="B1", head="H1")
    assert is_approval_stale(cr, base_head_commit_id="B9", head_head_commit_id="H9") is False


def test_null_reviewed_commit_ids_are_stale_unless_current_heads_also_null():
    """Pins the chosen semantic: NULL reviewed commit ids on an approval
    mean "approval is not tied to any concrete state" → treated as stale
    against any non-NULL current head. Only when BOTH sides are NULL
    (degenerate, no commits yet) does an approval count as fresh."""
    a_null = ReviewRecord(
        reviewer="x", state="approved", created_at="t",
        reviewed_base_commit_id=None, reviewed_head_commit_id=None,
    )
    # Against real heads → stale.
    assert is_approval_stale(a_null, base_head_commit_id="B1", head_head_commit_id="H1") is True
    # Both NULL on both sides → not stale (degenerate empty-branch case).
    assert is_approval_stale(a_null, base_head_commit_id=None, head_head_commit_id=None) is False


def test_mergeability_with_null_reviewed_ids_is_blocked():
    """An approval with NULL reviewed commit ids cannot mergeably gate a
    PR against a non-empty branch — the PR is flagged as needing
    re-approval (stale_reviewers populated, not mergeable)."""
    r = evaluate_mergeability(
        status="open",
        reviews=[ReviewRecord(
            reviewer="alice", state="approved", created_at="t",
            reviewed_base_commit_id=None, reviewed_head_commit_id=None,
        )],
        base_head_commit_id="B1", head_head_commit_id="H1",
        has_changes=True,
    )
    assert r.mergeable is False
    assert "alice" in r.stale_reviewers

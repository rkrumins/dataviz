"""People analytics' vocabulary: what counts as activity, what kind it is, what it is called.

Shared by the read path (``people_activity_repo``) and the indexer that folds raw events into
the daily rollup (``people_index_repo``), so the two can never disagree about whether an event
is a sign-in, a trace or an edit — a disagreement that would show as a roster whose totals do
not match the person's own page.
"""
from __future__ import annotations

from typing import Optional

from backend.app.db.repositories.analytics_repo import (
    GRAPH_EXPORT,
    SEARCH_MISS,
    SEARCH_RUN,
    TRACE_EMPTY,
    TRACE_RUN,
    VIEW_OPENED,
)
from backend.app.services.activity import catalogue

FULL = "full"
WORKSPACE = "workspace"
LENSES = (FULL, WORKSPACE)

#: What people do, in the order the charts draw it. Six colour slots and a neutral "Other" —
#: the palette's limit, which is why the tail folds rather than inventing a seventh hue. The
#: client mirrors this list (``activityKinds.ts``) and a test pins the two together.
KINDS: tuple[str, ...] = ("signin", "browse", "trace", "search", "build", "operate", "other")

SIGN_IN = "user.logged_in"
SECTION = "app.section"
_FAILED_SIGN_INS = ("user.login_failed", "user.sso_login_failed")

#: The ``product_events`` read as activity, and what kind each is. Deliberately NOT every
#: allow-listed type: ``version.published``, ``ontology.published``, ``view.import`` and
#: ``view.export`` are the same acts the ledger and ``view_activity_log`` already record, and
#: counting both would credit one publish twice.
USAGE_KINDS: dict[str, str] = {
    VIEW_OPENED: "browse",
    TRACE_RUN: "trace",
    TRACE_EMPTY: "trace",
    SEARCH_RUN: "search",
    SEARCH_MISS: "search",
    GRAPH_EXPORT: "other",
    "docs.feedback": "other",
    "docs.search_miss": "other",
    "tour.completed": "other",
    "tour.skipped": "other",
    "onboarding.step": "other",
}

USAGE_LABELS: dict[str, str] = {
    VIEW_OPENED: "Opened a view",
    TRACE_RUN: "Traced lineage",
    TRACE_EMPTY: "Traced lineage and found none",
    SEARCH_RUN: "Searched the graph",
    SEARCH_MISS: "Searched and found nothing",
    GRAPH_EXPORT: "Exported from the graph",
    "docs.feedback": "Rated a docs page",
    "docs.search_miss": "Searched the docs and found nothing",
    "tour.completed": "Finished a tour",
    "tour.skipped": "Skipped a tour",
    "onboarding.step": "Took an onboarding step",
}

#: ``view_activity_log.action`` → (type key, label, kind). The key is namespaced so it can sit
#: in one distribution with the other two sources without colliding.
_EDIT_META: dict[str, tuple[str, str]] = {
    "created": ("Created a view", "build"),
    "updated": ("Edited a view", "build"),
    "visibility_changed": ("Changed a view's visibility", "build"),
    "shared": ("Shared a view", "build"),
    "unshared": ("Stopped sharing a view", "build"),
    "favourited": ("Favourited a view", "other"),
    "unfavourited": ("Unfavourited a view", "other"),
    "deleted": ("Deleted a view", "build"),
    "restored": ("Restored a view", "build"),
    "data_changed": ("Changed a view's data", "build"),
    "publish_requested": ("Asked to publish a view", "build"),
    "publish_denied": ("Declined a view's publication", "build"),
    "admin_viewed": ("Opened a private view as an admin", "browse"),
    "imported": ("Imported a view", "build"),
    "exported": ("Exported a view", "other"),
    "version_saved": ("Saved a view version", "build"),
    "version_restored": ("Restored a view version", "build"),
    "moved": ("Moved a view", "build"),
}
_EDIT_PREFIX = "edit."

#: An admin opening a PRIVATE view is auditor-only in the ledger, so the workspace lens leaves
#: it out of the edit log too.
_ADMIN_VIEWED = "admin_viewed"

#: The ledger's own copies of the edits read from ``view_activity_log``.
_MIRRORED_LEDGER_PREFIX = "visualization.view."

#: A gap longer than this between two events starts a new session.
SESSION_GAP_MINUTES = 30

#: Rows a single day's timeline returns.
DAY_CAP = 500

#: Event types named individually in a distribution before the tail folds.
_TOP_TYPES = 12

#: Quiet people listed by name on the platform scope (the count is always exact).
_QUIET_LISTED = 200

#: Calendar span, days.
CALENDAR_DAYS = 365


def edit_type(action: str) -> str:
    return f"{_EDIT_PREFIX}{action}"


def ledger_kind(event_type: str, category: Optional[str]) -> str:
    """The kind of one ledger event. Sign-ins first; building next, because ontology and
    version-control work is classified ``content``/``data`` by the ledger and would otherwise
    read as operations."""
    if event_type == SIGN_IN:
        return "signin"
    if event_type.startswith(("ontology.", "workspace.versioning.", "visualization.")):
        return "build"
    if category in ("operations", "data"):
        return "operate"
    return "other"


def kind_of(event_type: str, category: Optional[str] = None) -> str:
    if event_type in USAGE_KINDS:
        return USAGE_KINDS[event_type]
    if event_type.startswith(_EDIT_PREFIX):
        meta = _EDIT_META.get(event_type[len(_EDIT_PREFIX):])
        return meta[1] if meta else "build"
    return ledger_kind(event_type, category)


def label_of(event_type: str) -> str:
    if event_type in USAGE_LABELS:
        return USAGE_LABELS[event_type]
    if event_type.startswith(_EDIT_PREFIX):
        meta = _EDIT_META.get(event_type[len(_EDIT_PREFIX):])
        return meta[0] if meta else "Changed a view"
    return catalogue.label_of(event_type)


#: The rollup's kind for a move to one section of the app.
SECTION_KIND_PREFIX = "section."

#: The kinds that count as someone DOING something: everything but signing in and moving
#: around. Active people, active days, actions and activity lines are all counted from these.
ACTION_KINDS: tuple[str, ...] = tuple(k for k in KINDS if k != "signin")


def section_kind(section: str) -> str:
    return f"{SECTION_KIND_PREFIX}{section}"


def is_action_kind(kind: str) -> bool:
    return kind in ACTION_KINDS

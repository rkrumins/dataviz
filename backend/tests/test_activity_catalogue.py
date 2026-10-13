"""The activity catalogue: what every event IS in the ledger, and who may read it.

Pins the classification half of the activity ledger:

* every event type the code emits is filed under a category on purpose, by a
  rule — a new family of events must not slip into a default nobody chose;
* there are exactly six categories, because the chart palette has six slots
  and colour follows the category;
* the workspace audience is an allow-list, and nothing about identity, SSO,
  global RBAC or the platform can reach it however its payload is shaped —
  that audience is what a workspace admin reads;
* who acted is found under every key an emitter uses, and someone who never
  proved who they are is never recorded as the person they claimed to be;
* ``project`` and ``summarize`` never raise, whatever the payload.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from backend.app.services.activity import catalogue

_BACKEND = Path(__file__).resolve().parents[1]

#: Prefixes whose events are never any one workspace's business.
_NEVER_WORKSPACE = (
    "user.", "auth.", "idp.", "sso.", "identity.", "branding.", "platform.",
    "provider.", "visualization.", "rbac.role.", "rbac.group.",
    "rbac.sso_mapping.", "rbac.permission.",
)

#: Every way a payload can name a workspace that the projection reads.
_WORKSPACE_EVERYWHERE = {
    "workspace_id": "ws_1", "workspaceId": "ws_1", "to_workspace_id": "ws_1",
    "target_type": "workspace", "target_id": "ws_1",
}


def _emitted_event_types() -> set[str]:
    """Every event-type literal handed to an outbox writer, by AST scan."""
    found: set[str] = set()
    for root in (_BACKEND / "app", _BACKEND / "auth_service"):
        for path in root.rglob("*.py"):
            if "__pycache__" in path.parts:
                continue
            for node in ast.walk(ast.parse(path.read_text())):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                name = getattr(func, "attr", None) or getattr(func, "id", "")
                if not ("emit" in name or "outbox" in name or name == "record_activity"):
                    continue
                values = [kw.value for kw in node.keywords if kw.arg == "event_type"]
                values += list(node.args[:2])
                for value in values:
                    if (
                        isinstance(value, ast.Constant)
                        and isinstance(value.value, str)
                        and value.value.count(".") >= 1
                        and value.value.replace(".", "").replace("_", "").isalpha()
                        and value.value.islower()
                    ):
                        found.add(value.value)
    return found


_EMITTED = sorted(_emitted_event_types())
_KNOWN = sorted(set(_EMITTED) | {e["type"] for e in catalogue.catalogue_entries()})


def test_the_scan_sees_the_emitters():
    # A scan that silently matched nothing would pass everything below.
    assert len(_EMITTED) > 50
    assert {"rbac.group.member_added", "user.logged_in", "user.login_failed"} <= set(_EMITTED)


@pytest.mark.parametrize("event_type", _KNOWN)
def test_every_event_is_filed_by_a_rule(event_type):
    assert any(event_type.startswith(prefix) for prefix, _ in catalogue._CATEGORY_RULES), (
        f"{event_type} has no category rule — add one to _CATEGORY_RULES"
    )
    assert catalogue.category_of(event_type) in catalogue.CATEGORIES


def test_there_are_exactly_six_categories():
    assert len(catalogue.CATEGORIES) == len(set(catalogue.CATEGORIES)) == 6
    assert {c for _, c in catalogue._CATEGORY_RULES} <= set(catalogue.CATEGORIES)


@pytest.mark.parametrize("event_type", _KNOWN)
@pytest.mark.parametrize("version", [1, 2])
def test_nothing_outside_the_allow_list_reaches_a_workspace_admin(event_type, version):
    out = catalogue.project(
        event_type=event_type, payload=dict(_WORKSPACE_EVERYWHERE), event_version=version,
    )
    if out["audience"] == catalogue.AUDIENCE_WORKSPACE:
        assert not event_type.startswith(_NEVER_WORKSPACE), event_type
        assert out["category"] not in ("identity", "platform"), event_type
        assert out["workspace_id"] == "ws_1"


@pytest.mark.parametrize("event_type", [
    "rbac.workspace.member_bound", "rbac.workspace.member_revoked",
    "rbac.view.grant_added", "aggregation.job.triggered",
    "aggregation.source.purged", "workspace.data_source.added",
    "workspace.versioning.enabled",
])
def test_a_workspace_admin_does_see_their_workspace_operations(event_type):
    out = catalogue.project(event_type=event_type, payload={"workspace_id": "ws_1"})
    assert (out["audience"], out["workspace_id"]) == ("workspace", "ws_1")


def test_without_a_workspace_nothing_is_workspace_audience():
    out = catalogue.project(event_type="aggregation.job.triggered", payload={}, event_version=2)
    assert (out["audience"], out["workspace_id"]) == ("platform", None)


@pytest.mark.parametrize("target_type, audience", [("workspace", "workspace"), ("view", "platform")])
def test_an_access_request_is_a_workspace_event_only_for_a_workspace(target_type, audience):
    out = catalogue.project(event_type="rbac.access_request.approved", payload={
        "request_id": "ar_1", "requester_id": "usr_r", "actor_id": "usr_a",
        "target_type": target_type, "target_id": "ws_1" if target_type == "workspace" else "view_1",
    })
    assert out["audience"] == audience
    assert (out["actor_id"], out["subject_id"]) == ("usr_a", "usr_r")


def test_a_moved_source_is_filed_under_where_it_went():
    out = catalogue.project(event_type="workspace.datasource.moved", payload={
        "data_source_id": "ds_1", "from_workspace_id": "ws_a",
        "to_workspace_id": "ws_b", "actor_id": "usr_1",
    })
    assert (out["workspace_id"], out["audience"], out["target_id"]) == ("ws_b", "workspace", "ds_1")


@pytest.mark.parametrize("event_type, payload, actor, kind, subject", [
    # The requester IS the actor of a request — under a key of its own.
    ("rbac.access_request.created", {"requester_id": "usr_r"}, "usr_r", "user", "usr_r"),
    # An admin editing someone's identity is not that person editing it.
    ("user.identity_updated", {"user_id": "usr_2", "updated_by": "usr_admin"}, "usr_admin", "user", "usr_2"),
    ("user.logged_in", {"user_id": "usr_1"}, "usr_1", "user", "usr_1"),
    ("user.approved", {"user_id": "usr_2", "approved_by": "usr_admin"}, "usr_admin", "user", "usr_2"),
    # Nobody proved who they are: the claimed person is the subject only.
    ("user.login_failed", {"user_id": "usr_x", "email": "x@y.io"}, None, "anonymous", "usr_x"),
    ("user.sso_login_failed", {"user_id": "usr_x"}, None, "anonymous", "usr_x"),
    # Revoked by the platform itself.
    ("user.session_revoked", {"user_id": "usr_1", "reason": "reuse"}, None, "system", "usr_1"),
    ("visualization.view.created", {"workspaceId": "ws_1", "actor": "usr_1"}, "usr_1", "user", None),
    ("rbac.group.member_added", {"group_id": "grp_1", "user_id": "usr_2", "actor_id": "script"},
     "script", "service", "usr_2"),
])
def test_who_acted_and_who_it_happened_to(event_type, payload, actor, kind, subject):
    out = catalogue.project(event_type=event_type, payload=payload)
    assert (out["actor_id"], out["actor_kind"], out["subject_id"]) == (actor, kind, subject)


def test_a_recorder_envelope_is_read_without_a_per_type_extractor():
    out = catalogue.project(event_type="workspace.versioning.enabled", event_version=2, payload={
        "actor_id": "usr_1", "workspace_id": "ws_1", "data_source_id": "ds_1",
        "target_type": "data_source", "target_id": "ds_1", "target_label": "Sales",
        "stated_reason": "  audit\nfinding  ", "correlation_id": "req_1",
        "details": {"graphKind": "native"},
    })
    assert out["category"] == "data"
    assert (out["target_type"], out["target_id"], out["target_label"]) == ("data_source", "ds_1", "Sales")
    assert (out["stated_reason"], out["correlation_id"]) == ("audit finding", "req_1")


def test_a_malformed_correlation_id_is_dropped():
    out = catalogue.project(event_type="user.logged_in", payload={"correlation_id": "<script>"})
    assert out["correlation_id"] is None


@pytest.mark.parametrize("payload", [
    None, "", "{not json", "[1, 2]", "42", {"actor_id": {"nested": True}},
    {"target_label": ["a"], "workspace_id": 7, "stated_reason": 3},
])
@pytest.mark.parametrize("event_type", _KNOWN)
def test_project_never_raises_and_always_answers_in_full(event_type, payload):
    out = catalogue.project(event_type=event_type, payload=payload, event_version=2)
    assert set(out) == set(catalogue.fallback_projection(event_type))
    assert out["projection_version"] == catalogue.PROJECTION_VERSION
    assert out["category"] in catalogue.CATEGORIES


@pytest.mark.parametrize("event_type", _KNOWN)
def test_every_event_reads_as_a_sentence_even_with_nothing_to_go_on(event_type):
    severity, summary = catalogue.summarize(event_type, {})
    assert severity in ("info", "warning", "critical")
    assert summary


def test_the_catalogue_lists_what_a_workspace_admin_can_see():
    entries = {e["type"]: e for e in catalogue.catalogue_entries()}
    assert entries["aggregation.job.triggered"]["workspaceVisible"] is True
    assert entries["aggregation.job.triggered"]["label"] == "Triggered aggregation"
    assert entries["rbac.group.member_added"]["workspaceVisible"] is False
    assert entries["user.logged_in"]["workspaceVisible"] is False

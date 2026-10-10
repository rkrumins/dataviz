"""The activity catalogue: what every event is, and how it reads.

One place answers, for any event type the platform emits:

* how it reads to a person — a severity and a one-line summary (the
  ``_EVENT_META`` table the audit lens has always used, moved here so the
  relay, the activity API and ``/admin/audit`` share one copy);
* what it IS in the activity ledger — its category, who may read it
  (``audience``), whether it succeeded, who did it, to what, where and why
  (:func:`project`).

:func:`project` is pure: event in, column values out, no I/O. The relay calls
it once per event when the event enters the ledger, and again whenever
:data:`PROJECTION_VERSION` moves, so a rule improved here re-classifies
history without a data migration. It never raises — an event it cannot read
still gets a fallback projection, because one malformed payload must not stop
the relay behind it.

Imports are the standard library and ``backend.app.common`` only, so the
aggregation control plane can load this without the web tier's auth setup.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

from backend.app.common.activity_context import (
    CORRELATION_KEY,
    STATED_REASON_KEY,
    clean_reason,
    clean_text,
    valid_correlation_id,
)


# Phase 8: per-event display metadata. Each entry maps a known
# event_type to (severity, summary-builder). The summary builder
# receives the decoded payload dict and returns a one-line human
# sentence. Missing payload keys are tolerated — the builder uses
# ``.get`` with sensible fallbacks so a malformed event never raises
# inside the response serialisation path.
def _summary_role_changed(p: dict) -> str:
    role = p.get("new_role") or "?"
    return f"Global role changed → {role}"


def _summary_ws_member_bound(p: dict) -> str:
    role = p.get("role") or "?"
    ws = p.get("workspace_id") or "?"
    expiry = p.get("expires_at")
    suffix = f" (expires {expiry[:10]})" if expiry else ""
    return f"Bound as {role} in {ws}{suffix}"


def _summary_ws_member_revoked(p: dict) -> str:
    role = p.get("role") or "?"
    ws = p.get("workspace_id") or "?"
    killed = p.get("sessions_revoked") or 0
    suffix = f" (killed {killed} session{'s' if killed != 1 else ''})" if killed else ""
    return f"{role} revoked from {ws}{suffix}"


def _summary_ws_expiry(p: dict) -> str:
    new = p.get("new_expires_at")
    if new is None:
        return f"Cleared expiry on {p.get('role') or '?'} in {p.get('workspace_id') or '?'}"
    return f"Expiry updated → {new[:10]} ({p.get('role') or '?'} in {p.get('workspace_id') or '?'})"


def _summary_role_lifecycle(verb: str):
    def _build(p: dict) -> str:
        return f"Role '{p.get('name') or '?'}' {verb}"
    return _build


def _summary_cascade(p: dict) -> str:
    n = p.get("users_revoked") or 0
    role = p.get("role_name") or "?"
    return f"Role '{role}' update cascade-revoked {n} user{'s' if n != 1 else ''}"


def _summary_ws_roles_cascaded(p: dict) -> str:
    n = len(p.get("roles_removed") or [])
    ws = p.get("workspace_id") or "?"
    return f"Workspace {ws} deletion cascaded {n} role{'s' if n != 1 else ''}"


def _summary_view_grant(verb: str):
    def _build(p: dict) -> str:
        view = p.get("view_id") or "?"
        role = p.get("role") or "?"
        return f"View grant ({role}) {verb} on {view}"
    return _build


def _summary_group_lifecycle(verb: str):
    def _build(p: dict) -> str:
        return f"Group '{p.get('group_name') or p.get('group_id') or '?'}' {verb}"
    return _build


def _summary_group_membership(verb: str):
    def _build(p: dict) -> str:
        return f"User {verb} group '{p.get('group_id') or '?'}'"
    return _build


def _summary_user_status(verb: str):
    def _build(p: dict) -> str:
        uid = p.get("user_id") or "?"
        return f"User {uid} {verb}"
    return _build


def _summary_identity(verb: str):
    def _build(p: dict) -> str:
        return f"SSO identity {verb} for {p.get('user_id') or '?'}"
    return _build


def _summary_access_request(verb: str):
    def _build(p: dict) -> str:
        ws = p.get("workspace_id") or "?"
        return f"Access request {verb} for {ws}"
    return _build


def _summary_idp_provider(verb: str):
    def _build(p: dict) -> str:
        slug = p.get("slug") or p.get("provider_id") or "?"
        return f"IdP provider '{slug}' {verb}"
    return _build


def _mapping_target(t: dict) -> str:
    """One clause naming what a mapping grants. Ids are fine here — the
    reference-name pass below swaps every ``grp_``/``ws_`` token for the
    thing's actual name before the summary leaves the server."""
    if t.get("target_type") == "group_membership":
        return f"joins {t.get('target_group_id') or '?'}"
    role = t.get("role_name") or "?"
    where = t.get("scope_id") or "the organization"
    return f"gets {role} in {where}"


def _summary_sso_mapping(verb: str):
    def _build(p: dict) -> str:
        base = f"IdP group mapping {verb} ({p.get('idp_group') or '?'})"
        if p.get("role_name") or p.get("target_group_id"):
            return f"{base} → {_mapping_target(p)}"
        return base
    return _build


def _summary_sso_mapping_updated(p: dict) -> str:
    before = p.get("before") if isinstance(p.get("before"), dict) else {}
    after = p.get("after") if isinstance(p.get("after"), dict) else {}
    group = after.get("idp_group") or before.get("idp_group") or "?"
    line = f"IdP group mapping updated ({group}) → {_mapping_target(after)}"
    if before and _mapping_target(before) != _mapping_target(after):
        line += f" (was: {_mapping_target(before)})"
    return line


def _summary_login(p: dict) -> str:
    provider = p.get("provider") or p.get("provider_slug") or "local"
    return f"Signed in via {provider}"


def _summary_login_failed(p: dict) -> str:
    # ``: {reason}`` last, like every other failure line, so the reason
    # parses out for the explanation beside it. A row without one says so
    # rather than guessing which refusal it was.
    reason = p.get("reason") or "unspecified"
    email = p.get("email") or "?"
    return f"Failed password sign-in for {email}: {reason}"


def _summary_session_revoked(p: dict) -> str:
    reason = p.get("reason") or "unspecified"
    n = p.get("sessions_killed") or 1
    return f"Session revoked ({reason}, {n} kill{'s' if n != 1 else ''})"


def _summary_workspace_lifecycle(verb: str):
    def _build(p: dict) -> str:
        name = p.get("name") or p.get("workspace_id") or "?"
        return f"Workspace '{name}' {verb}"
    return _build


def _summary_sso_failure(p: dict) -> str:
    # ``ref`` leads the line: it is the handle the stuck user was shown on
    # the login page, so an admin pastes it into the filter and lands here.
    ref = p.get("ref")
    slug = p.get("provider_slug") or "?"
    reason = p.get("reason") or "unknown"
    lead = f"[{ref}] " if ref else ""
    who = p.get("email") or p.get("user_id")
    for_who = f" for {who}" if who else ""
    return f"{lead}Sign-in via {slug} failed{for_who}: {reason}"


def _summary_sso_user(verb: str) -> callable:
    def _build(p: dict) -> str:
        who = p.get("email") or p.get("user_id") or "?"
        return f"{who} {verb} {p.get('provider_slug') or 'an IdP'}"
    return _build


def _summary_sso_denied(p: dict) -> str:
    who = p.get("email") or p.get("user_id") or "?"
    reasons = p.get("deny_reasons") or p.get("reason")
    if isinstance(reasons, (list, tuple)):
        reasons = ", ".join(str(r) for r in reasons)
    slug = p.get("provider_slug") or "an IdP"
    return f"Refused {who} from {slug}" + (f": {reasons}" if reasons else "")


#: Why an SSO session ended, as ``user.sso_session_expired`` records it.
#: Events written before the reason was recorded carry none and read as
#: before.
_SSO_EXPIRY_REASONS = {
    "reauth_ceiling": ", daily re-authentication",
    "idle": ", idle",
    "absolute": ", maximum session age",
}


def _summary_session_refused(p: dict) -> str:
    return (
        f"Session renewal refused for {p.get('user_id') or '?'}: "
        f"{p.get('reason') or 'unknown'}"
    )


def _summary_session_ended_upstream(p: dict) -> str:
    return (
        f"SSO session for {p.get('user_id') or '?'} ended by "
        f"{p.get('provider_slug') or 'its IdP'}: {p.get('reason') or 'unknown'}"
    )


_EVENT_META: dict[str, tuple[str, callable]] = {
    # ── critical: role / identity changes / forced revocation
    "user.role_changed": ("critical", _summary_role_changed),
    "user.suspended": ("critical", _summary_user_status("suspended")),
    "user.rejected": ("critical", _summary_user_status("rejected")),
    "user.identity.admin_linked": ("critical", _summary_identity("linked")),
    "user.identity.admin_unlinked": ("critical", _summary_identity("unlinked")),
    "user.session_revoked": ("critical", _summary_session_revoked),
    "user.sessions_ended_by_admin": (
        "critical",
        lambda p: f"Every session of {p.get('user_id') or '?'} ended by an admin",
    ),
    "auth.config.updated": ("critical", lambda p: "SSO / login config changed"),
    "rbac.role.cascade_revoked": ("critical", _summary_cascade),
    "rbac.workspace.roles_cascaded": ("critical", _summary_ws_roles_cascaded),
    "rbac.workspace.deleted": (
        "critical", _summary_workspace_lifecycle("deleted"),
    ),

    # ── warning: revokes / deletes / denials / failed login
    "rbac.workspace.member_revoked": ("warning", _summary_ws_member_revoked),
    "rbac.view.grant_removed": ("warning", _summary_view_grant("revoked")),
    "rbac.role.deleted": ("warning", _summary_role_lifecycle("deleted")),
    "rbac.group.deleted": ("warning", _summary_group_lifecycle("deleted")),
    "rbac.group.member_removed": ("warning", _summary_group_membership("removed from")),
    "rbac.sso_mapping.deleted": ("warning", _summary_sso_mapping("deleted")),
    "idp.provider.deleted": ("warning", _summary_idp_provider("deleted")),
    "rbac.access_request.denied": ("warning", _summary_access_request("denied")),
    "user.login_failed": ("warning", _summary_login_failed),
    "user.logged_out": ("warning", lambda p: f"User {p.get('user_id') or '?'} signed out"),

    # ── info: binds / creates / updates
    "rbac.workspace.member_bound": ("info", _summary_ws_member_bound),
    "rbac.workspace.member_expiry_updated": ("info", _summary_ws_expiry),
    "rbac.view.grant_added": ("info", _summary_view_grant("added")),
    "rbac.role.created": ("info", _summary_role_lifecycle("created")),
    "rbac.role.updated": ("info", _summary_role_lifecycle("permissions updated")),
    "rbac.permission.updated": ("info", lambda p: f"Permission '{p.get('id') or '?'}' description updated"),
    "rbac.group.created": ("info", _summary_group_lifecycle("created")),
    "rbac.group.updated": ("info", _summary_group_lifecycle("updated")),
    "rbac.group.member_added": ("info", _summary_group_membership("added to")),
    "rbac.sso_mapping.created": ("info", _summary_sso_mapping("created")),
    "rbac.sso_mapping.updated": ("info", _summary_sso_mapping_updated),
    "idp.provider.created": ("info", _summary_idp_provider("created")),
    "idp.provider.updated": ("info", _summary_idp_provider("updated")),
    "branding.updated": ("info", lambda p: "Branding settings updated"),
    "user.approved": ("info", _summary_user_status("approved")),
    "user.reactivated": ("info", _summary_user_status("reactivated")),
    "rbac.access_request.approved": ("info", _summary_access_request("approved")),
    # Phase 9 — login / lifecycle events promoted to first-class.
    "user.logged_in": ("info", _summary_login),
    "rbac.workspace.created": ("info", _summary_workspace_lifecycle("created")),
    "rbac.workspace.updated": ("info", _summary_workspace_lifecycle("updated")),

    # ── SSO sign-in outcomes.
    # ``ref`` is the handle the stuck user was shown on the login page, so it
    # leads the summary: an admin pastes it into the filter and lands here.
    "user.sso_login_failed": ("warning", _summary_sso_failure),
    "user.sso_provisioned": ("info", _summary_sso_user("provisioned via")),
    "user.sso_linked": ("info", _summary_sso_user("linked to")),
    "user.sso_link_denied": ("warning", _summary_sso_denied),
    "user.sso_jit_blocked": ("warning", _summary_sso_denied),
    "user.sso_session_expired": (
        "info",
        lambda p: (
            f"SSO session expired for {p.get('user_id') or '?'} "
            f"({p.get('provider_slug') or 'sso'}"
            f"{_SSO_EXPIRY_REASONS.get(p.get('reason'), '')}) — "
            "re-authentication required"
        ),
    ),
    # Degraded-trust logins. Warning, not info: each one is a login the
    # platform could not cryptographically verify.
    # Why a session stopped renewing — context for the sign-in that
    # usually follows, not a failure in itself.
    "user.session_refused": ("info", _summary_session_refused),
    "user.sso_session_ended_upstream": ("info", _summary_session_ended_upstream),
    "user.sso_unsigned_accepted": (
        "warning",
        lambda p: (
            f"Accepted an UNSIGNED profile from "
            f"{p.get('provider_slug') or '?'} "
            f"(source {p.get('source') or '?'})"
        ),
    ),
    "user.sso_header_accepted": (
        "warning",
        lambda p: (
            f"Trusted a proxy-injected header from "
            f"{p.get('provider_slug') or '?'} "
            f"({p.get('source_key') or '?'})"
        ),
    ),
}


# ════════════════════════════════════════════════════════════════════
# Operations captured by the activity recorder (``event_version`` 2).
#
# These carry the canonical envelope (``services/activity/recorder.py``), so
# a summary reads the name the target had AT THE TIME from ``target_label``.
# ════════════════════════════════════════════════════════════════════

def _subject(p: dict) -> str:
    return p.get("target_label") or p.get("target_id") or "?"


def _detail(p: dict, key: str) -> Any:
    details = p.get("details")
    return details.get(key) if isinstance(details, dict) else None


def _envelope_summary(template: str) -> Callable[[dict], str]:
    """A summary that names the target: ``template`` holds one ``{}``."""
    def _build(p: dict) -> str:
        return template.format(_subject(p))
    return _build


def _summary_job_triggered(p: dict) -> str:
    source = _detail(p, "triggerSource")
    mode = {"onboarding": " (onboarding)", "api": " (via the API)"}.get(source or "", "")
    return f"Triggered aggregation of {_subject(p)}{mode}"


def _summary_refresh(p: dict) -> str:
    scope = _detail(p, "scope") or "auto"
    what = {
        "auto": "a refresh", "read-caches": "a cache refresh",
        "rollups": "a rollup rebuild", "full": "a full refresh",
        "clear": "a stale-marker clear",
    }.get(scope, f"a {scope} refresh")
    return f"Requested {what} of {_subject(p)}"


def _summary_flag(p: dict) -> str:
    key = _detail(p, "key") or _subject(p)
    value = _detail(p, "value")
    return f"Feature '{key}' set to {json.dumps(value)}" if value is not None else f"Feature '{key}' changed"


_EVENT_META.update({
    # ── operations: ingestion and aggregation, by a person
    "aggregation.job.triggered": ("info", _summary_job_triggered),
    "aggregation.job.resumed": ("info", _envelope_summary("Resumed aggregation of {}")),
    "aggregation.job.cancelled": ("warning", _envelope_summary("Cancelled aggregation of {}")),
    "aggregation.job.deleted": ("warning", _envelope_summary("Deleted an aggregation run of {}")),
    "aggregation.job.limits_changed": ("info", _envelope_summary("Changed the time limits of a running job on {}")),
    "aggregation.source.purged": ("warning", _envelope_summary("Purged the rollups of {}")),
    "aggregation.source.skipped": ("warning", _envelope_summary("Skipped aggregation for {}")),
    "aggregation.source.schedule_changed": ("info", _envelope_summary("Changed the aggregation schedule of {}")),
    "aggregation.source.refresh_requested": ("info", _summary_refresh),
    "aggregation.source.settings_changed": ("info", _envelope_summary("Changed freshness settings of {}")),
    "aggregation.provider.refresh_requested": ("info", _envelope_summary("Requested a refresh of every source on {}")),
    "aggregation.provider.hold_changed": ("warning", _envelope_summary("Changed the automation hold on {}")),
    "aggregation.fleet.refresh_requested": ("info", lambda p: "Requested a refresh of every data source"),
    "aggregation.reconcile.run_requested": ("info", lambda p: "Ran reconciliation now"),
    "aggregation.policy.updated": ("info", lambda p: "Changed the reconciliation policy"),
    "aggregation.settings.updated": ("info", lambda p: "Changed the fleet's aggregation defaults"),
    "stats.discovery.triggered": ("info", _envelope_summary("Ran asset discovery on {}")),
    "stats.asset.refresh_requested": ("info", _envelope_summary("Refreshed the statistics of {}")),
    # ── data: onboarding, sources, providers, version control
    "workspace.data_source.added": ("info", _envelope_summary("Added data source {}")),
    "workspace.data_source.updated": ("info", _envelope_summary("Updated data source {}")),
    "workspace.data_source.removed": ("warning", _envelope_summary("Removed data source {}")),
    "workspace.data_source.restored": ("info", _envelope_summary("Restored data source {}")),
    "workspace.data_source.primary_set": ("info", _envelope_summary("Made {} the primary data source")),
    "workspace.data_source.projection_changed": ("info", _envelope_summary("Changed where {} keeps its rollups")),
    "workspace.versioning.enabled": ("info", _envelope_summary("Turned on version control for {}")),
    "workspace.versioning.retried": ("info", _envelope_summary("Retried turning on version control for {}")),
    "workspace.versioning.abandoned": ("warning", _envelope_summary("Abandoned turning on version control for {}")),
    "workspace.versioning.resynced": ("info", _envelope_summary("Re-synced the versioned graph of {}")),
    "workspace.versioning.blank_created": ("info", _envelope_summary("Created a new versioned model, {}")),
    "provider.connection.created": ("info", _envelope_summary("Registered provider {}")),
    "provider.connection.updated": ("info", _envelope_summary("Updated provider {}")),
    "provider.connection.deleted": ("warning", _envelope_summary("Deleted provider {}")),
    # ── platform
    "platform.feature_flag.changed": ("info", _summary_flag),
    "platform.profiling_policy.updated": ("info", lambda p: "Changed profiling retention and alerting"),
    "platform.node_identity.updated": ("info", lambda p: "Changed the platform's node-identity default"),
    "platform.activity.exported": ("info", lambda p: (
        f"Exported the activity of {_subject(p)} as CSV" if p.get("workspace_id")
        else "Exported platform activity as CSV"
    )),
})

#: The verb phrase each known event type is filed under in pickers and
#: legends — the summary without its particulars.
LABELS: dict[str, str] = {
    "aggregation.job.triggered": "Triggered aggregation",
    "aggregation.job.resumed": "Resumed aggregation",
    "aggregation.job.cancelled": "Cancelled aggregation",
    "aggregation.job.deleted": "Deleted an aggregation run",
    "aggregation.job.limits_changed": "Changed a job's time limits",
    "aggregation.source.purged": "Purged rollups",
    "aggregation.source.skipped": "Skipped aggregation",
    "aggregation.source.schedule_changed": "Changed an aggregation schedule",
    "aggregation.source.refresh_requested": "Refreshed a data source",
    "aggregation.source.settings_changed": "Changed freshness settings",
    "aggregation.provider.refresh_requested": "Refreshed a provider",
    "aggregation.provider.hold_changed": "Changed an automation hold",
    "aggregation.fleet.refresh_requested": "Refreshed every source",
    "aggregation.reconcile.run_requested": "Ran reconciliation",
    "aggregation.policy.updated": "Changed reconciliation policy",
    "aggregation.settings.updated": "Changed aggregation defaults",
    "stats.discovery.triggered": "Ran asset discovery",
    "stats.asset.refresh_requested": "Refreshed asset statistics",
    "workspace.data_source.added": "Added a data source",
    "workspace.data_source.updated": "Updated a data source",
    "workspace.data_source.removed": "Removed a data source",
    "workspace.data_source.restored": "Restored a data source",
    "workspace.data_source.primary_set": "Set the primary data source",
    "workspace.data_source.projection_changed": "Changed rollup placement",
    "workspace.datasource.moved": "Moved a data source",
    "workspace.versioning.enabled": "Turned on version control",
    "workspace.versioning.retried": "Retried version control",
    "workspace.versioning.abandoned": "Abandoned version control",
    "workspace.versioning.resynced": "Re-synced a versioned graph",
    "workspace.versioning.blank_created": "Created a versioned model",
    "provider.connection.created": "Registered a provider",
    "provider.connection.updated": "Updated a provider",
    "provider.connection.deleted": "Deleted a provider",
    "platform.feature_flag.changed": "Changed a feature flag",
    "platform.profiling_policy.updated": "Changed profiling policy",
    "platform.node_identity.updated": "Changed node identity",
    "platform.activity.exported": "Exported activity",
    "rbac.group.member_added": "Added to a group",
    "rbac.group.member_removed": "Removed from a group",
    "rbac.group.created": "Created a group",
    "rbac.group.updated": "Updated a group",
    "rbac.group.deleted": "Deleted a group",
    "rbac.workspace.member_bound": "Granted workspace access",
    "rbac.workspace.member_revoked": "Revoked workspace access",
    "rbac.workspace.member_expiry_updated": "Changed access expiry",
    "rbac.workspace.created": "Created a workspace",
    "rbac.workspace.updated": "Updated a workspace",
    "rbac.workspace.deleted": "Deleted a workspace",
    "rbac.view.grant_added": "Shared a view",
    "rbac.view.grant_updated": "Changed a view share",
    "rbac.view.grant_removed": "Unshared a view",
    "rbac.access_request.created": "Requested access",
    "rbac.access_request.approved": "Approved access",
    "rbac.access_request.denied": "Denied access",
    "rbac.role.created": "Created a role",
    "rbac.role.updated": "Changed a role",
    "rbac.role.deleted": "Deleted a role",
    "user.logged_in": "Signed in",
    "user.logged_out": "Signed out",
    "user.login_failed": "Failed sign-in",
    "user.sso_login_failed": "Failed SSO sign-in",
    "user.role_changed": "Changed a global role",
    "user.approved": "Approved an account",
    "user.suspended": "Suspended an account",
    "user.reactivated": "Reactivated an account",
    "user.access_denied": "Was refused access",
    "visualization.view.created": "Created a view",
    "visualization.view.deleted": "Deleted a view",
    "visualization.view.admin_viewed": "Opened a private view as an admin",
    "branding.updated": "Changed branding",
}


# ════════════════════════════════════════════════════════════════════
# Classification — what an event IS in the activity ledger.
# ════════════════════════════════════════════════════════════════════

#: Bump whenever a rule below changes what an event projects to. The relay
#: re-projects every row recorded under an older version, in the background.
PROJECTION_VERSION = 1

#: Exactly six, in a fixed order. Each owns a chart slot: the palette has six
#: and colour follows the entity, so a seventh would not be a new colour to a
#: reader with a colour-vision deficiency — it would be one already on screen.
CATEGORIES: tuple[str, ...] = (
    "operations", "access", "identity", "data", "content", "platform",
)

AUDIENCE_PLATFORM = "platform"
AUDIENCE_WORKSPACE = "workspace"

#: Event-type prefix → category; the longest matching prefix wins.
_CATEGORY_RULES: tuple[tuple[str, str], ...] = tuple(sorted((
    ("aggregation.", "operations"),
    ("stats.", "operations"),
    ("rbac.", "access"),
    # A workspace's own lifecycle is the shape of the estate, not access to it.
    ("rbac.workspace.created", "data"),
    ("rbac.workspace.updated", "data"),
    ("rbac.workspace.deleted", "data"),
    ("user.", "identity"),
    ("auth.", "identity"),
    ("idp.", "identity"),
    ("sso.", "identity"),
    ("identity.", "identity"),
    ("workspace.", "data"),
    ("provider.", "data"),
    ("ontology.", "content"),
    ("visualization.", "content"),
    ("view.", "content"),
    ("branding.", "platform"),
    ("platform.", "platform"),
), key=lambda rule: -len(rule[0])))

#: What a workspace admin may read about THEIR workspace. An allow-list on
#: purpose: an event type nobody has looked at stays auditor-only.
#:
#: Excluded by design: identity, SSO, global RBAC (roles, groups, mappings),
#: providers and platform settings, which are not any one workspace's — and
#: ``visualization.view.*``, which the workspace's Views tab already shows
#: and which includes an admin opening a PRIVATE view (auditor-only).
_WORKSPACE_PREFIXES: tuple[str, ...] = (
    "rbac.workspace.member_bound",
    "rbac.workspace.member_revoked",
    "rbac.workspace.member_expiry_updated",
    "rbac.workspace.updated",
    "rbac.workspace.roles_cascaded",
    # Safe: a workspace admin already reaches every view in their workspace.
    "rbac.view.grant_",
    "aggregation.job.",
    "aggregation.source.",
    "workspace.data_source.",
    "workspace.datasource.moved",
    "workspace.versioning.",
)

#: Payload keys that name who acted, in the order they are trusted. Payloads
#: grew these one emitter at a time; reading only the first three left the
#: actor blank on approvals, suspensions, resets and invites.
_ACTOR_KEYS: tuple[str, ...] = (
    "actor_id", "changed_by", "granted_by", "approved_by", "rejected_by",
    "suspended_by", "reactivated_by", "reset_by", "generated_by",
    "created_by", "updated_by", "revoked_by", "extended_by",
    "regenerated_by", "invited_by", "merged_by", "closed_by", "actor",
)

#: Event types that name their actor under a key of their own.
_ACTOR_KEY_BY_TYPE: dict[str, str] = {
    "rbac.access_request.created": "requester_id",
}

#: Events a person does to THEMSELVES: with no explicit actor, it is them.
_SELF_ACTED = frozenset({
    "user.logged_in", "user.logged_out", "user.password_changed",
    "user.password_reset_requested", "user.password_reset_completed",
    "user.sessions_revoked_by_self", "user.identity.linked",
    "user.identity.unlinked", "user.sso_linked", "user.sso_provisioned",
    "user.created", "user.created_via_invite", "user.invite_redeemed_via_sso",
    "user.access_denied", "user.identity_updated",
    # Granted by an admin's reset token, but switched on by redeeming it.
    "user.local_login_enabled",
})

#: Sign-in attempts by someone who had not (yet) proven who they are. The
#: event names who they CLAIMED to be, as its subject — never as its actor.
_UNAUTHENTICATED = frozenset({
    "user.login_failed", "user.sso_login_failed", "user.sso_link_denied",
    "user.sso_jit_blocked", "user.sso_unsigned_accepted",
    "user.sso_header_accepted",
})

#: Callers that are a service rather than a person.
_SERVICE_ACTORS = frozenset({"internal", "script", "connector", "system", "scheduler"})

_FAILURE_TYPES = frozenset({
    "user.login_failed", "user.sso_login_failed", "user.sso_link_denied",
    "user.sso_jit_blocked", "user.session_refused",
})
_DENIED_TYPES = frozenset({"user.access_denied"})

#: Verbs that undo or destroy, for event types with no catalogue severity.
_WARNING_VERBS = (
    "deleted", "removed", "revoked", "purged", "cancelled", "abandoned",
    "suspended", "rejected", "denied", "skipped",
)

#: Longest a denormalised label is kept.
_LABEL_CHARS = 200

#: Recorder-written events (see ``recorder.ENVELOPE_VERSION``).
_ENVELOPE_VERSION = 2


def label_of(event_type: str) -> str:
    """The verb phrase ``event_type`` is filed under, for any type.

    Unlisted types read as entity and verb — ``idp.provider.published`` as
    "Provider published", ``user.invite_extended`` as "Invite extended" — so a
    type added without a label still reads as words, not a dotted code.
    """
    known = LABELS.get(event_type)
    if known:
        return known
    parts = event_type.split(".")
    words = " ".join(parts[-2:] if len(parts) > 2 else parts[-1:]).replace("_", " ").strip()
    return words[:1].upper() + words[1:] if words else event_type


def category_of(event_type: str) -> str:
    for prefix, category in _CATEGORY_RULES:
        if event_type.startswith(prefix):
            return category
    return "platform"


def severity_of(event_type: str) -> str:
    meta = _EVENT_META.get(event_type)
    if meta is not None:
        return meta[0]
    return "warning" if event_type.endswith(_WARNING_VERBS) else "info"


def summarize(event_type: str, payload: dict) -> tuple[str, str]:
    """``(severity, one-line summary)``; never raises."""
    meta = _EVENT_META.get(event_type)
    if meta is None:
        return severity_of(event_type), label_of(event_type)
    severity, build = meta
    try:
        return severity, build(payload)
    except Exception:  # noqa: BLE001 — a bad payload costs the sentence, not the row
        return severity, label_of(event_type)


def _str(value: Any, limit: int = 256) -> Optional[str]:
    """A payload scalar as a column value. Cleaned like a stated reason: a
    payload is whatever its emitter put there, and a projected column is
    rendered to people and filtered on."""
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    return clean_text(str(value), limit)


def _actor(event_type: str, p: dict) -> Optional[str]:
    own_key = _ACTOR_KEY_BY_TYPE.get(event_type)
    if own_key and _str(p.get(own_key), 128):
        return _str(p.get(own_key), 128)
    for key in _ACTOR_KEYS:
        found = _str(p.get(key), 128)
        if found:
            return found
    if event_type in _SELF_ACTED:
        return _str(p.get("user_id"), 128)
    return None


def _subject_user(event_type: str, p: dict) -> Optional[str]:
    """The person an event is ABOUT, when it is about one."""
    if p.get("subject_type") == "user":
        return _str(p.get("subject_id"), 128)
    if event_type.startswith("rbac.access_request."):
        return _str(p.get("requester_id"), 128)
    return _str(p.get("user_id") or p.get("target_user_id"), 128)


def _legacy_target(
    event_type: str, p: dict, aggregate_type: Optional[str], aggregate_id: Optional[str],
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """``(type, id, label)`` for events written before the envelope."""
    if event_type.startswith("rbac.group."):
        return "group", _str(p.get("group_id")), _str(p.get("group_name") or p.get("name"))
    if event_type.startswith("rbac.workspace."):
        return "workspace", _str(p.get("workspace_id")), _str(p.get("name"))
    if event_type.startswith("rbac.view."):
        return "view", _str(p.get("view_id")), None
    if event_type.startswith("rbac.access_request."):
        return _str(p.get("target_type")), _str(p.get("target_id")), None
    if event_type.startswith("rbac.role."):
        name = _str(p.get("name") or p.get("role_name"))
        return "role", _str(p.get("role_id")) or name, name
    if event_type.startswith("rbac.permission."):
        return "permission", _str(p.get("id")), _str(p.get("id"))
    if event_type.startswith("rbac.sso_mapping."):
        group = _str(p.get("idp_group"))
        return "idp_group_mapping", _str(p.get("mapping_id")) or group, group
    if event_type.startswith("idp."):
        return "idp", _str(p.get("provider_id")) or _str(aggregate_id), _str(p.get("slug"))
    if event_type.startswith("sso.backchannel_host"):
        host = _str(p.get("host"))
        return "backchannel_host", host, host
    if event_type == "workspace.datasource.moved":
        return "data_source", _str(p.get("data_source_id")), None
    if event_type.startswith("visualization.view."):
        return "view", _str(aggregate_id) or _str(p.get("viewId") or p.get("view_id")), None
    if event_type.startswith("user."):
        return "user", _str(p.get("user_id")), _str(p.get("email"))
    if event_type.startswith("auth."):
        return "auth_config", None, None
    if event_type.startswith("branding."):
        return "branding", None, None
    return _str(aggregate_type), _str(aggregate_id), None


def _workspace_of(event_type: str, p: dict) -> Optional[str]:
    if event_type == "workspace.datasource.moved":
        # One workspace column for an event that touches two: it is filed
        # under where the source went, which is where it now lives.
        return _str(p.get("to_workspace_id"))
    if event_type.startswith("rbac.access_request."):
        return _str(p.get("target_id")) if p.get("target_type") == "workspace" else None
    return _str(p.get("workspace_id") or p.get("workspaceId"))


def _audience(event_type: str, p: dict, workspace_id: Optional[str]) -> str:
    if not workspace_id:
        return AUDIENCE_PLATFORM
    if event_type.startswith("rbac.access_request."):
        return AUDIENCE_WORKSPACE
    if event_type.startswith(_WORKSPACE_PREFIXES):
        return AUDIENCE_WORKSPACE
    return AUDIENCE_PLATFORM


def project(
    *,
    event_type: str,
    payload: Any,
    event_version: Optional[int] = 1,
    aggregate_type: Optional[str] = None,
    aggregate_id: Optional[str] = None,
) -> dict[str, Any]:
    """The ledger columns for one event. Pure, and never raises."""
    try:
        return _project(
            event_type=event_type, payload=payload, event_version=event_version,
            aggregate_type=aggregate_type, aggregate_id=aggregate_id,
        )
    except Exception:  # noqa: BLE001 — a bad event must not stop the relay
        return fallback_projection(event_type)


def fallback_projection(event_type: str) -> dict[str, Any]:
    """What an event projects to when its payload cannot be read."""
    return {
        "category": category_of(event_type),
        "audience": AUDIENCE_PLATFORM,
        "severity": severity_of(event_type),
        "outcome": _outcome(event_type),
        "actor_id": None, "actor_kind": "system", "subject_id": None,
        "target_type": None, "target_id": None, "target_label": None,
        "workspace_id": None, "data_source_id": None,
        "stated_reason": None, "correlation_id": None,
        "projection_version": PROJECTION_VERSION,
    }


def _outcome(event_type: str) -> str:
    if event_type in _DENIED_TYPES:
        return "denied"
    if event_type in _FAILURE_TYPES:
        return "failure"
    return "success"


def _project(
    *,
    event_type: str,
    payload: Any,
    event_version: Optional[int],
    aggregate_type: Optional[str],
    aggregate_id: Optional[str],
) -> dict[str, Any]:
    if isinstance(payload, str):
        payload = json.loads(payload) if payload else {}
    p: dict = payload if isinstance(payload, dict) else {}

    if (event_version or 1) >= _ENVELOPE_VERSION:
        target_type = _str(p.get("target_type"))
        target_id = _str(p.get("target_id"))
        target_label = _str(p.get("target_label"), _LABEL_CHARS)
        workspace_id = _str(p.get("workspace_id"))
    else:
        target_type, target_id, target_label = _legacy_target(
            event_type, p, aggregate_type, aggregate_id,
        )
        workspace_id = _workspace_of(event_type, p)

    actor_id = None if event_type in _UNAUTHENTICATED else _actor(event_type, p)
    if not actor_id:
        actor_kind = "anonymous" if event_type in _UNAUTHENTICATED else "system"
    elif actor_id in _SERVICE_ACTORS:
        actor_kind = "service"
    else:
        actor_kind = "user"

    return {
        "category": category_of(event_type),
        "audience": _audience(event_type, p, workspace_id),
        "severity": severity_of(event_type),
        "outcome": _outcome(event_type),
        "actor_id": actor_id,
        "actor_kind": actor_kind,
        "subject_id": _subject_user(event_type, p),
        "target_type": target_type,
        "target_id": target_id,
        "target_label": (target_label or None) and target_label[:_LABEL_CHARS],
        "workspace_id": workspace_id,
        "data_source_id": _str(p.get("data_source_id") or p.get("dataSourceId")),
        "stated_reason": clean_reason(p.get(STATED_REASON_KEY)),
        "correlation_id": valid_correlation_id(_str(p.get(CORRELATION_KEY), 128)),
        "projection_version": PROJECTION_VERSION,
    }


def catalogue_entries() -> list[dict[str, str]]:
    """Every event type this module knows, for filter pickers and legends."""
    types = sorted(set(_EVENT_META) | set(LABELS))
    return [
        {
            "type": t,
            "label": label_of(t),
            "category": category_of(t),
            "severity": severity_of(t),
            "workspaceVisible": t.startswith(_WORKSPACE_PREFIXES)
            or t.startswith("rbac.access_request."),
        }
        for t in types
    ]

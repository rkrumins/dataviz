"""The settings resolver (``services.settings.resolver``): each setting's effective value at the
platform, a workspace or a graph, where it came from, and why it differs from the value chosen.

Pure: a small registry built here from ``settings_types`` (one setting of each kind the resolver
handles), rows, switches and an environment given as data. ``REGISTRY``, ``WHYS`` and ``env`` are
shared with the validate and snapshot tests.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

import pytest

from backend.app.config.settings_types import (Cap, Choice, Default, Guidance, Legacy,
                                               Recommendation, Requirement, Rule, Setting, Why)
from backend.app.services.settings import resolver as r
from backend.app.services.settings.resolver import EnvReading, Row, Target

S_ = "system_admin"
A_ = "workspace_admin"
PWG = {"platform": S_, "workspace": A_, "graph": A_}
PW = {"platform": S_, "workspace": A_}
P = {"platform": S_}


def _setting(key: str, kind: str, scopes: Dict[str, str], code: Any, *, env: Optional[str] = None,
             attr: Optional[str] = None, **kw) -> Setting:
    return Setting(
        key=key, category=key.split(".")[0], label=key.split(".")[1], kind=kind,
        default=Default(code=code, env=env, attr=attr), scopes=scopes,
        takes_effect=("next_read", "At the next read."),
        guidance=Guidance(summary="s", means="m", effects=(), change_when=(),
                          recommended=Recommendation(value=code, why="w"), risk="low",
                          risk_note="", symptoms=()),
        **kw)


BUILDS, RESIDENCY = "candidateKeysEnabled", "residencyEnabled"
REGISTRY = (
    _setting("reads.mode", "choice", PWG, "latest", env="GRAPHVER_READ_MODE", attr="READ_MODE",
             choices=(Choice("latest", "Always the latest", "", ""),
                      Choice("in_place", "Keep serving, update in place", "", ""),
                      Choice("beside", "Keep serving, switch when ready", "", "", requires=(
                          Requirement(feature=BUILDS, why="builds_off"),
                          Requirement(graph_fact="platform_copy", why="connected_graph")),
                          falls_back_to="in_place")),
             limitable=("allowed", "lock"), default_limits={"allowed": ["latest", "in_place"]},
             routing=True, freshness="strict", legacy=Legacy(build_policy="readMode",
                                                              projection_state_column="read_mode")),
    _setting("reads.maxVersionsBehind", "count_or_unlimited", PWG, "unlimited",
             env="GRAPHVER_READ_MAX_LAG", attr="READ_MAX_LAG", range=(0, 1_000_000),
             legacy=Legacy(encode="minus_one_is_unlimited"),
             requires=(Requirement(setting="reads.mode", one_of=("in_place", "beside"),
                                   why="not_used_by_mode"),)),
    _setting("builds.perWorker", "count", P, 2, env="GRAPHVER_PROJECTION_CANDIDATE_CONCURRENCY",
             attr="PROJECTION_CANDIDATE_CONCURRENCY", range=(1, 8),
             requires=(Requirement(feature=BUILDS, why="switch_off"),),
             caps=(Cap(deployment="GRAPHVER_PROJECTION_CONCURRENCY", why="capped_by_deployment"),),
             legacy=Legacy(build_policy="buildConcurrency")),
    _setting("builds.copyMaxBytes", "bytes_or_unlimited", P, "unlimited",
             env="GRAPHVER_PROJECTION_COPY_MAX_BYTES", attr="PROJECTION_COPY_MAX_BYTES",
             range=(1, 16 * 2 ** 40), requires=(Requirement(feature=BUILDS, why="switch_off"),),
             legacy=Legacy(build_policy="copyMaxBytes", encode="zero_is_unlimited")),
    _setting("updates.pacingRatio", "ratio", P, 0.25, range=(0, 5),
             legacy=Legacy(build_policy="pacingRatio")),
    _setting("database.readsPerGraph", "count", P, 4, range=(1, 64),
             caps=(Cap(setting="database.readsPerProcess", why="capped_by_setting"),),
             rules=(Rule("<=", "database.readsPerProcess"),),
             legacy=Legacy(build_policy="pgReadsPerGraph")),
    _setting("database.readsPerProcess", "count", P, 8, range=(1, 64),
             legacy=Legacy(build_policy="pgReadsPerProcess")),
    _setting("residency.class", "choice", {"platform": S_, "workspace": S_, "graph": S_},
             "standard", choices=(Choice("always", "Always", "", ""),
                                  Choice("standard", "Standard", "", ""),
                                  Choice("coldline", "Coldline", "", "")),
             requires=(Requirement(feature=RESIDENCY, why="switch_off"),),
             materialized="projection_state.residency",
             legacy=Legacy(residency_policy="defaultResidency",
                           platform_column="gv_default_residency",
                           projection_state_column="residency")),
    _setting("residency.unloadStartPct", "percent", P, 80, range=(50, 95),
             requires=(Requirement(feature=RESIDENCY, why="switch_off"),),
             legacy=Legacy(residency_policy="highWaterPct", platform_column="gv_high_water_pct")),
    _setting("residency.unloadStopPct", "percent", P, 70, range=(30, 90),
             requires=(Requirement(feature=RESIDENCY, why="switch_off"),),
             rules=(Rule("<=", "residency.unloadStartPct", margin=5),),
             legacy=Legacy(residency_policy="lowWaterPct", platform_column="gv_low_water_pct")),
    _setting("drafts.keepClosedDays", "days_or_forever", PW, 30,
             env="GRAPHVER_DRAFT_RETENTION_DAYS", attr="DRAFT_RETENTION_DAYS", range=(1, 3650),
             legacy=Legacy(platform_column="gv_draft_retention_days", encode="zero_is_forever")),
    _setting("drafts.levels", "choice", PWG, "any",
             choices=(Choice("any", "Any", "", ""), Choice("public_only", "Public only", "", ""),
                      Choice("private_only", "Private only", "", "")),
             freshness="strict",
             legacy=Legacy(workspace_column="draft_levels", data_source_column="draft_levels")),
    _setting("drafts.defaultVisibility", "choice", PWG, "public",
             choices=(Choice("public", "Public", "", ""), Choice("private", "Private", "", "")),
             uses=("drafts.levels",), freshness="strict",
             legacy=Legacy(workspace_column="draft_default_visibility",
                           data_source_column="draft_default_visibility")),
    _setting("imports.identifier", "identifier", PWG, "entity_id",
             env="GRAPHVER_IMPORT_IDENTIFIER", attr="IMPORT_IDENTIFIER",
             legacy=Legacy(data_source_column="import_identifier")),
    _setting("imports.replaceGuard", "bool", PWG, True, env="IMPORT_REPLACE_GUARD",
             attr="IMPORT_REPLACE_GUARD", limitable=("lock",)),
    _setting("imports.guardDeleteShare", "ratio", PWG, 0.5, range=(0, 1),
             limitable=("range",), default_limits={"range": [0.2, 0.9]},
             requires=(Requirement(setting="imports.replaceGuard", one_of=(True,),
                                   why="guard_off"),),
             legacy=Legacy(data_source_column="import_replace_delete_fraction")),
    _setting("imports.maxRefusedRows", "refusal_budget", PWG, "0", env="IMPORT_MAX_REFUSED_ROWS",
             attr="IMPORT_MAX_REFUSED_ROWS", legacy=Legacy(encode="minus_one_is_unlimited")),
)
WHYS = (
    Why("switch_off", "A switch this needs is off."),
    Why("builds_off", "New-version builds are off.", {"feature": BUILDS, "to": True}),
    Why("connected_graph", "A connected graph's copy isn't the platform's."),
    Why("not_used_by_mode", "Unused in this read mode.", {"setting": "reads.mode",
                                                          "to": "in_place"}),
    Why("capped_by_deployment", "Capped by the deployment."),
    Why("capped_by_setting", "Capped by another setting."),
    Why("locked_by_platform", "Locked for the whole platform."),
    Why("outside_limits_exception", "Outside the limits, kept as an exception."),
    Why("invalid_env", "The deployment's value is invalid."),
    Why("env_out_of_range", "The deployment's value is outside the range."),
    Why("follows_root", "A fork follows its root graph."),
    Why("derived_from_levels", "The allowed draft levels decide it.",
        {"setting": "drafts.levels", "to": "any"}),
    Why("guard_off", "The replace guard is off."),
)
#: What the deployment gives by default here: projection concurrency 8, nothing else of its own.
DEPLOYMENT = {"GRAPHVER_PROJECTION_CONCURRENCY": 8}

WS, DS, FORK = "ws_1", "ds_1", "dsfork_1"
GRAPH = Target("graph", WS, DS, {"platform_copy": True})
WORKSPACE = Target("workspace", WS)


def env(values: Optional[Dict[str, Any]] = None, *, unset: Dict[str, Any] = ()):
    """An environment reader: ``values`` set in the environment, ``unset`` only config's own."""
    given = {**DEPLOYMENT, **(values or {})}
    fallback = dict(unset or {})

    def read(name: str) -> Optional[EnvReading]:
        if name in given:
            return EnvReading(name, given[name], True)
        if name in fallback:
            return EnvReading(name, fallback[name], False)
        return None
    return read


def ctx(*rows: Row, switches: Optional[Dict[str, Any]] = None, environ=None) -> r.Context:
    return r.context(REGISTRY, rows, switches={BUILDS: True, RESIDENCY: True} if switches is None
                     else switches, env=environ or env(), why=WHYS)


def row(key: str, scope: str, value: Any, scope_id: Optional[str] = None, **kw) -> Row:
    sid = {"platform": "", "workspace": WS, "graph": DS}[scope] if scope_id is None else scope_id
    return Row(key, scope, sid, value, **kw)


# ── The chain ─────────────────────────────────────────────────────────────────────────────────────
def test_the_most_specific_scope_wins_and_the_trail_shows_each():
    c = ctx(row("reads.mode", "platform", "latest", version=2),
            row("reads.mode", "workspace", "in_place", version=1))
    at_graph = r.resolve(c, "reads.mode", GRAPH)
    assert (at_graph["effective"], at_graph["declared"], at_graph["source"]) == (
        "in_place", "in_place", "workspace")
    assert at_graph["status"] == "in_effect" and at_graph["why"] == []
    assert at_graph["trail"] == [
        {"scope": "default", "value": "latest", "env": None},
        {"scope": "platform", "value": "latest", "locked": False,
         "limits": {"allowed": ["latest", "in_place"]}},
        {"scope": "workspace", "value": "in_place", "exception": False},
        {"scope": "graph", "value": None}]
    graph_own = ctx(row("reads.mode", "workspace", "in_place"),
                    row("reads.mode", "graph", "latest"))
    assert r.resolve(graph_own, "reads.mode", GRAPH)["source"] == "graph"
    assert r.resolve(c, "reads.mode")["source"] == "platform"
    assert r.resolve(ctx(), "reads.mode", GRAPH)["source"] == "default"


def test_a_value_set_to_none_inherits_and_a_scope_the_setting_lacks_is_not_read():
    c = ctx(row("reads.mode", "graph", None, version=4), row("reads.mode", "workspace", "in_place"),
            row("updates.pacingRatio", "platform", 0.5),
            row("updates.pacingRatio", "graph", 2.0))           # not a graph setting: never read
    assert r.resolve(c, "reads.mode", GRAPH)["source"] == "workspace"
    pacing = r.resolve(c, "updates.pacingRatio", GRAPH)
    assert pacing["effective"] == 0.5 and [t["scope"] for t in pacing["trail"]] == [
        "default", "platform"]
    assert pacing["editor"] is None and pacing["editable"] is False


def test_the_environment_counts_only_when_it_parses_and_is_in_range():
    valid = r.resolve(ctx(environ=env({"GRAPHVER_READ_MODE": "in_place"})), "reads.mode")
    assert (valid["effective"], valid["source"], valid["status"]) == ("in_place", "env",
                                                                     "in_effect")
    assert valid["trail"][0] == {"scope": "default", "value": "in_place",
                                 "env": {"name": "GRAPHVER_READ_MODE", "value": "in_place",
                                         "valid": True}}
    for name, bad, key, code in (
            ("GRAPHVER_READ_MODE", "fastest", "reads.mode", "latest"),
            ("GRAPHVER_IMPORT_IDENTIFIER", "prop.", "imports.identifier", "entity_id"),
            ("IMPORT_MAX_REFUSED_ROWS", "lots", "imports.maxRefusedRows", "0")):
        got = r.resolve(ctx(environ=env({name: bad})), key)
        assert (got["effective"], got["source"], got["status"]) == (code, "default",
                                                                   "invalid_env"), key
        assert got["trail"][0]["env"] == {"name": name, "value": bad, "valid": False}
        assert [w["code"] for w in got["why"]] == ["invalid_env"]
    # The right kind outside its range is held to the range, as the policies before the store held
    # it, and reported: an upgrade never moves a deployment's value further than the range requires.
    held = r.resolve(ctx(environ=env({"GRAPHVER_DRAFT_RETENTION_DAYS": 99_999})),
                     "drafts.keepClosedDays")
    assert (held["effective"], held["declared"], held["source"], held["status"]) == (
        3650, 99_999, "env", "adjusted")
    assert held["trail"][0]["env"] == {"name": "GRAPHVER_DRAFT_RETENTION_DAYS", "value": 99_999,
                                       "valid": False, "held": 3650}
    assert [w["code"] for w in held["why"]] == ["env_out_of_range"]
    # A value chosen on the platform makes the deployment's invalid one beside the point.
    chosen = r.resolve(ctx(row("reads.mode", "platform", "in_place"),
                           environ=env({"GRAPHVER_READ_MODE": "fastest"})), "reads.mode")
    assert chosen["status"] == "in_effect" and chosen["why"] == []


def test_the_environment_keeps_its_old_spellings_for_unlimited_and_forever():
    lag = r.resolve(ctx(row("reads.mode", "platform", "in_place"),
                        environ=env({"GRAPHVER_READ_MAX_LAG": -1})), "reads.maxVersionsBehind")
    assert (lag["effective"], lag["source"]) == ("unlimited", "env")
    assert r.effective(ctx(environ=env({"GRAPHVER_DRAFT_RETENTION_DAYS": 0})),
                       "drafts.keepClosedDays") == "forever"
    assert r.effective(ctx(environ=env({"IMPORT_MAX_REFUSED_ROWS": "-1"})),
                       "imports.maxRefusedRows") == "unlimited"
    assert r.effective(ctx(environ=env({"IMPORT_MAX_REFUSED_ROWS": "0.5%"})),
                       "imports.maxRefusedRows") == "0.5%"
    # Config's own fallback, the variable unset: not the deployment's, so no env entry.
    quiet = r.resolve(ctx(environ=env(unset={"GRAPHVER_READ_MAX_LAG": -1})),
                      "reads.maxVersionsBehind", GRAPH)
    assert quiet["source"] == "default" and quiet["trail"][0]["env"] is None


def test_decode_and_encode_are_each_others_inverse():
    by_key = {s.key: s for s in REGISTRY}
    for key, old, new in (("builds.copyMaxBytes", 0, "unlimited"),
                          ("drafts.keepClosedDays", 0, "forever"),
                          ("reads.maxVersionsBehind", -1, "unlimited"),
                          ("imports.maxRefusedRows", "-1", "unlimited"),
                          ("builds.copyMaxBytes", 2 ** 30, 2 ** 30)):
        assert r.decode(by_key[key], old) == new
        assert r.encode(by_key[key], new) == old


# ── The platform's limits ─────────────────────────────────────────────────────────────────────────
def test_a_lock_ignores_every_scope_below_the_platform():
    c = ctx(row("reads.mode", "platform", "latest", limits={"allowed": ["latest"], "lock": True}),
            row("reads.mode", "workspace", "in_place"), row("reads.mode", "graph", "in_place"))
    got = r.resolve(c, "reads.mode", GRAPH, editor=A_)
    assert (got["effective"], got["source"], got["status"]) == ("latest", "platform", "locked")
    assert [w["code"] for w in got["why"]] == ["locked_by_platform"]
    assert got["trail"][1]["locked"] is True and got["trail"][3]["value"] == "in_place"
    assert got["editable"] is False and got["allowed"] is None
    assert r.resolve(c, "reads.mode", GRAPH, editor=S_)["editable"] is False
    at_platform = r.resolve(c, "reads.mode", editor=S_)
    assert at_platform["status"] == "in_effect" and at_platform["editable"] is True


def test_a_value_outside_the_allowed_choices_stays_in_force_as_an_exception():
    c = ctx(row("reads.mode", "workspace", "beside"))
    got = r.resolve(c, "reads.mode", WORKSPACE)
    assert (got["effective"], got["status"]) == ("beside", "exception")
    assert [w["code"] for w in got["why"]] == ["outside_limits_exception"]
    assert got["trail"][2] == {"scope": "workspace", "value": "beside", "exception": True}
    widened = ctx(row("reads.mode", "platform", None,
                      limits={"allowed": ["latest", "in_place", "beside"]}),
                  row("reads.mode", "workspace", "beside"))
    assert r.resolve(widened, "reads.mode", WORKSPACE)["status"] == "in_effect"


def test_a_value_outside_the_range_limit_stays_in_force_as_an_exception():
    c = ctx(row("imports.guardDeleteShare", "graph", 0.95))
    got = r.resolve(c, "imports.guardDeleteShare", GRAPH)
    assert (got["effective"], got["status"]) == (0.95, "exception")
    assert r.resolve(ctx(row("imports.guardDeleteShare", "graph", 0.6)),
                     "imports.guardDeleteShare", GRAPH)["status"] == "in_effect"


# ── Caps, derived values, requirements ────────────────────────────────────────────────────────────
def test_an_enforced_cap_clamps_and_says_so():
    capped = r.resolve(ctx(row("builds.perWorker", "platform", 6),
                           environ=env({"GRAPHVER_PROJECTION_CONCURRENCY": 3})), "builds.perWorker")
    assert (capped["effective"], capped["declared"], capped["status"]) == (3, 6, "adjusted")
    assert [w["code"] for w in capped["why"]] == ["capped_by_deployment"]
    # Never under the setting's own minimum: today's max(1, PROJECTION_CONCURRENCY).
    assert r.effective(ctx(row("builds.perWorker", "platform", 6),
                           environ=env({"GRAPHVER_PROJECTION_CONCURRENCY": 0})),
                       "builds.perWorker") == 1
    by_setting = r.resolve(ctx(row("database.readsPerGraph", "platform", 16),
                               row("database.readsPerProcess", "platform", 10)),
                           "database.readsPerGraph")
    assert by_setting["effective"] == 10 and by_setting["why"][0]["code"] == "capped_by_setting"
    assert r.resolve(ctx(), "database.readsPerGraph")["status"] == "in_effect"


def test_a_rule_with_a_margin_holds_the_pair_in_order_as_today():
    got = r.resolve(ctx(row("residency.unloadStartPct", "platform", 80),
                        row("residency.unloadStopPct", "platform", 78)), "residency.unloadStopPct")
    assert (got["effective"], got["status"]) == (75, "adjusted")
    assert [w["code"] for w in got["why"]] == ["capped_by_setting"]
    assert r.effective(ctx(), "residency.unloadStopPct") == 70


def test_allowed_draft_levels_force_the_new_draft_visibility():
    c = ctx(row("drafts.levels", "workspace", "private_only"),
            row("drafts.defaultVisibility", "graph", "public"))
    got = r.resolve(c, "drafts.defaultVisibility", GRAPH)
    assert (got["effective"], got["declared"], got["status"]) == ("private", "public", "adjusted")
    assert got["source"] == "workspace"                       # the levels' source
    assert got["why"] == [{"code": "derived_from_levels",
                           "text": "The allowed draft levels decide it.",
                           "fix": {"setting": "drafts.levels", "to": "any"}}]
    assert r.effective(ctx(), "drafts.defaultVisibility", GRAPH) == "public"


def test_a_setting_whose_switch_is_off_is_dormant_with_the_switch_to_turn_on():
    got = r.resolve(ctx(row("builds.perWorker", "platform", 3), switches={}), "builds.perWorker")
    assert (got["effective"], got["status"]) == (3, "dormant")
    assert got["why"] == [{"code": "switch_off", "text": "A switch this needs is off.",
                           "fix": {"feature": BUILDS, "to": True}}]
    unreadable = ctx(switches={BUILDS: None})                 # unread is not on
    assert r.resolve(unreadable, "builds.copyMaxBytes")["status"] == "dormant"


@pytest.mark.parametrize("switches, facts, codes", [
    ({BUILDS: False, RESIDENCY: True}, {"platform_copy": True}, ["builds_off"]),
    ({BUILDS: True, RESIDENCY: True}, {"platform_copy": False}, ["connected_graph"]),
    ({BUILDS: False, RESIDENCY: True}, {"platform_copy": False},
     ["builds_off", "connected_graph"]),
])
def test_switch_when_ready_falls_back_to_update_in_place_and_says_why(switches, facts, codes):
    c = ctx(row("reads.mode", "platform", None,
                limits={"allowed": ["latest", "in_place", "beside"]}),
            row("reads.mode", "graph", "beside", version=3), switches=switches)
    got = r.resolve(c, "reads.mode", Target("graph", WS, DS, facts), editor=A_)
    assert (got["effective"], got["declared"], got["source"], got["status"]) == (
        "in_place", "beside", "graph", "adjusted")
    assert [w["code"] for w in got["why"]] == codes
    if "builds_off" in codes:
        assert got["why"][0]["fix"] == {"feature": BUILDS, "to": True}
    assert got["version"] == 3


def test_switch_when_ready_holds_where_it_can_and_a_graph_fact_left_out_is_not_held_against_it():
    c = ctx(row("reads.mode", "platform", "beside"))
    assert r.resolve(c, "reads.mode")["status"] == "in_effect"
    assert r.effective(c, "reads.mode", Target("graph", WS, DS)) == "beside"
    assert r.effective(c, "reads.mode", GRAPH) == "beside"


def test_a_setting_another_makes_unused_is_not_used():
    latest = r.resolve(ctx(row("reads.maxVersionsBehind", "platform", 5)),
                       "reads.maxVersionsBehind")
    assert (latest["effective"], latest["status"]) == (5, "not_used")
    assert latest["why"] == [{"code": "not_used_by_mode", "text": "Unused in this read mode.",
                              "fix": {"setting": "reads.mode", "to": "in_place"}}]
    in_place = ctx(row("reads.mode", "platform", "in_place"),
                   row("reads.maxVersionsBehind", "platform", 5))
    assert r.resolve(in_place, "reads.maxVersionsBehind")["status"] == "in_effect"
    guard_off = r.resolve(ctx(row("imports.replaceGuard", "workspace", False)),
                          "imports.guardDeleteShare", GRAPH)
    assert guard_off["status"] == "not_used"
    assert guard_off["why"][0]["fix"] == {"setting": "imports.replaceGuard", "to": True}


def test_a_fork_resolves_through_its_root_and_is_read_only():
    c = ctx(row("reads.mode", "graph", "in_place", scope_id=DS, version=2),
            row("reads.mode", "graph", "latest", scope_id=FORK))   # never read: a fork has none
    fork = Target("graph", WS, FORK, {"fork_of": DS, "platform_copy": True})
    got = r.resolve(c, "reads.mode", fork, editor=S_)
    assert (got["effective"], got["source"]) == ("in_place", "graph")
    assert got["trail"][-1] == {"scope": "graph", "value": "in_place", "exception": False}
    assert [w["code"] for w in got["why"]] == ["follows_root"]
    assert got["editable"] is False and got["editor"] == A_
    assert r.effective(c, "reads.mode", fork) == "in_place"


# ── Editors ───────────────────────────────────────────────────────────────────────────────────────
def test_what_an_editor_may_change_and_choose():
    c = ctx(row("reads.mode", "workspace", "latest", version=5))
    admin = r.resolve(c, "reads.mode", WORKSPACE, editor=A_)
    assert (admin["editable"], admin["editor"], admin["allowed"], admin["version"]) == (
        True, A_, ["latest", "in_place"], 5)
    system = r.resolve(c, "reads.mode", WORKSPACE, editor=S_)
    assert system["allowed"] == ["latest", "in_place", "beside"]
    assert r.resolve(c, "reads.mode", editor=A_)["editable"] is False       # the platform's
    assert r.resolve(c, "reads.mode", WORKSPACE)["editable"] is False       # no role
    memory = r.resolve(c, "residency.class", WORKSPACE, editor=A_)
    assert (memory["editable"], memory["editor"]) == (False, S_)
    assert r.resolve(c, "residency.class", WORKSPACE, editor=S_)["editable"] is True
    ranged = r.resolve(c, "imports.guardDeleteShare", GRAPH, editor=A_)
    assert ranged["allowed"] == {"min": 0.2, "max": 0.9}
    assert r.resolve(c, "imports.guardDeleteShare", GRAPH, editor=S_)["allowed"] == {
        "min": 0, "max": 1}


# ── Stored values the resolver can't take as they are ────────────────────────────────────────────
def test_a_stored_value_out_of_its_range_is_held_in_it_and_one_of_the_wrong_kind_is_skipped():
    held = r.resolve(ctx(row("database.readsPerProcess", "platform", 500)),
                     "database.readsPerProcess")
    assert (held["effective"], held["declared"], held["status"]) == (64, 500, "adjusted")
    skipped = r.resolve(ctx(row("reads.mode", "workspace", "fastest"),
                            row("reads.mode", "platform", "in_place")), "reads.mode", WORKSPACE)
    assert (skipped["effective"], skipped["source"]) == ("in_place", "platform")


def test_the_hot_path_gives_what_the_full_answer_gives():
    c = ctx(row("reads.mode", "platform", "beside"), row("drafts.levels", "graph", "public_only"),
            row("database.readsPerGraph", "platform", 40),
            row("database.readsPerProcess", "platform", 12),
            row("builds.copyMaxBytes", "platform", "unlimited"),
            switches={BUILDS: False}, environ=env({"GRAPHVER_PROJECTION_CONCURRENCY": 1}))
    for target in (r.PLATFORM, WORKSPACE, GRAPH,
                   Target("graph", WS, FORK, {"fork_of": DS, "platform_copy": False})):
        full = r.resolve_all(c, target)
        assert {k: v["effective"] for k, v in full.items()} == {
            s.key: r.effective(c, s.key, target) for s in REGISTRY}

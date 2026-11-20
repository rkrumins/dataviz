"""What a proposed settings change set may not do (``services.settings.validate``): every error
code, on the registry the resolver's tests build."""
from __future__ import annotations

from typing import Any

import pytest

from backend.app.services.settings.resolver import PLATFORM
from backend.app.services.settings.store import KEEP, Change
from backend.app.services.settings.validate import SettingNotPermitted, validate
from backend.tests.test_settings_resolver import A_, DS, GRAPH, S_, WORKSPACE, WS, ctx, row


def _change(key: str, target, value: Any = KEEP, limits: Any = KEEP) -> Change:
    scope_id = {"platform": "", "workspace": WS, "graph": DS}[target.scope]
    return Change(key, target.scope, scope_id, expected_version=0, value=value, limits=limits)


def _codes(c, target, *changes, editor=S_):
    return [(e["key"], e["code"]) for e in validate(c, target, list(changes), editor=editor)]


def test_a_sound_change_set_passes():
    assert _codes(ctx(), PLATFORM,
                  _change("reads.mode", PLATFORM, "beside",
                          limits={"allowed": ["latest", "in_place", "beside"], "lock": False}),
                  _change("builds.copyMaxBytes", PLATFORM, "unlimited"),
                  _change("drafts.keepClosedDays", PLATFORM, "forever"),
                  _change("imports.maxRefusedRows", PLATFORM, "0.5%"),
                  _change("imports.identifier", PLATFORM, "prop.code,urn"),
                  _change("updates.pacingRatio", PLATFORM, 1.5),
                  _change("imports.guardDeleteShare", PLATFORM, None, limits=None)) == []
    assert _codes(ctx(), GRAPH, _change("reads.mode", GRAPH, "in_place"),
                  _change("imports.maxRefusedRows", GRAPH, "unlimited"), editor=A_) == []


def test_an_unknown_setting_and_one_not_chosen_at_this_scope():
    assert _codes(ctx(), PLATFORM, _change("reads.fastest", PLATFORM, 1)) == [
        ("reads.fastest", "unknown_setting")]
    assert _codes(ctx(), WORKSPACE, _change("updates.pacingRatio", WORKSPACE, 1.0)) == [
        ("updates.pacingRatio", "not_at_scope")]


def test_a_value_the_editor_may_not_set_is_refused_naming_who_may():
    with pytest.raises(SettingNotPermitted) as refused:
        validate(ctx(), WORKSPACE, [_change("residency.class", WORKSPACE, "always"),
                                    _change("reads.mode", WORKSPACE, "latest")], editor=A_)
    assert refused.value.code == "setting_not_permitted"
    assert refused.value.denied == [{
        "key": "residency.class", "code": "setting_not_permitted", "editor": S_,
        "message": "Only a system administrator may set class for a workspace"}]
    with pytest.raises(SettingNotPermitted):
        validate(ctx(), PLATFORM, [_change("reads.mode", PLATFORM, "latest")], editor=A_)
    assert _codes(ctx(), WORKSPACE, _change("residency.class", WORKSPACE, "always")) == []


@pytest.mark.parametrize("key, value, code", [
    ("imports.replaceGuard", "yes", "invalid_value"),
    ("database.readsPerProcess", 1.5, "invalid_value"),
    ("database.readsPerProcess", True, "invalid_value"),
    ("builds.copyMaxBytes", "forever", "invalid_value"),
    ("database.readsPerProcess", 100, "out_of_range"),
    ("drafts.keepClosedDays", 0, "out_of_range"),
    ("updates.pacingRatio", 7.5, "out_of_range"),
    ("reads.mode", "fastest", "invalid_choice"),
    ("imports.identifier", "prop.", "invalid_identifier"),
    ("imports.identifier", "prop.code , urn", "invalid_identifier"),   # not as the import writes it
    ("imports.identifier", 7, "invalid_identifier"),
    ("imports.maxRefusedRows", "-1", "invalid_budget"),                 # the old spelling
    ("imports.maxRefusedRows", "lots", "invalid_budget"),
    ("imports.maxRefusedRows", "120%", "invalid_budget"),
])
def test_a_value_not_of_its_kind(key, value, code):
    errors = validate(ctx(), PLATFORM, [_change(key, PLATFORM, value)], editor=S_)
    assert [(e["key"], e["code"]) for e in errors] == [(key, code)]
    assert errors[0]["message"]


def test_a_rule_is_checked_on_the_values_that_would_be_chosen():
    c = ctx(row("database.readsPerProcess", "platform", 8))
    errors = validate(c, PLATFORM, [_change("database.readsPerGraph", PLATFORM, 16)], editor=S_)
    assert errors == [{"key": "database.readsPerGraph", "code": "rule_violated",
                       "message": "readsPerGraph (16) may not be more than readsPerProcess (8)"}]
    lowered = validate(ctx(row("database.readsPerGraph", "platform", 6)), PLATFORM,
                       [_change("database.readsPerProcess", PLATFORM, 4)], editor=S_)
    assert [(e["key"], e["code"]) for e in lowered] == [("database.readsPerProcess",
                                                         "rule_violated")]
    margin = validate(ctx(), PLATFORM, [_change("residency.unloadStopPct", PLATFORM, 78)],
                      editor=S_)
    assert margin[0]["code"] == "rule_violated" and "- 5" in margin[0]["message"]
    assert _codes(ctx(), PLATFORM, _change("residency.unloadStopPct", PLATFORM, 75)) == []
    # Both together, in order: fine; an unrelated save is not held to a rule it isn't in.
    assert _codes(c, PLATFORM, _change("database.readsPerGraph", PLATFORM, 16),
                  _change("database.readsPerProcess", PLATFORM, 16)) == []
    broken = ctx(row("database.readsPerGraph", "platform", 16),
                 row("database.readsPerProcess", "platform", 8))
    assert _codes(broken, PLATFORM, _change("updates.pacingRatio", PLATFORM, 1.0)) == []


def test_nothing_may_be_chosen_below_a_lock():
    c = ctx(row("imports.replaceGuard", "platform", True, limits={"lock": True}))
    for editor in (A_, S_):
        assert _codes(c, GRAPH, _change("imports.replaceGuard", GRAPH, False), editor=editor) == [
            ("imports.replaceGuard", "locked")]
    assert _codes(c, GRAPH, _change("imports.replaceGuard", GRAPH, None), editor=A_) == []


def test_a_workspace_admin_chooses_within_the_platforms_limits_and_a_system_admin_needs_not():
    assert _codes(ctx(), WORKSPACE, _change("reads.mode", WORKSPACE, "beside"), editor=A_) == [
        ("reads.mode", "outside_limits")]
    assert _codes(ctx(), GRAPH, _change("imports.guardDeleteShare", GRAPH, 0.95), editor=A_) == [
        ("imports.guardDeleteShare", "outside_limits")]
    assert _codes(ctx(), WORKSPACE, _change("reads.mode", WORKSPACE, "beside"), editor=S_) == []
    widened = ctx(row("reads.mode", "platform", None,
                      limits={"allowed": ["latest", "in_place", "beside"]}))
    assert _codes(widened, WORKSPACE, _change("reads.mode", WORKSPACE, "beside"), editor=A_) == []


def test_limits_are_the_platforms_and_say_only_what_the_setting_is_limitable_by():
    assert _codes(ctx(), WORKSPACE, _change("reads.mode", WORKSPACE, limits={"lock": True})) == [
        ("reads.mode", "limits_not_on_platform")]
    for limits in ({"range": [0, 1]},                         # reads.mode has no range limit
                   {"allowed": ["latest", "fastest"]},
                   {"lock": "yes"},
                   ["latest"]):
        assert _codes(ctx(), PLATFORM, _change("reads.mode", PLATFORM, limits=limits)) == [
            ("reads.mode", "invalid_limits")], limits
    for limits in ({"range": [0.9, 0.2]}, {"range": [0, 2]}, {"range": [0.1]}):
        assert _codes(ctx(), PLATFORM, _change("imports.guardDeleteShare", PLATFORM,
                                               limits=limits)) == [
            ("imports.guardDeleteShare", "invalid_limits")], limits
    assert _codes(ctx(), PLATFORM, _change("updates.pacingRatio", PLATFORM,
                                           limits={"lock": True})) == [
        ("updates.pacingRatio", "invalid_limits")]

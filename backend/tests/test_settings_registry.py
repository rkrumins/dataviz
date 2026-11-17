"""The settings registry may not claim more than the code does, nor ship a setting it can't explain.

`backend/app/config/versioned_graph_settings.py` describes every versioned-graph setting once, and
the API, the app's catalogue and the guide are generated from it. Its words are UI copy, and its
facts are claims about the code. These tests hold both:

  * every setting carries its whole explanation, in the words the app uses, with no engineering
    jargon outside ``evidence`` and a term's ``technical`` note;
  * every default is the one ``versioning/config.py`` reads, from the env var the setting names;
  * every value the build and residency policies, the drafts policy and the import settings store
    today belongs to exactly one setting, with that code's range and choices;
  * every setting is read by the code, outside the registry and the settings framework, unless it
    is exempted with why;
  * memory-heavy settings are system administrators' at every scope;
  * every name a setting points at (rules, caps, requirements, uses, why codes) exists;
  * examples, postures and recommendations render, with and without live facts;
  * every profile's values are values their settings take, settable where the profile applies,
    and it names each feature switch it relies on; Balanced is the built-in values;
  * every signal is one of the fixed counters and answers a symptom its settings name;
  * the generated guide has the anchor each setting's ``docs`` link points at, and a section for
    each profile.

Pure ``ast``/``pathlib`` and the stdlib-only registry: no app, no database. CI runs it with
``--noconftest`` (.github/workflows/alembic-guards.yml).
"""
from __future__ import annotations

import ast
import json
import math
import operator
import re
import typing
from pathlib import Path

import pytest

from backend.app.config import settings_types as types
from backend.app.config.feature_wiring import FEATURE_WIRING
from backend.app.config.features_seed import SEED_DEFINITIONS
from backend.app.config.versioned_graph_settings import (
    BY_KEY,
    CATEGORIES,
    DEPLOYMENT,
    GLOSSARY,
    PROFILES,
    RETIRED,
    SETTINGS,
    SIGNALS,
    WHY,
    schema_json,
)

_REPO = Path(__file__).resolve().parents[2]
_APP = _REPO / "backend" / "app"
_VERSIONING = _APP / "services" / "versioning"
_GUIDE = _REPO / "docs" / "guide" / "VERSIONED_GRAPH_SETTINGS.md"
_KEYS = [s.key for s in SETTINGS]

#: The contract's settings (the store, the API and the app are built against these keys).
_CONTRACT_KEYS = (
    "reads.mode", "reads.maxVersionsBehind",
    "updates.statementTargetMs", "updates.writeCeilingSecs", "updates.pacingRatio",
    "updates.readPressureRatio", "updates.retireGraceSecs",
    "builds.aboveRows", "builds.forRebuilds", "builds.method", "builds.copyRoomPct",
    "builds.copyMaxBytes", "builds.noRoom", "builds.noRoomAlertSecs", "builds.perWorker",
    "builds.maxAttempts", "builds.switchMaxLagRows",
    "residency.class", "residency.autoUnload", "residency.standardIdleSecs",
    "residency.coldlineIdleSecs", "residency.unloadStartPct", "residency.unloadStopPct",
    "residency.loadMarginPct", "residency.bytesPerEntity", "residency.coldlineLoadAbove",
    "residency.capacityIntervalSecs",
    "database.readTimeoutMs", "database.readsPerGraph", "database.readsPerProcess",
    "drafts.keepClosedDays", "drafts.idleCloseDays", "drafts.defaultVisibility", "drafts.levels",
    "drafts.selfApproval", "drafts.selfMerge", "forks.maxPerGraph", "trash.restoreDays",
    "imports.identifier", "imports.replaceGuard", "imports.guardMinLive",
    "imports.guardDeleteShare", "imports.guardCreateShare", "imports.minMatchShare",
    "imports.maxRefusedRows", "imports.maxMatchingProperties",
)
_CONTRACT_WHY = ("switch_off", "builds_off", "connected_graph", "not_used_by_mode",
                 "capped_by_deployment", "capped_by_setting", "locked_by_platform",
                 "outside_limits_exception", "invalid_env", "follows_root", "derived_from_levels",
                 "guard_off")
_MEMORY_HEAVY = ("residency.", "builds.", "updates.", "database.", "imports.maxMatchingProperties")
#: The insight contract's profiles, and its signals' fixed ids (the counters bump them by these).
_CONTRACT_PROFILES = ("balanced", "fastest-reads", "least-memory", "always-exact", "big-import-tonight")
_SIGNAL_IDS = ("builds.waited_for_room", "builds.copy_timed_out", "builds.dropped",
               "reads.asked_to_retry", "reads.from_database_while_behind",
               "residency.unloaded_under_pressure", "residency.load_waited_for_room",
               "imports.replace_refused_by_guard", "imports.replace_stopped_low_match",
               "drafts.idle_closed", "drafts.changes_removed")

#: Live facts the store provides, for rendering recommendations here.
_FACTS = {
    "largestGraphBytes": 6 * (1 << 30),
    "nodes": [{"name": "node-a", "usedBytes": 9 * (1 << 30), "maxBytes": 16 * (1 << 30)},
              {"name": "node-b", "usedBytes": 4 * (1 << 30), "maxBytes": 16 * (1 << 30)}],
    "graphCount": 40, "poolSize": 10, "projectionConcurrency": 8, "readerProcesses": 6,
}

#: Words that belong in ``evidence`` and a term's ``technical`` note, never in what the app shows.
_JARGON = re.compile(
    r"\b(FalkorDB|Postgres\w*|GRAPH\.COPY|watermarks?|serving_seq|projections?|projectors?|evict\w*|"
    r"candidates?|rehydrat\w*|(?:re)?seed\w*|masters?|keys?|leases?|graphver|Redis)\b", re.I)


# ── Parsing the code the registry describes ───────────────────────────────────

def _module(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"))


def _assignments(path: Path) -> dict:
    """A module's top-level ``NAME = value``, ``A, B = a, b`` and ``NAME: type = value``, by name."""
    out = {}
    for node in _module(path).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            out.setdefault(node.targets[0].id, node.value)
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Tuple) and isinstance(node.value, ast.Tuple) \
                and len(node.targets[0].elts) == len(node.value.elts):
            for name, value in zip(node.targets[0].elts, node.value.elts, strict=True):
                if isinstance(name, ast.Name):
                    out.setdefault(name.id, value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value:
            out.setdefault(node.target.id, node.value)
    return out


_CONFIG = _assignments(_VERSIONING / "config.py")


def _env_name(expr: ast.AST):
    """The env var an expression reads with ``os.getenv(NAME, ...)``."""
    for node in ast.walk(expr):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "getenv" and node.args \
                and isinstance(node.args[0], ast.Constant):
            return node.args[0].value
    return None


_ARITHMETIC = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
               ast.Pow: operator.pow}


def _evaluate(expr: ast.AST, names: dict):
    """What a module-level expression gives with every env var unset: literals, arithmetic, names
    defined earlier in the module, and ``os.getenv`` reads converted with int/float/str/lower."""
    if isinstance(expr, ast.Constant):
        return expr.value
    if isinstance(expr, ast.Name):
        return _evaluate(names[expr.id], names)
    if isinstance(expr, ast.Tuple):
        out = []
        for e in expr.elts:
            if isinstance(e, ast.Starred):
                out.extend(_evaluate(e.value, names))
            else:
                out.append(_evaluate(e, names))
        return tuple(out)
    if isinstance(expr, ast.Dict):
        return {_evaluate(k, names): _evaluate(v, names)
                for k, v in zip(expr.keys, expr.values, strict=True)}
    if isinstance(expr, ast.BinOp) and type(expr.op) in _ARITHMETIC:
        return _ARITHMETIC[type(expr.op)](_evaluate(expr.left, names), _evaluate(expr.right, names))
    if isinstance(expr, ast.Call):
        func = expr.func
        if isinstance(func, ast.Attribute) and func.attr == "getenv":
            return _evaluate(expr.args[1], names) if len(expr.args) > 1 else None
        if isinstance(func, ast.Attribute) and func.attr == "lower":
            return _evaluate(func.value, names).lower()
        if isinstance(func, ast.Name) and func.id in ("int", "float", "str"):
            return {"int": int, "float": float, "str": str}[func.id](_evaluate(expr.args[0], names))
    if isinstance(expr, ast.Compare) and len(expr.ops) == 1:
        left, right = _evaluate(expr.left, names), _evaluate(expr.comparators[0], names)
        op = type(expr.ops[0])
        if op is ast.Eq:
            return left == right
        if op is ast.In:
            return left in right
        if op is ast.NotIn:
            return left not in right
    raise AssertionError(f"config.py: can't evaluate {ast.unparse(expr)}")


def _decoded(value, encode):
    """An env default as the registry holds it: the words for 'no limit' and 'for good'."""
    if encode == "minus_one_is_unlimited" and str(value) == "-1":
        return "unlimited"
    if encode == "zero_is_unlimited" and value == 0:
        return "unlimited"
    if encode == "zero_is_forever" and value == 0:
        return "forever"
    return value


def _build_policy_fields() -> list:
    """``build_policy.FIELDS`` as (wire, the config attribute its default reads, its range or None,
    the name of its choices or None)."""
    out = []
    for call in _assignments(_VERSIONING / "build_policy.py")["FIELDS"].elts:
        kw = {k.arg: k.value for k in call.keywords}
        bounds = (_evaluate(kw["lo"], {}), _evaluate(kw["hi"], {})) if "hi" in kw else None
        out.append((call.args[0].value, call.args[1].body.attr, bounds,
                    ast.unparse(kw["choices"]) if "choices" in kw else None))
    return out


def _literal(path: Path, name: str):
    """A module-level constant's value, read without importing the module."""
    return _evaluate(_assignments(path)[name], {})


# ── The registry is the contract's ────────────────────────────────────────────

def test_the_registry_holds_the_contracts_settings():
    """The store, the API and the app are built against these keys: renaming or adding one is a
    change to the contract, made there first."""
    assert tuple(_KEYS) == _CONTRACT_KEYS
    assert len(BY_KEY) == len(SETTINGS) == 46


def test_categories_are_seven_and_every_setting_sits_in_one_of_their_sections():
    assert [c.order for c in CATEGORIES] == list(range(1, 8))
    ids = {c.id: c for c in CATEGORIES}
    assert len(ids) == 7
    for s in SETTINGS:
        assert s.category in ids, s.key
        assert s.section in {sid for sid, _ in ids[s.category].sections}, s.key
    for c in CATEGORIES:
        assert c.label and c.summary and c.icon and c.posture, c.id
        assert len({sid for sid, _ in c.sections}) == len(c.sections), c.id
        if c.master_switch:
            assert c.master_switch in FEATURE_WIRING, c.id


# ── Every setting explains itself ─────────────────────────────────────────────

@pytest.mark.parametrize("key", _KEYS)
def test_every_guidance_field_is_filled(key: str):
    """A setting the app can't explain can't ship: an admin would be choosing blind."""
    s, g = BY_KEY[key], BY_KEY[key].guidance
    assert s.label.strip() and s.takes_effect[1].strip()
    for name in ("summary", "means", "risk_note", "evidence"):
        assert getattr(g, name).strip(), f"{key}: guidance.{name} is empty"
    assert g.effects, f"{key}: no effects"
    assert g.change_when and all(w.strip() for w in g.change_when), key
    assert g.symptoms and all(w.strip() for w in g.symptoms), key
    assert g.aliases and all(w.strip() for w in g.aliases), key
    assert g.recommended.value is not None and g.recommended.why.strip(), key
    assert g.risk in typing.get_args(types.Risk), key
    assert callable(g.example), key
    assert s.takes_effect[0] in typing.get_args(types.TakesEffect), key


@pytest.mark.parametrize("key", _KEYS)
def test_effects_name_real_dimensions_once_each(key: str):
    effects = BY_KEY[key].guidance.effects
    dimensions = [e.dimension for e in effects]
    assert set(dimensions) <= set(types.DIMENSIONS), f"{key}: unknown dimension in {dimensions}"
    assert len(dimensions) == len(set(dimensions)), f"{key}: a dimension twice in {dimensions}"
    for e in effects:
        assert e.up.strip() and e.down.strip(), f"{key}: {e.dimension} says nothing"
        assert e.weight in typing.get_args(types.Weight), key
        assert e.up_verdict in ("better", "worse"), f"{key}: {e.dimension} has no up_verdict"


def test_every_setting_asks_its_question():
    """The business lens asks every setting as a plain question, the platform team's tuning
    among them; the business settings, which it shows first, are the contract's."""
    for s in SETTINGS:
        assert s.question.strip().endswith("?"), s.key
    business = {s.key for s in SETTINGS if s.audience == "business"}
    expected = {k for k in _KEYS if k.split(".")[0] in ("reads", "drafts", "forks", "trash",
                                                         "imports")} | {"residency.class"}
    assert business == expected


def test_no_engineering_words_in_what_the_app_shows():
    """The copy rules, enforced: the graph store and the database, a copy (never a key), unloading
    and loading. The engineering words live in ``evidence`` and a term's ``technical`` note."""
    def shown():
        for s in SETTINGS:
            g = s.guidance
            yield s.key, [s.label, s.question, s.takes_effect[1], g.summary, g.means,
                          g.recommended.why, g.risk_note, *g.change_when, *g.symptoms,
                          *(t for e in g.effects for t in (e.up, e.down))]
            for c in s.choices:
                yield f"{s.key}:{c.id}", [c.title, c.short, c.promise, c.good_for, c.needs,
                                          c.example, *c.pros, *c.cons,
                                          *(text for _v, text in c.effects.values()),
                                          *(t for f in c.frames for t in (f.shows, f.note))]
        for c in CATEGORIES:
            yield c.id, [c.label, c.summary, *(title for _id, title in c.sections),
                         *(c.posture({}, sw) for sw in ({}, {c.master_switch: True},
                                                       {c.master_switch: False}))]
        yield "glossary", [t for term in GLOSSARY for t in (term.term, term.definition)]
        yield "why", [w.text for w in WHY]
        yield "deployment", [t for d in DEPLOYMENT for t in (d.label, d.means)]
        yield "retired", [r.why for r in RETIRED]
        for p in PROFILES:
            yield f"profile:{p.id}", [p.title, p.promise, p.caution, *p.when]
        yield "signals", [t for sig in SIGNALS for t in (sig.label, sig.symptom, sig.unit)]
        for doc in (schema_json(), schema_json(facts=_FACTS)):
            for item in doc["settings"]:
                rec = item["guidance"]["recommended"]["forThisPlatform"]
                yield item["key"], [item["guidance"]["example"], rec["why"] if rec else ""]

    found = [f"{where}: {m.group(0)!r} in {text!r}" for where, texts in shown() for text in texts
             for m in [_JARGON.search(text or "")] if m]
    assert not found, "jargon in UI copy:\n" + "\n".join(found)


def test_copy_the_platform_and_workspaces_show_names_no_one_graph():
    """A setting a platform or workspace page shows says nothing of "this graph" (nor "this
    workspace" on the platform's); nor does a why, which can hold at any scope."""
    one = re.compile(r"\bthis (graph|workspace)\b", re.IGNORECASE)
    found = [f"{s.key}: {text!r}" for s in SETTINGS if set(s.scopes) - {"graph"}
             for text in (s.label, s.question, s.takes_effect[1], s.guidance.summary,
                          s.guidance.means, s.guidance.recommended.why, s.guidance.risk_note,
                          *s.guidance.change_when)
             if one.search(text or "")]
    found += [f"why {w.code}: {w.text!r}" for w in WHY if one.search(w.text)]
    assert not found, "\n".join(found)


# ── Names point at things that exist ──────────────────────────────────────────

def test_every_reference_names_a_setting_a_switch_or_a_why():
    whys = {w.code for w in WHY}
    for s in SETTINGS:
        requirements = [*s.requires, *(r for c in s.choices for r in c.requires)]
        for r in requirements:
            assert r.why in whys, f"{s.key}: unknown why {r.why!r}"
            assert r.feature or r.setting or r.graph_fact, s.key
            if r.feature:
                assert r.feature in FEATURE_WIRING, f"{s.key}: unknown switch {r.feature}"
            if r.setting:
                assert r.setting in BY_KEY and r.one_of, f"{s.key}: requires {r.setting}"
        for rule in s.rules:
            assert rule.other in BY_KEY and rule.other != s.key, f"{s.key}: rule on {rule.other}"
        for cap in s.caps:
            assert (cap.setting in BY_KEY) != bool(cap.deployment), f"{s.key}: cap names one thing"
            assert cap.why in whys, s.key
        for other in s.uses:
            assert other in BY_KEY and other != s.key, f"{s.key}: uses {other}"
    for w in WHY:
        fix = w.fix or {}
        if "feature" in fix:
            assert fix["feature"] in FEATURE_WIRING, w.code
        if "setting" in fix:
            assert fix["setting"] in BY_KEY, w.code


def test_every_why_code_the_contract_lists_has_its_words():
    codes = [w.code for w in WHY]
    assert len(codes) == len(set(codes))
    assert set(_CONTRACT_WHY) <= set(codes), f"missing: {set(_CONTRACT_WHY) - set(codes)}"
    assert all(w.text.strip() for w in WHY)


def test_the_replace_guard_switch_governs_only_its_two_shares():
    """``import_worker._fail_fast`` reads minMatchFraction and minLive whether or not the guard is
    on; only ``replace_verdict``'s delete and create shares go quiet with it off."""
    governed = {s.key for s in SETTINGS for r in s.requires if r.setting == "imports.replaceGuard"}
    assert governed == {"imports.guardDeleteShare", "imports.guardCreateShare"}


# ── Defaults and ranges are the code's ────────────────────────────────────────

@pytest.mark.parametrize("key", _KEYS)
def test_the_default_is_what_versioning_config_reads(key: str):
    """``Default.attr`` is the ``versioning.config`` attribute, reading ``Default.env``, and with
    the env unset it gives ``Default.code`` (in the registry's words for no limit and for good)."""
    s = BY_KEY[key]
    d = s.default
    assert (d.env is None) == (d.attr is None), key
    if d.attr is None:
        return
    assert d.attr in _CONFIG, f"{key}: config.py has no {d.attr}"
    assert _env_name(_CONFIG[d.attr]) == d.env, f"{key}: config.{d.attr} doesn't read {d.env}"
    value = _decoded(_evaluate(_CONFIG[d.attr], _CONFIG), s.legacy.encode if s.legacy else None)
    assert value == d.code and type(value) is type(d.code), \
        f"{key}: config.{d.attr} defaults to {value!r}, the registry says {d.code!r}"


@pytest.mark.parametrize("key", _KEYS)
def test_defaults_and_recommendations_are_values_the_setting_takes(key: str):
    s = BY_KEY[key]
    for value in (s.default.code, s.guidance.recommended.value):
        if s.kind == "choice":
            assert value in {c.id for c in s.choices}, f"{key}: {value!r} is no choice"
        elif s.kind == "bool":
            assert isinstance(value, bool), key
        elif s.kind == "identifier":
            assert re.fullmatch(r"entity_id|urn|prop\.[^,]+(,urn)?", value), key
        elif s.kind == "refusal_budget":
            assert re.fullmatch(r"unlimited|\d+|\d+(\.\d+)?%", value), key
        elif value not in ("unlimited", "forever"):
            assert s.range and s.range[0] <= value <= s.range[1], f"{key}: {value!r} out of range"
        else:
            assert s.kind.endswith(("_or_unlimited", "_or_forever")), key


def test_build_policy_wires_each_belong_to_one_setting_with_the_codes_range():
    by_wire = {}
    for s in SETTINGS:
        if s.legacy and s.legacy.build_policy:
            by_wire.setdefault(s.legacy.build_policy, []).append(s)
    fields = _build_policy_fields()
    assert sorted(by_wire) == sorted(w for w, *_ in fields)
    choices = {"config.READ_MODES": _evaluate(_CONFIG["READ_MODES"], _CONFIG),
               "MODES": _literal(_VERSIONING / "build_policy.py", "MODES"),
               "NO_ROOM": _literal(_VERSIONING / "build_policy.py", "NO_ROOM")}
    for wire, attr, bounds, choice_name in fields:
        assert len(by_wire[wire]) == 1, f"{wire} is {len(by_wire[wire])} settings' legacy"
        s = by_wire[wire][0]
        assert s.default.attr == attr, f"{s.key}: build_policy reads config.{attr}"
        if choice_name:
            assert tuple(c.id for c in s.choices) == tuple(choices[choice_name]), s.key
        elif bounds:
            # 0 is "no limit" in the build policy; the registry says unlimited instead.
            lo = 1 if s.legacy.encode == "zero_is_unlimited" and bounds[0] == 0 else bounds[0]
            assert s.range == (lo, bounds[1]), f"{s.key}: build_policy's range is {bounds}"


def test_residency_wires_each_belong_to_one_setting_with_the_codes_range_and_column():
    path = _VERSIONING / "residency_policy.py"
    wires, ranges = _literal(path, "WIRE_NAMES"), _literal(path, "RANGES")
    by_wire = {}
    for s in SETTINGS:
        if s.legacy and s.legacy.residency_policy:
            by_wire.setdefault(s.legacy.residency_policy, []).append(s)
    assert sorted(by_wire) == sorted(wires)
    for wire, attr in wires.items():
        assert len(by_wire[wire]) == 1, f"{wire} is {len(by_wire[wire])} settings' legacy"
        s = by_wire[wire][0]
        assert s.legacy.platform_column == f"gv_{attr}", s.key
        if wire in ranges:
            assert s.range == ranges[wire], f"{s.key}: residency_policy's range is {ranges[wire]}"
    assert tuple(c.id for c in BY_KEY["residency.class"].choices) == _literal(path, "CLASSES")


def test_drafts_and_import_columns_each_belong_to_one_setting():
    drafts = _literal(_APP / "services" / "drafts_policy.py", "FIELDS")
    for column, _api, default in drafts:
        owners = [s for s in SETTINGS if s.legacy and s.legacy.workspace_column == column]
        assert len(owners) == 1 and owners[0].legacy.data_source_column == column, column
        assert owners[0].default.code == default, f"{column}: drafts_policy defaults to {default!r}"
    assert tuple(c.id for c in BY_KEY["drafts.levels"].choices) == _literal(
        _APP / "services" / "drafts_policy.py", "LEVELS")
    assert tuple(c.id for c in BY_KEY["drafts.defaultVisibility"].choices) == _literal(
        _APP / "services" / "drafts_policy.py", "VISIBILITIES")
    imports = _assignments(_APP / "services" / "import_settings.py")["FIELDS"]
    for entry in imports.elts:
        column = entry.elts[0].value
        owners = [s for s in SETTINGS if s.legacy and s.legacy.data_source_column == column]
        assert len(owners) == 1, column


# ── Every setting is read by the code ─────────────────────────────────────────

#: Settings nothing reads on purpose, each with why: a setting retired, or one only the deployment
#: sets, goes here with its reason. None today.
_UNREAD: dict = {}
#: What reads every setting by the registry, and so says nothing about whether the code acts on one:
#: the registry itself and the settings framework.
_REGISTRY_FILES = (_APP / "config" / "versioned_graph_settings.py", _APP / "config" / "settings_types.py")
_FRAMEWORK = _APP / "services" / "settings"


def _read_as(s) -> list:
    """How code that reads ``s`` names it: its key, as a string (``effective.value("forks.maxPerGraph")``,
    or a facade's table of keys); the New-version builds wire name the registry gives it, as a
    subscript of ``build_policy``'s policy (``policy["pacingRatio"]``); and the residency policy's
    attribute for it, its old column without ``gv_`` (``policy.eviction_enabled``)."""
    out = [("string", s.key)]
    if s.legacy and s.legacy.build_policy:
        out.append(("subscript", s.legacy.build_policy))
    if s.legacy and s.legacy.residency_policy:
        out.append(("attribute", s.legacy.platform_column.removeprefix("gv_")))
    return out


def _names_in(source: str) -> dict:
    """A module's string constants (a bare string, a docstring among them, reads nothing), the
    constants it subscripts with, and the attributes it reads."""
    tree = ast.parse(source)
    bare = {id(node.value) for node in ast.walk(tree)
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)}
    out = {"string": set(), "subscript": set(), "attribute": set()}
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in bare:
            out["string"].add(node.value)
        elif isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
            out["subscript"].add(node.slice.value)
        elif isinstance(node, ast.Attribute):
            out["attribute"].add(node.attr)
    return out


def _readers() -> dict:
    """Each way of naming a setting (:func:`_read_as`) that the app's code uses, outside the registry
    and the settings framework."""
    wanted = {name for s in SETTINGS for _how, name in _read_as(s)}
    found = {"string": set(), "subscript": set(), "attribute": set()}
    for path in sorted(_APP.rglob("*.py")):
        if path in _REGISTRY_FILES or _FRAMEWORK in path.parents:
            continue
        source = path.read_text(encoding="utf-8")
        if any(name in source for name in wanted):
            for how, names in _names_in(source).items():
                found[how] |= names & wanted
    return found


def test_every_setting_is_read_by_the_code():
    """A setting the code never reads would be saved, shown and explained while nothing acts on it.
    Each must be named by a reader somewhere in ``backend/app`` beyond the registry and the
    settings framework, or be exempted in :data:`_UNREAD` with why."""
    found = _readers()
    unread = [s.key for s in SETTINGS if s.key not in _UNREAD
              and not any(name in found[how] for how, name in _read_as(s))]
    assert not unread, (
        "nothing in backend/app reads these settings, outside the registry and "
        f"services/settings/ (by key, build-policy wire name or residency attribute): {unread}. "
        "Read each where the code acts on it, or retire it")
    for key, why in _UNREAD.items():
        assert key in BY_KEY and isinstance(why, str) and why.strip(), f"_UNREAD[{key!r}]"
        assert not any(name in found[how] for how, name in _read_as(BY_KEY[key])), (
            f"{key} is read now: take it out of _UNREAD")


# ── Who may set what ──────────────────────────────────────────────────────────

def test_memory_heavy_settings_are_system_admins_at_every_scope():
    """They spend the graph store's memory or the database's capacity, platform-wide."""
    for s in SETTINGS:
        if s.key.startswith(_MEMORY_HEAVY):
            assert set(s.scopes.values()) == {"system_admin"}, f"{s.key}: {s.scopes}"


def test_platform_values_are_always_a_system_admins():
    for s in SETTINGS:
        assert s.scopes.get("platform") == "system_admin", s.key
        assert set(s.scopes) <= set(types.SCOPES), s.key
        if len(s.scopes) == 1:
            assert not s.limitable, f"{s.key}: a platform-only setting has no one to limit"


# ── Choices tell their story ──────────────────────────────────────────────────

def test_choices_are_unique_and_their_frames_name_where_reads_come_from():
    for s in SETTINGS:
        ids = [c.id for c in s.choices]
        assert (s.kind == "choice") == bool(ids), s.key
        assert len(ids) == len(set(ids)), f"{s.key}: duplicate choice in {ids}"
        for c in s.choices:
            assert c.title.strip() and c.short.strip() and c.promise.strip(), f"{s.key}:{c.id}"
            assert all(v in ("better", "same", "worse") for v, _text in c.effects.values())
            assert set(c.effects) <= set(types.DIMENSIONS), f"{s.key}:{c.id}"
            assert c.falls_back_to is None or c.falls_back_to in ids, f"{s.key}:{c.id}"
            for f in c.frames:
                assert f.when in ("before", "while", "after"), f"{s.key}:{c.id}"
                assert f.source in ("graph store", "database"), f"{s.key}:{c.id}: {f.source!r}"
    read_modes = BY_KEY["reads.mode"].choices
    assert all([f.when for f in c.frames] == ["before", "while", "after"] for c in read_modes)
    assert set(BY_KEY["reads.mode"].default_limits["allowed"]) <= {c.id for c in read_modes}


# ── Words render, with and without live facts ─────────────────────────────────

def test_every_example_and_posture_renders_with_code_defaults():
    defaults = types.defaults_of(SETTINGS)
    for s in SETTINGS:
        for facts in (None, _FACTS):
            text = s.guidance.example(defaults, facts)
            assert isinstance(text, str) and text.strip(), s.key
    for c in CATEGORIES:
        for switches in ({}, {c.master_switch: True}, {c.master_switch: False}):
            assert c.posture(defaults, switches).strip(), c.id


def test_recommendations_need_their_facts():
    """A recommendation from facts it doesn't have would be a guess: None, and the static one
    stands. With the facts, a value the setting takes and a reason."""
    defaults = types.defaults_of(SETTINGS)
    computed = [s for s in SETTINGS if s.guidance.recommended.compute]
    assert {s.key for s in computed} >= {"builds.copyRoomPct", "builds.copyMaxBytes",
                                          "residency.unloadStartPct", "residency.unloadStopPct",
                                          "database.readsPerGraph", "database.readsPerProcess",
                                          "builds.perWorker"}
    for s in computed:
        compute = s.guidance.recommended.compute
        assert compute(defaults, None) is None and compute(defaults, {}) is None, s.key
        value, why = compute(defaults, _FACTS)
        assert why.strip(), s.key
        if value not in ("unlimited", "forever"):
            assert s.range[0] <= value <= s.range[1], f"{s.key}: recommends {value!r}"
        for name in _FACTS:
            partial = {k: v for k, v in _FACTS.items() if k != name}
            result = compute(defaults, partial)
            assert result is None or result[1].strip(), f"{s.key} without {name}"


def test_schema_json_is_json_and_every_field_name_is_camel_case():
    """The API and the app read these names; data-keyed maps (a choice's effects by dimension, the
    why texts by code) keep the registry's own ids."""
    doc = schema_json()
    json.loads(json.dumps(doc))
    camel = re.compile(r"^[a-z][a-zA-Z0-9]*$")
    bad = []

    def walk(node, path):
        if isinstance(node, dict):
            data_keyed = (path in (("why",),) or path[-1:] == ("effects",) and "choices" in path
                          or path[-1:] == ("values",) and path[:1] == ("profiles",))
            for k, v in node.items():
                if not data_keyed and not camel.match(k):
                    bad.append("/".join(map(str, path + (k,))))
                walk(v, path + (k,))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, path + (i,))

    walk(doc, ())
    assert not bad, f"not camelCase: {bad}"
    assert [s["key"] for s in doc["settings"]] == _KEYS
    assert all(s["docs"].startswith("versioned-graph-settings#") for s in doc["settings"])
    assert [p["id"] for p in doc["profiles"]] == [p.id for p in PROFILES]
    assert [s["id"] for s in doc["signals"]] == [s.id for s in SIGNALS]
    assert all("warnAt" in s for s in doc["signals"])


# ── Profiles: starting points that are values their settings take ─────────────

_RESOLVER = _assignments(_APP / "services" / "settings" / "resolver.py")
#: The word a kind takes besides a number, and the kinds whose numbers are whole: read from the
#: resolver, so a profile is held to the rules a save is.
_WORDS = _evaluate(_RESOLVER["WORDS"], _RESOLVER)
_WHOLE = _evaluate(_RESOLVER["_WHOLE"], _RESOLVER)
_SWITCH_NAMES = {d["key"]: d["name"] for d in SEED_DEFINITIONS}


def _value_problem(s, value):
    """Why ``value`` can't be the setting's (``resolver.value_error``'s codes), or None."""
    if s.kind == "bool":
        return None if isinstance(value, bool) else "invalid_value"
    if s.kind == "choice":
        return None if any(c.id == value for c in s.choices) else "invalid_choice"
    if s.kind == "identifier":
        ok = isinstance(value, str) and re.fullmatch(r"entity_id|urn|prop\.[^,\s]+(,urn)?", value)
        return None if ok else "invalid_identifier"
    if s.kind == "refusal_budget":
        ok = isinstance(value, str) and re.fullmatch(r"unlimited|\d+|\d+(\.\d+)?%", value)
        return None if ok else "invalid_budget"
    if s.kind in _WORDS and value == _WORDS[s.kind]:
        return None
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or (s.kind in _WHOLE and not isinstance(value, int)) or not math.isfinite(value)):
        return "invalid_value"
    if s.range is not None and not s.range[0] <= value <= s.range[1]:
        return "out_of_range"
    return None


def _number(value):
    """A value compared by a rule, as the resolver compares it: the words are infinite."""
    if value in ("unlimited", "forever"):
        return math.inf
    return None if isinstance(value, bool) or not isinstance(value, (int, float)) else float(value)


def test_the_contracts_profiles_are_there_each_once():
    ids = [p.id for p in PROFILES]
    assert len(ids) == len(set(ids))
    assert set(_CONTRACT_PROFILES) <= set(ids)
    for p in PROFILES:
        assert re.fullmatch(r"[a-z]+(-[a-z]+)*", p.id), p.id
        # The guide's heading for it is its title, whose anchor is its id.
        assert p.title.lower().replace(" ", "-") == p.id, p.id
        assert p.audience in typing.get_args(types.Audience), p.id
        for text in (p.promise, p.caution):
            assert text.strip().endswith(".") and ". " not in text, f"{p.id}: one sentence: {text!r}"
        assert p.when and all(w.strip().endswith(".") for w in p.when), p.id
        assert p.values, p.id


@pytest.mark.parametrize("profile", PROFILES, ids=lambda p: p.id)
def test_a_profiles_values_are_values_their_settings_take(profile):
    """Kind, range and choices as the resolver reads a value, and the cross-field rules on the
    values once it is applied over the defaults. A profile that sets one side of a rule sets the
    other, so applying it can't break the rule against values chosen before."""
    for key, value in profile.values.items():
        assert key in BY_KEY, f"{profile.id}: no setting {key}"
        assert _value_problem(BY_KEY[key], value) is None, \
            f"{profile.id}: {key} = {value!r} is {_value_problem(BY_KEY[key], value)}"
    applied = {**types.defaults_of(SETTINGS), **profile.values}
    for s in SETTINGS:
        for rule in s.rules:
            if not {s.key, rule.other} & set(profile.values):
                continue
            assert {s.key, rule.other} <= set(profile.values), \
                f"{profile.id}: sets one side of the rule {s.key} {rule.op} {rule.other}"
            this, other = _number(applied[s.key]), _number(applied[rule.other])
            broken = this > other - rule.margin if rule.op == "<=" else this < other + rule.margin
            assert not broken, f"{profile.id}: {s.key} {rule.op} {rule.other}: {rule.message}"


@pytest.mark.parametrize("profile", PROFILES, ids=lambda p: p.id)
def test_a_profiles_scopes_allow_its_values(profile):
    """Every value can be set at one of the profile's scopes, every scope has a value to set, and
    what a workspace admin sets there is within the platform's default limits."""
    assert profile.scopes and len(set(profile.scopes)) == len(profile.scopes)
    assert set(profile.scopes) <= set(types.SCOPES), profile.id
    for key in profile.values:
        assert set(BY_KEY[key].scopes) & set(profile.scopes), \
            f"{profile.id}: {key} can't be set at {profile.scopes}"
    for scope in profile.scopes:
        here = [key for key in profile.values if scope in BY_KEY[key].scopes]
        assert here, f"{profile.id}: nothing to set at {scope}"
        for key in here:
            s, value = BY_KEY[key], profile.values[key]
            if s.scopes[scope] != "workspace_admin":
                continue
            allowed, bounds = s.default_limits.get("allowed"), s.default_limits.get("range")
            assert allowed is None or value in allowed, f"{profile.id}: {key} = {value!r} at {scope}"
            assert not bounds or bounds[0] <= _number(value) <= bounds[1], f"{profile.id}: {key}"


def test_balanced_is_the_built_in_value_of_everything_the_other_profiles_change():
    balanced = next(p for p in PROFILES if p.id == "balanced")
    for key, value in balanced.values.items():
        default = BY_KEY[key].default.code
        assert value == default and type(value) is type(default), f"{key}: {value!r}, not {default!r}"
    assert set(balanced.values) == {key for p in PROFILES if p is not balanced for key in p.values}
    assert balanced.scopes == types.SCOPES


def test_a_profile_names_every_feature_switch_it_relies_on():
    """A value that differs from the default and needs a switch (its setting's, or its choice's,
    as Keep serving, switch when ready needs New-version builds) has the switch named in the
    caution, so a profile never relies on one silently."""
    for p in PROFILES:
        for key, value in p.values.items():
            s = BY_KEY[key]
            if value == s.default.code and type(value) is type(s.default.code):
                continue
            chosen = next((c for c in s.choices if c.id == value), None)
            for r in (*s.requires, *(chosen.requires if chosen else ())):
                if r.feature:
                    assert _SWITCH_NAMES[r.feature] in p.caution, \
                        f"{p.id}: {key} = {value!r} needs {_SWITCH_NAMES[r.feature]}"


# ── Signals: what actually happened, tied to a problem the settings answer ────

def test_the_signals_are_the_fixed_counters_each_answering_a_symptom_of_its_settings():
    ids = [sig.id for sig in SIGNALS]
    assert len(ids) == len(set(ids)), f"a signal twice in {ids}"
    assert set(ids) == set(_SIGNAL_IDS), f"not the fixed ids: {set(ids) ^ set(_SIGNAL_IDS)}"
    for sig in SIGNALS:
        assert sig.label.strip() and sig.unit.strip(), sig.id
        assert sig.settings and len(set(sig.settings)) == len(sig.settings), sig.id
        for key in sig.settings:
            assert key in BY_KEY, f"{sig.id}: no setting {key}"
        # The finder joins a count to its problem by this text: one its own settings answer.
        assert any(sig.symptom in BY_KEY[key].guidance.symptoms for key in sig.settings), sig.id
        assert sig.warn_at is None or (type(sig.warn_at) is int and sig.warn_at >= 1), sig.id


# ── The env vars the app now also sets, said so where operators look ──────────

def test_promoted_env_vars_are_marked_in_the_configuration_reference():
    """``export_config_reference.PROMOTED`` says, in docs/CONFIGURATION.md, which env vars an
    administrator can now also set in the app, and under which key: exactly the env-only ones."""
    promoted = _literal(_REPO / "backend" / "scripts" / "export_config_reference.py", "PROMOTED")
    stored = ("build_policy", "residency_policy", "platform_column", "workspace_column",
              "data_source_column", "projection_state_column")
    env_only = {s.default.env: s for s in SETTINGS if s.default.env
                and not any(getattr(s.legacy, f, None) for f in stored)}
    assert set(promoted) == set(env_only)
    labels = {c.id: c.label for c in CATEGORIES}
    for env, (key, category, scopes) in promoted.items():
        s = env_only[env]
        assert (key, category, tuple(scopes)) == (s.key, labels[s.category], tuple(s.scopes)), env


def test_deployment_facts_name_the_env_var_their_attribute_reads():
    categories = {c.id for c in CATEGORIES}
    envs = [d.env for d in DEPLOYMENT]
    assert len(envs) == len(set(envs))
    for d in DEPLOYMENT:
        assert d.category in categories and d.label.strip() and d.means.strip(), d.env
        if d.attr:
            assert _env_name(_CONFIG[d.attr]) == d.env, f"config.{d.attr} doesn't read {d.env}"
    assert {r.name for r in RETIRED} >= {"falkorMaxResident", "GRAPHVER_FALKOR_MAX_RESIDENT",
                                         "GRAPHVER_FALKOR_BUDGETS", "GRAPHVER_EVICT_SECS",
                                         "audit_tier"}


# ── The guide answers every docs link ─────────────────────────────────────────

def _heading_ids(md: str) -> set:
    """The ids the in-app reader gives the headings (rehype-slug's github-slugger, repeats and all,
    for the ASCII headings the generator writes)."""
    seen, ids, fenced = {}, set(), False
    for line in md.splitlines():
        if re.match(r"^\s*```", line):
            fenced = not fenced
            continue
        m = None if fenced else re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if not m:
            continue
        text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1",
                      re.sub(r"\*\*?", "", m.group(2).replace("`", ""))).strip()
        base = slug = "".join(ch for ch in text.lower() if ch.isalnum() or ch in " -_").replace(" ", "-")
        while slug in seen:
            seen[base] += 1
            slug = f"{base}-{seen[base]}"
        seen[slug] = 0
        ids.add(slug)
    return ids


def test_every_docs_anchor_is_a_heading_in_the_generated_guide():
    ids = _heading_ids(_GUIDE.read_text(encoding="utf-8"))
    missing = [s["docs"] for s in schema_json()["settings"] if s["docs"].split("#", 1)[1] not in ids]
    assert not missing, f"no heading in {_GUIDE.name} for: {missing}"


def test_the_guide_has_a_section_for_each_profile_and_lists_every_signal():
    md = _GUIDE.read_text(encoding="utf-8")
    ids = _heading_ids(md)
    assert {"profiles", "signals"} <= ids
    assert {p.id for p in PROFILES} <= ids, "a profile's anchor is its id"
    signals = md.split("\n## Signals\n", 1)[1].split("\n## ", 1)[0]
    assert all(f"`{sig.id}`" in signals for sig in SIGNALS)


def test_the_guide_is_registered_in_the_app_under_its_docs_slug():
    config = (_REPO / "frontend" / "src" / "components" / "guide" / "guideConfig.ts").read_text(
        encoding="utf-8")
    assert re.search(r"slug:\s*'versioned-graph-settings',[\s\S]{0,600}?"
                     r"import\('@docs/guide/VERSIONED_GRAPH_SETTINGS\.md\?raw'\)", config)

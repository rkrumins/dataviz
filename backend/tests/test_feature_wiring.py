"""The registry may not lie about itself.

`feature_definitions.implemented` was a boolean an ADMIN could tick to assert a fact about the
SOURCE TREE. It drifted the moment it was written: it marked `signupEnabled` and `traceEnabled`
as unimplemented (both were wired) and presented eight toggles as real when they did nothing —
no server gate, no UI effect. Turning "Import" off left users importing.

These tests are the reason that cannot happen again. They compare what `feature_wiring.py`
CLAIMS against what the tree actually contains:

  * declares a server gate  →  the key must be read somewhere in `backend/app`
  * declares a UI surface   →  the key must be read somewhere in `frontend/src`

The check is deliberately a whole-tree search for the key literal, not a search for one idiom.
Enforcement is not uniform and shouldn't have to be: `traceEnabled` uses a `require_feature`
dependency, `versioningEnabled` a bespoke router gate, `signupEnabled` an inline check in the
register handler, `announcementsEnabled` a value read that empties the response. All four are
real. What we are testing is that SOMETHING in the server reads the flag — because if nothing
does, the toggle is decoration, and that is the only failure mode that matters here.

Delete a gate and its test fails. Add a flag and forget to wire it and its test fails. The
registry can only go back to lying if someone edits `feature_wiring.py` to say so, on purpose.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

from backend.app.config.feature_wiring import FEATURE_WIRING
from backend.app.db.seed_feature_registry import SEED_CATEGORIES, SEED_DEFINITIONS

_REPO = Path(__file__).resolve().parents[2]
_BACKEND = _REPO / "backend" / "app"
_FRONTEND = _REPO / "frontend" / "src"

# Files that NAME the flags without ENFORCING them. Finding a key here proves nothing —
# it's the registry describing itself, which is exactly the circularity we're breaking.
_BACKEND_REGISTRY_FILES = {
    _BACKEND / "config" / "feature_wiring.py",     # the declarations under test
    _BACKEND / "config" / "features_seed.py",      # seed content (names every key, gates none)
    _BACKEND / "db" / "seed_feature_registry.py",  # seeding machinery
}
# NOTE feature_gate.py is deliberately NOT excluded. It is the most legitimate gate site there
# is — `ensure_view_mode_allowed` enforces `allowedViewModes` inside it. It used to also hold a
# per-flag message dict, which named every key and so made the file useless as evidence; that
# prose now lives in config/features_seed.py, with all the other flag prose. The module gates
# flags without naming them, which is what lets it count.
_FRONTEND_REGISTRY_FILES = {
    _FRONTEND / "store" / "features.ts",           # DEFAULT_FEATURES seeds
}


def _sources(root: Path, suffixes: tuple[str, ...], skip: set[Path]) -> list[Path]:
    out = []
    for p in root.rglob("*"):
        if p.suffix not in suffixes or p in skip:
            continue
        if "__pycache__" in p.parts or "node_modules" in p.parts:
            continue
        if p.name.endswith(".test.ts") or p.name.endswith(".test.tsx"):
            continue
        out.append(p)
    return out


def _python_string_literals(source: str) -> set[str]:
    """Every string literal in a module EXCEPT its docstrings — and never its comments, which
    `ast` drops for us.

    Prose must not be able to satisfy this guard. The first draft searched raw text and passed
    `allowedViewModes` on the strength of a line in a DOCSTRING showing how to read the flag.
    That is the guard being fooled by a comment about the thing instead of the thing, which is
    the same class of error as the column it exists to police.
    """
    tree = ast.parse(source)

    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None) or []
        first = body[0] if body else None
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            docstrings.add(id(first.value))

    return {
        n.value
        for n in ast.walk(tree)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings
    }


_TS_COMMENTS = re.compile(r"//[^\n]*|/\*.*?\*/", re.S)


def _files_reading(key: str, root: Path, suffixes: tuple[str, ...], skip: set[Path]) -> list[str]:
    """Files under `root` that read `key` as a string literal in live code — not in prose."""
    literal = re.compile(rf"""["'`]{re.escape(key)}["'`]""")
    hits = []
    for p in _sources(root, suffixes, skip):
        try:
            source = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if key not in source:  # cheap reject before the expensive parse
            continue
        if p.suffix == ".py":
            try:
                if key in _python_string_literals(source):
                    hits.append(str(p.relative_to(_REPO)))
            except SyntaxError:
                continue
        elif literal.search(_TS_COMMENTS.sub("", source)):
            hits.append(str(p.relative_to(_REPO)))
    return hits


_KEYS = sorted(FEATURE_WIRING)


# ── The registry and the wiring describe the same set of flags ─────────────────

def test_every_seeded_flag_declares_its_wiring():
    """A flag in the registry with no wiring entry is a toggle nobody can explain."""
    seeded = {d["key"] for d in SEED_DEFINITIONS}
    assert seeded == set(FEATURE_WIRING), (
        f"only in the seed: {sorted(seeded - set(FEATURE_WIRING))}; "
        f"only in the wiring: {sorted(set(FEATURE_WIRING) - seeded)}"
    )


def test_every_flag_belongs_to_a_real_category():
    known = {c["id"] for c in SEED_CATEGORIES}
    unknown = {d["key"]: d["category_id"] for d in SEED_DEFINITIONS if d["category_id"] not in known}
    assert not unknown, f"flags pointing at categories that don't exist: {unknown}"


# ── The claims are true ───────────────────────────────────────────────────────

def _default_of(key: str):
    d = next((d for d in SEED_DEFINITIONS if d["key"] == key), None)
    return json.loads(d["default_value"]) if d else None


def _is_on(value) -> bool:
    return bool(value) if not isinstance(value, list) else len(value) > 0


# ── The lifecycle ─────────────────────────────────────────────────────────────
#
# A flag used to have two states: it existed, or it didn't. Everything that matters happens in
# between — a feature being BUILT needs a flag before it has anything to gate, and a feature that
# has stopped being optional needs its flag REMOVED, or the switch becomes debt that outlives the
# question it was asked to answer. `stage` names those states and these tests enforce them, so the
# rules survive the person who agreed to them.


@pytest.mark.parametrize("key", _KEYS)
def test_an_ACTIVE_capability_flag_must_default_ON(key: str):
    """The policy, enforced instead of remembered.

    Users cannot ask for a capability they have never seen. A capability flag that ships OFF is a
    feature nobody discovers and nobody requests — it just quietly isn't part of the product. So a
    working feature is AVAILABLE unless an admin decides otherwise, and this test means nobody has
    to remember that when they add the next flag.

    SECURITY flags are exempt, and `signupEnabled` is exactly why the exemption exists: ON there
    does not mean "users can see a feature", it means any stranger who reaches the login page can
    create an account. A blanket rule would have opened the door on every fresh deployment in the
    name of discoverability.
    """
    wiring = FEATURE_WIRING[key]
    if not wiring.must_default_on:
        pytest.skip(f"exempt — {wiring.stage}/{wiring.posture}")

    assert _is_on(_default_of(key)), (
        f"{key} is an active capability, so it must ship ON. A feature nobody can see is a feature "
        f"nobody asks for. If it genuinely must ship off, it is either a `security` flag or it is "
        f"not `active` yet — say which in feature_wiring.py."
    )


def test_a_SECURITY_flag_that_ships_off_is_a_deliberate_exception():
    """The exemption is not a loophole: adding a member should require someone to come here and
    say so out loud. Said out loud, then:

      * ``signupEnabled`` — ON means any stranger who reaches the login page can create an
        account. The original reason this exemption exists.
      * ``analyticsPublicEnabled`` — ON publishes platform-wide growth, headcount and the
        existence of every workspace to everyone who can sign in. Redacted, but still a
        disclosure, and one an operator should make deliberately rather than inherit from a
        default nobody chose.
      * ``analyticsShowEmailAddresses`` — ON puts several colleagues' addresses on one
        ranked page. Each of them was already reachable from the thing they built, so this
        is not what protects them; what it changes is how many arrive at once, and that is
        a call about the deployment rather than a default anyone should inherit.
      * ``analyticsWorkspaceVisibility`` — ON makes Analytics report on workspaces the rest
        of the product hides from that reader. Reasonable in a single-company deployment
        and wrong anywhere else, so it cannot be a default: the deployment shape is the
        one thing the code cannot know.
    """
    # A single-select ladder has no "off" rung to ship on, so the boolean
    # question this test asks does not apply to it.
    off_by_default = sorted(
        k for k, w in FEATURE_WIRING.items()
        if w.posture == "security" and not _is_on(_default_of(k))
    )
    # Sorted, so the assertion tracks membership rather than the order somebody
    # happened to declare the flags in.
    assert off_by_default == [
        "analyticsPublicEnabled", "analyticsShowEmailAddresses",
        "analyticsWorkspaceVisibility", "signupEnabled",
    ], (
        f"a flag now ships OFF on a security exemption: {off_by_default}. That is allowed — but it "
        f"means a capability is invisible on every fresh deployment, so it should be a decision "
        f"somebody made, not one that crept in."
    )


@pytest.mark.parametrize("key", _KEYS)
def test_an_EXPERIMENTAL_flag_must_default_OFF(key: str):
    """The other half of the rule, and the reason `experimental` exists at all.

    You need a flag before the feature is finished — that is what it's FOR. But switching an
    unfinished thing on for every user is not a preview, it's an incident. So an experimental flag
    is opt-in, and the page badges it so an admin knows what they are turning on.
    """
    if FEATURE_WIRING[key].stage != "experimental":
        pytest.skip("not experimental")

    assert not _is_on(_default_of(key)), (
        f"{key} is experimental and ships ON. Nobody asked to be a tester."
    )


@pytest.mark.parametrize("key", _KEYS)
def test_a_DEPRECATED_flag_has_had_its_gates_REMOVED(key: str):
    """Retirement, enforced backwards.

    When a feature stops being optional, the flag has to go — and the dangerous half-step is
    deleting the definition while the gates are still in the code, which leaves an unlisted switch
    silently refusing things nobody can turn back on. So the order is fixed: mark it deprecated,
    REMOVE the gates (this test proves you did), then delete the definition.
    """
    if FEATURE_WIRING[key].stage != "deprecated":
        pytest.skip("not deprecated")

    hits = (
        _files_reading(key, _BACKEND, (".py",), _BACKEND_REGISTRY_FILES)
        + _files_reading(key, _FRONTEND, (".ts", ".tsx"), _FRONTEND_REGISTRY_FILES)
    )
    assert not hits, (
        f"{key} is deprecated but is still being read in: {hits}. Remove the gates BEFORE deleting "
        f"the definition, or you leave a switch that refuses things and isn't on the page."
    )


@pytest.mark.parametrize("key", _KEYS)
def test_a_declared_server_gate_actually_exists(key: str):
    """The half that makes a toggle mean anything.

    Without this, turning a feature off only hides a button — the endpoint is still there and
    anyone who knows the URL still has the feature.
    """
    wiring = FEATURE_WIRING[key]
    if wiring.stage != "active":
        pytest.skip(f"{wiring.stage} — the halves are not required to exist yet")
    if not wiring.server_gates:
        pytest.skip("declares no server gate")

    hits = _files_reading(key, _BACKEND, (".py",), _BACKEND_REGISTRY_FILES)
    assert hits, (
        f"{key} claims to be enforced by the server:\n"
        + "\n".join(f"  · {g}" for g in wiring.server_gates)
        + f"\n\n...but no file under backend/app reads '{key}'. Either the gate was never "
        f"written, or it was deleted and the claim outlived it."
    )


@pytest.mark.parametrize("key", _KEYS)
def test_a_declared_ui_surface_actually_exists(key: str):
    """The other half. A server-only gate is honest but hostile: the UI keeps offering the
    feature and the user discovers it's off by being refused."""
    wiring = FEATURE_WIRING[key]
    if wiring.stage != "active":
        pytest.skip(f"{wiring.stage} — the halves are not required to exist yet")
    if not wiring.ui_surfaces:
        pytest.skip("declares no UI surface (server withholds the content instead)")

    hits = _files_reading(key, _FRONTEND, (".ts", ".tsx"), _FRONTEND_REGISTRY_FILES)
    assert hits, (
        f"{key} claims the UI hides:\n"
        + "\n".join(f"  · {s}" for s in wiring.ui_surfaces)
        + f"\n\n...but no file under frontend/src reads '{key}'. The admin turns it off and "
        f"the button is still there — clicking it now 403s."
    )


def test_no_flag_is_decoration():
    """Every toggle we SHOW must DO something. This is the bug, stated as a test: eight of the
    twelve flags on the admin page changed nothing at all."""
    decorative = [k for k, w in FEATURE_WIRING.items() if w.stage == "active" and not w.wired]
    assert not decorative, (
        f"these toggles are offered to admins but change nothing: {decorative}. "
        f"Wire them or remove them — a switch that does nothing is worse than no switch, "
        f"because it is trusted."
    )


def test_every_flag_is_enforced_server_side():
    """UI-only enforcement is not enforcement."""
    ui_only = [
        k for k, w in FEATURE_WIRING.items()
        if w.stage == "active" and not w.enforced_server_side
    ]
    assert not ui_only, f"flags the server does not actually refuse: {ui_only}"


# ── The stored `implemented` column cannot contradict the code ────────────────

def test_the_seed_cannot_state_implemented_at_all():
    """`implemented` is a fact about the source tree, so no human gets to type it.

    It is derived from FEATURE_WIRING at seed time (``_row_values``). Reintroducing it here as a
    hand-written boolean is how it went wrong the first time, so the door stays shut rather than
    merely watched.
    """
    declared = [d["key"] for d in SEED_DEFINITIONS if "implemented" in d]
    assert not declared, (
        f"these seed entries hand-write `implemented`: {declared}. Delete the key — it is "
        f"derived from FEATURE_WIRING[key].wired, which cannot be wrong about the code."
    )


def test_dependencies_point_at_real_flags():
    for key, wiring in FEATURE_WIRING.items():
        for dep in wiring.depends_on:
            assert dep in FEATURE_WIRING, f"{key} depends on unknown flag '{dep}'"


def test_a_flag_that_widens_access_fails_closed():
    """The posture rule, pinned. `signupEnabled` decides whether a stranger may create an
    account; `semanticLayerNonAdminEditing` decides whether a non-admin may write. If we cannot
    read either, we must assume the admin wanted the NARROWER world."""
    for key in ("signupEnabled", "semanticLayerNonAdminEditing"):
        assert FEATURE_WIRING[key].posture == "security"
        assert FEATURE_WIRING[key].fail_safe_default is False


def test_impact_copy_is_seeded_for_every_flag():
    """The admin page must be able to answer "what happens if I turn this off?" for every
    toggle it renders — from the registry, not from a hardcoded frontend map."""
    missing = [
        d["key"] for d in SEED_DEFINITIONS
        if not (d.get("impact_when_off") or "").strip()
    ]
    assert not missing, f"no impact-when-off copy for: {missing}"


def test_string_list_flags_declare_their_options():
    """`allowedViewModes` is a list, not a switch — the admin page renders checkboxes from
    `options`, and an option the server doesn't accept would be a trap."""
    for d in SEED_DEFINITIONS:
        if d["type"] != "string[]":
            continue
        options = json.loads(d["options"] or "[]")
        assert options, f"{d['key']} is a string[] with no options to choose from"
        default = json.loads(d["default_value"])
        unknown = set(default) - {o["id"] for o in options}
        assert not unknown, f"{d['key']} defaults to options that don't exist: {unknown}"

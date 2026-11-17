#!/usr/bin/env python3
"""Generate the versioned-graph settings guide and the app's catalogue from the settings registry.

Both files come from ``backend/app/config/versioned_graph_settings.py``, which describes every
setting once, so neither can drift from it: CI runs this script with ``--check`` and fails when a
committed file differs from what the registry says now.

    docs/guide/VERSIONED_GRAPH_SETTINGS.md               the guide (in-app: /guide/versioned-graph-settings)
    frontend/src/generated/versionedGraphSettings.json   schema_json() with the code defaults

The registry imports only the standard library, so this runs on a bare Python with nothing
installed.

Each setting's heading is its key with the dot as a hyphen (``reads-mode``): the readers give a
heading the id of its text, and that id is the anchor the registry's ``docs`` link points at.

Usage, from the repository root::

    python3 backend/scripts/export_settings_reference.py           # write both files
    python3 backend/scripts/export_settings_reference.py --check   # CI: exit 1 with a diff on drift
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from backend.app.config import versioned_graph_settings as registry  # noqa: E402
from backend.app.config.features_seed import SEED_DEFINITIONS  # noqa: E402
from backend.app.config.settings_types import DIMENSION_LABELS  # noqa: E402
from backend.app.config.versioned_graph_settings import _days, _dur, _ms, _share, _size  # noqa: E402

GUIDE = REPO_ROOT / "docs" / "guide" / "VERSIONED_GRAPH_SETTINGS.md"
CATALOGUE = REPO_ROOT / "frontend" / "src" / "generated" / "versionedGraphSettings.json"
SCRIPT = "backend/scripts/export_settings_reference.py"
REGENERATE = f"python3 {SCRIPT}"
TAG = "[export_settings_reference]"

_SWITCH_NAMES = {d["key"]: d["name"] for d in SEED_DEFINITIONS}
_EDITORS = {"system_admin": "system administrators", "workspace_admin": "workspace administrators"}
_LIMITS = {"allowed": "the allowed choices", "range": "a range", "lock": "a lock"}
_ORDERED = {"bool": ("Turning it on", "Turning it off")}


# --------------------------------------------------------------------------- #
# Words                                                                        #
# --------------------------------------------------------------------------- #

def _esc(text: str) -> str:
    """Prose made safe for markdown, in a paragraph or a table cell: code spans kept as they are."""
    out = []
    for i, part in enumerate(re.split(r"(`[^`]*`)", str(text))):
        if i % 2:
            out.append(part.replace("|", r"\|"))
            continue
        part = re.sub(r"([|<*~\[\]])", r"\\\1", part)
        out.append(re.sub(r"(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])", r"\\_", part))
    return "".join(out)


def _table(header: list, rows: list) -> list:
    return ["| " + " | ".join(header) + " |", "|" + "---|" * len(header),
            *("| " + " | ".join(row) + " |" for row in rows)]


def _show(s, value) -> str:
    """A value as the app shows it."""
    if value == "unlimited":
        return "Unlimited"
    if value == "forever":
        return "Forever"
    if s.kind == "bool":
        return "On" if value else "Off"
    if s.kind == "choice":
        return next(c.title for c in s.choices if c.id == value)
    if s.kind == "ratio":
        return _share(value) if s.unit == "share" else f"{value:g}×"
    if s.kind == "percent":
        return f"{value}%"
    if s.kind == "ms":
        return _ms(value)
    if s.kind == "seconds":
        return _dur(value)
    if s.kind in ("bytes", "bytes_or_unlimited"):
        return _size(value)
    if s.kind in ("days", "days_or_forever"):
        return _days(value)
    if s.kind in ("identifier", "refusal_budget"):
        return f"`{value}`"
    unit = s.unit
    if unit and value == 1:     # "1 build", "1 property"
        unit = unit[:-3] + "y" if unit.endswith("ies") else unit.removesuffix("s")
    return f"{value:,}" + (f" {unit}" if unit else "")


def _kind(s) -> str:
    lo, hi = s.range or (None, None)
    return {
        "bool": "On or off",
        "count": f"A whole number, {lo:,} to {hi:,}" + (f" {s.unit}" if s.unit else "") if s.range else "",
        "count_or_unlimited": f"A whole number, {lo:,} to {hi:,}, or unlimited" if s.range else "",
        "ratio": ((f"A share, {_share(lo)} to {_share(hi)}" if s.unit == "share" else
                   f"A multiple of the write's time, {lo:g} to {hi:g}") if s.range else ""),
        "percent": f"A percentage, {lo}% to {hi}%" if s.range else "",
        "ms": f"Milliseconds, {lo:,} to {hi:,}" if s.range else "",
        "seconds": f"A time, {_dur(lo)} to {_dur(hi)}" if s.range else "",
        "bytes": f"Bytes, {lo:,} to {hi:,}" if s.range else "",
        "bytes_or_unlimited": f"A size, up to {_size(hi)}, or unlimited" if s.range else "",
        "days": f"Days, {lo:,} to {hi:,}" if s.range else "",
        "days_or_forever": f"Days, {lo:,} to {hi:,}, or forever" if s.range else "",
        "choice": "One of: " + "; ".join(f"{c.title} (`{c.id}`)" for c in s.choices),
        "identifier": "`entity_id`, `urn`, `prop.<name>` or `prop.<name>,urn`",
        "refusal_budget": "`0`, a number such as `100`, a share such as `0.5%`, or unlimited",
    }[s.kind]


def _scopes(s) -> str:
    return ", ".join(f"{scope.title()} ({_EDITORS[editor]})" for scope, editor in s.scopes.items())


def _needs(requirement) -> str:
    if requirement.feature:
        return f"The {_SWITCH_NAMES.get(requirement.feature, requirement.feature)} switch on"
    other = registry.BY_KEY[requirement.setting]
    if other.kind == "bool":
        return f"{other.label} {'on' if requirement.one_of == (True,) else 'off'}"
    return f"{other.label} set to {' or '.join(_show(other, v) for v in requirement.one_of)}"


def _facts_rows(s) -> list:
    default = _show(s, s.default.code)
    default += (f" · environment variable `{s.default.env}`" if s.default.env else " · built in")
    rows = [["Key", f"`{s.key}`"], ["Kind", _esc(_kind(s))], ["Default", _esc(default)],
            ["Set at", _esc(_scopes(s))]]
    if s.limitable and len(s.scopes) > 1:
        limits = "A system administrator can set " + " or ".join(_LIMITS[k] for k in s.limitable)
        allowed = s.default_limits.get("allowed")
        if allowed:
            limits += (". By default workspaces may choose " +
                       " or ".join(_show(s, choice) for choice in allowed))
        rows.append(["Limits", _esc(limits + ".")])
    if s.requires:
        rows.append(["Needs", _esc("; ".join(_needs(r) for r in s.requires) + ".")])
    for cap in s.caps:
        whom = (registry.BY_KEY[cap.setting].label if cap.setting
                else f"your deployment's `{cap.deployment}`")
        rows.append(["Capped by", _esc(f"{whom}: the lower value is in force.")])
    for rule in s.rules:
        other = registry.BY_KEY[rule.other].label
        bound = ("At most" if rule.op == "<=" else "At least") + (
            f" {other}" if not rule.margin else
            f" {rule.margin:g} points {'under' if rule.op == '<=' else 'over'} {other}")
        rows.append(["Rule", _esc(f"{bound}, checked when you save.")])
    rows.append(["Takes effect", _esc(s.takes_effect[1])])
    return rows


def _choices(s) -> list:
    out = ["**The choices**", ""]
    for c in s.choices:
        line = f"- **{_esc(c.title)}** (`{c.id}`): {_esc(c.promise)}"
        if c.frames:
            line += " " + _esc(" ".join(
                f"{f.when.capitalize()}: {f.shows}, from the {f.source}"
                + (f" ({f.note[0].lower()}{f.note[1:]})" if f.note else "") + "."
                for f in c.frames))
        if c.good_for:
            line += f" *Good for:* {_esc(c.good_for)}"
        if c.needs:
            line += f" *Needs:* {_esc(c.needs)}"
        out.append(line)
    return out + [""]


def _effects(s) -> list:
    if s.kind in ("choice", "identifier"):
        rows = [[DIMENSION_LABELS[e.dimension],
                 _esc(e.up if e.up_verdict == "better" else e.down),
                 _esc(e.down if e.up_verdict == "better" else e.up), e.weight.capitalize()]
                for e in s.guidance.effects]
        return _table(["Dimension", "Better with", "Worse with", "Weight"], rows)
    up, down = _ORDERED.get(s.kind, ("Raising it", "Lowering it"))
    other = {"better": "Worse", "worse": "Better"}
    rows = [[DIMENSION_LABELS[e.dimension],
             _esc(f"{e.up_verdict.capitalize()}: {e.up}"),
             _esc(f"{other[e.up_verdict]}: {e.down}"), e.weight.capitalize()]
            for e in s.guidance.effects]
    return _table(["Dimension", up, down, "Weight"], rows)


def _setting(s, example: str) -> list:
    """A setting's section. Its heading is the key with the dot as a hyphen: the id the reader gives
    that heading is the setting's ``docs`` anchor (``reads.maxVersionsBehind`` →
    ``#reads-maxversionsbehind``)."""
    g = s.guidance
    out = [f"### `{s.key.replace('.', '-')}`", "", f"**{_esc(s.label)}.** {_esc(g.summary)}", ""]
    if s.audience == "business":
        out += [f"*Asked as:* {_esc(s.question)}", ""]
    out += [*_table(["Fact", "Value"], _facts_rows(s)), "", _esc(g.means), ""]
    if s.choices:
        out += _choices(s)
    out += ["**What it changes**", "", *_effects(s), "", "**When to change it**", "",
            *(f"- {_esc(w)}" for w in g.change_when), "",
            f"**Recommended:** {_esc(_show(s, g.recommended.value))}. {_esc(g.recommended.why)}", "",
            f"**Risk:** {g.risk.capitalize()}. {_esc(g.risk_note)}", "",
            f"**Example:** {_esc(example)}", "",
            f"**Evidence:** {_esc(g.evidence)}", "",
            f"**Problems it answers:** {_esc('; '.join(g.symptoms))}.", "",
            f"**Also searched as:** {_esc(', '.join(g.aliases))}.", ""]
    return out


def _link(key: str, anchors: dict) -> str:
    return f"[{_esc(registry.BY_KEY[key].label)}](#{anchors[key]})"


def _profiles(anchors: dict) -> list:
    """The profiles: a summary table, then each one's promise, when to choose it, the values it sets
    and what it costs. Each heading is its title, whose id is the profile's id (``#fastest-reads``)."""
    lens = {"business": "Business", "operator": "Operator"}
    out = [
        "## Profiles",
        "",
        ("Starting points: each profile sets the settings it covers for one outcome. Applying one in "
         "the app stages its values at the level you are editing, only for the settings you may set "
         "there, and says which it left out and why. Nothing is saved until you review the changes "
         "and save them."),
        "",
        *_table(["Profile", "What it gives you", "Lens", "Applies at"], [
            [f"[{_esc(p.title)}](#{p.id})", _esc(p.promise), lens[p.audience],
             ", ".join(scope.title() for scope in p.scopes)] for p in registry.PROFILES]),
        "",
    ]
    for p in registry.PROFILES:
        rows = [[_link(key, anchors), _esc(_show(registry.BY_KEY[key], value)),
                 _esc(_show(registry.BY_KEY[key], registry.BY_KEY[key].default.code)),
                 ", ".join(scope.title() for scope in registry.BY_KEY[key].scopes)]
                for key, value in p.values.items()]
        out += [f"### {_esc(p.title)}", "", f"**{_esc(p.promise)}**", "",
                "**Choose it when**", "", *(f"- {_esc(w)}" for w in p.when), "",
                *_table(["Setting", "It sets", "Default", "Set at"], rows), "",
                f"**What you give up:** {_esc(p.caution)}", "",
                f"**Applies at:** {', '.join(scope.title() for scope in p.scopes)}. Shown first in "
                f"the {lens[p.audience]} lens.", ""]
    return out


def _signals(anchors: dict) -> list:
    """What actually happened: each counter, the problem it answers and the settings behind it."""
    return [
        "## Signals",
        "",
        ("What actually happened, counted as it happens. The app's \"Something's wrong?\" finder "
         "shows each count beside the problem it answers, with the settings behind it, and marks "
         "it once the count reaches the number worth a look. A dash: the count is shown, never "
         "marked."),
        "",
        *_table(["Signal", "Counts", "The problem it answers", "Settings behind it",
                 "Worth a look from"], [
            [f"`{sig.id}`", _esc(sig.label), _esc(sig.symptom),
             ", ".join(_link(key, anchors) for key in sig.settings),
             f"{sig.warn_at:,} in 24 hours" if sig.warn_at is not None else "—"]
            for sig in registry.SIGNALS]),
        "",
    ]


# --------------------------------------------------------------------------- #
# The guide                                                                    #
# --------------------------------------------------------------------------- #

_INTRO = [
    "## How these settings work",
    "",
    "### Where a value comes from",
    "",
    "Each setting has one value in force for each graph. It comes from the most specific level " +
    "that chose one:",
    "",
    "1. **Graph**: one data source's graph. A fork follows the graph it was forked from.",
    "2. **Workspace**: every graph in the workspace.",
    "3. **Platform**: every graph.",
    "4. **Default**: the deployment's environment variable if it is set and valid, else the " +
    "built-in value.",
    "",
    "So a graph with nothing of its own takes its workspace's value, else the platform's, else the " +
    "default. The app shows the whole trail, Default → Platform → Workspace → Graph, with the " +
    "level in force highlighted.",
    "",
    "### Who may set what",
    "",
    "- **System administrators** set the platform's values, and may set any level.",
    "- **Workspace administrators** set their workspace's values and their graphs', for the " +
    "settings marked so below.",
    "- Settings that spend the graph store's memory or the database's capacity are system " +
    "administrators' only, at every level: Updates & loading, New-version builds, Memory & " +
    "residency (the residency class too), Database reads, and Matching properties per graph.",
    "",
    "### Limits and exceptions",
    "",
    "A system administrator can limit what workspace administrators choose:",
    "",
    "- **Allowed choices**, such as which read modes a workspace may pick. By default workspaces " +
    "may choose Always the latest or Keep serving, update in place.",
    "- **A range**: the lowest and highest number allowed.",
    "- **A lock**: the platform's value holds everywhere, and lower levels can't change it.",
    "",
    "A value a system administrator sets outside the limits stays in force, marked as an " +
    "exception, so tightening a limit never changes a graph without anyone noticing.",
    "",
    "### When a change takes effect",
    "",
    "A saved value reaches every process within a few seconds. Each setting below says when it is " +
    "then acted on: at the next read, the next write, the next memory check, the next sweep or " +
    "the next import.",
    "",
    "### Saving a change",
    "",
    "Nothing is saved until you review it: each value before and after, what the change does to " +
    "your graphs, and a reason, which the history keeps. A change that removes what can't be " +
    "brought back (the changes of closed drafts the next sweep would remove), or that moves a " +
    "high-risk setting the riskier way, must be acknowledged first. The settings API refuses " +
    "such a save (`409 acknowledgement_required`, naming each warning) unless its request lists " +
    "the warnings' codes in `acknowledge`.",
    "",
]


def _old_endpoints(anchors: dict) -> list:
    """Each endpoint that saved these settings before the settings store, what replaces it, and the
    settings it carried, read from each setting's ``legacy``."""
    def carried(where) -> str:
        return ", ".join(_link(s.key, anchors) for s in registry.SETTINGS
                         if s.legacy and where(s.legacy, s))

    platform, workspace = "/api/v1/admin/versioning/settings", "/api/v1/{ws}/versioning/settings"
    graph = "/api/v1/{ws}/versioning/graphs/{graph}/settings"
    rows = [
        ("`GET`, `PUT /api/v1/admin/versioning/build-policy`", f"`GET`, `PATCH {platform}`",
         carried(lambda old, s: old.build_policy)),
        ("`GET`, `PUT /api/v1/admin/versioning/residency-policy`", f"`GET`, `PATCH {platform}`",
         carried(lambda old, s: old.residency_policy)),
        ("`POST /api/v1/admin/versioning/residency-policy/preview`",
         f"`POST {platform}/preview?mode=full`",
         "What a change would unload and load, as part of its impact."),
        ("`GET`, `PUT /api/v1/admin/versioning/draft-retention`", f"`GET`, `PATCH {platform}`",
         carried(lambda old, s: old.platform_column and not old.residency_policy)),
        ("`PUT /api/v1/admin/versioning/graphs/{graph}/read-mode`", f"`PATCH {graph}`",
         carried(lambda old, s: old.projection_state_column == "read_mode")),
        ("`GET`, `PUT /api/v1/{ws}/versioning/drafts-policy`", f"`GET`, `PATCH {workspace}`",
         carried(lambda old, s: old.workspace_column)),
        ("`GET`, `PUT /api/v1/{ws}/versioning/data-sources/{dataSource}/drafts-policy`",
         f"`GET`, `PATCH {graph}`",
         carried(lambda old, s: old.data_source_column and s.category == "drafts")),
        ("`GET`, `PUT /api/v1/{ws}/versioning/graphs/{graph}/import-settings`",
         f"`GET`, `PATCH {graph}`",
         carried(lambda old, s: old.data_source_column and s.category == "imports")),
    ]
    return [
        "## If you used the old endpoints",
        "",
        ("The endpoints that saved these settings before keep working for one more release. They "
         "save through the settings store, so their changes appear in the history with everyone "
         "else's, and every answer says it is deprecated: a `Deprecation: true` header, and a "
         "`Link` header naming the route that replaces it. Move to the settings API, which also "
         "returns where each value came from and why the one in force may differ:"),
        "",
        *_table(["Old endpoint", "Use instead", "What it carried"], [list(r) for r in rows]),
        "",
        ("A residency policy `PUT` that changes `defaultResidency` is refused. It used to set the "
         f"class a new graph started with; {_link('residency.class', anchors)} is now the class "
         "every graph inherits, unless its workspace or the graph sets its own."),
        "",
    ]


def render_guide() -> str:
    rendered = registry.schema_json()   # the anchors, and the examples with the code defaults
    anchors = {item["key"]: item["docs"].split("#", 1)[1] for item in rendered["settings"]}
    examples = {item["key"]: item["guidance"]["example"] for item in rendered["settings"]}
    by_category = {c.id: [s for s in registry.SETTINGS if s.category == c.id]
                   for c in registry.CATEGORIES}
    out = [
        f'[//]: # "GENERATED by {SCRIPT} from backend/app/config/versioned_graph_settings.py — do '
        f'not edit by hand"',
        "",
        "# Versioned Graph Settings",
        "",
        "*For system administrators, workspace administrators and data owners.*",
        "",
        ("Every setting that decides how versioned graphs are read, updated, built, kept in memory, "
         "drafted and imported: what each one means, what it changes, when to change it, and what "
         "we recommend. System administrators set them under **Admin → Versioned graphs**; a "
         "workspace's own values and one graph's are set from the workspace and the data source."),
        "",
        (f"> **Note:** This page is generated from the settings registry in the code by `{SCRIPT}`, "
         f"which also writes the catalogue the app shows. Don't edit it by hand: change the "
         f"registry, run `{REGENERATE}` and commit the result. CI fails when this page is out of "
         f"date."),
        "",
        *_INTRO,
        "### Why a value differs from the one chosen",
        "",
        "When the value in force isn't the one chosen, the app says why:",
        "",
        *_table(["Reason", "What it means"],
                [[f"`{w.code}`", _esc(w.text)] for w in registry.WHY]),
        "",
        "### Reading this page",
        "",
        ("Each setting below gives its facts (its kind, its default and environment variable, where "
         "it may be set and by whom, and when a change takes effect), what it means, what raising "
         "or lowering it changes, when to change it, what we recommend, an example with the "
         "default values, and the evidence. In each table of what it changes, Better and Worse say "
         "whether that direction helps the dimension."),
        "",
    ]
    for c in registry.CATEGORIES:
        settings = by_category[c.id]
        out += [f"## {c.label}", "", _esc(c.summary), "",
                f"**With the defaults:** {_esc(c.posture({}, {}))}", ""]
        if c.master_switch:
            out += [f"These settings act only while the **{_SWITCH_NAMES[c.master_switch]}** "
                    f"switch is on (Admin → Features).", ""]
        out += [*_table(["Setting", "Default", "Set at"], [
            [f"[{_esc(s.label)}](#{anchors[s.key]})", _esc(_show(s, s.default.code)),
             ", ".join(scope.title() for scope in s.scopes)] for s in settings]), ""]
        for s in settings:
            out += _setting(s, examples[s.key])
    out += [*_profiles(anchors), *_signals(anchors)]
    out += [
        "## Glossary",
        "",
        *_table(["Term", "What it means", "Technical details"],
                [[f"**{_esc(t.term)}**", _esc(t.definition), _esc(t.technical)]
                 for t in registry.GLOSSARY]),
        "",
        "## Set by your deployment",
        "",
        ("These are set by environment variables only, because they size the deployment itself. "
         "The app shows each one read-only, with the value the workers report, beside the settings "
         "it bounds. Every environment variable, with its default, is in the "
         "[Configuration Reference](/docs/configuration)."),
        "",
        *_table(["Variable", "Shown under", "What it sets"],
                [[f"`{d.env}`",
                  next(c.label for c in registry.CATEGORIES if c.id == d.category),
                  f"**{_esc(d.label)}.** {_esc(d.means)}"] for d in registry.DEPLOYMENT]),
        "",
        "## Retired",
        "",
        "Still in the code or the database, but acted on by nothing; they go in a later release.",
        "",
        *_table(["Name", "Why it is retired"],
                [[f"`{r.name}`", _esc(r.why)] for r in registry.RETIRED]),
        "",
        *_old_endpoints(anchors),
        "## Where to next",
        "",
        "- [Feature Switches](/guide/feature-switches) — when you want to turn on New-version " +
        "builds or Graph residency.",
        "- [The Graph Store: Shards, Replicas & Placement](/guide/graph-store-topology) — when you " +
        "want to see each node's memory.",
        "- [Import & Export](/guide/import-export) — when you want to see how an import uses these " +
        "settings.",
        "- [Projection & Cache](/docs/versioning-projection-and-cache) — when you want the " +
        "mechanism behind reads, updates and builds.",
        "- [Forks & Residency](/docs/versioning-forks-and-residency) — when you want how memory " +
        "and residency work.",
        "- [Scale, Limits & Roadmap](/docs/versioning-scale-and-roadmap) — when you want the " +
        "measured numbers.",
    ]
    return "\n".join(out) + "\n"


def render_catalogue() -> str:
    return json.dumps(registry.schema_json(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


# --------------------------------------------------------------------------- #
# Command line                                                                 #
# --------------------------------------------------------------------------- #

def main() -> int:
    parser = argparse.ArgumentParser(description=(
        "Generate the versioned-graph settings guide and the app's catalogue from the registry."))
    parser.add_argument("--check", action="store_true",
                        help="Compare with the committed files; print a diff and exit 1 if either is out of date.")
    args = parser.parse_args()

    outputs = ((GUIDE, render_guide()), (CATALOGUE, render_catalogue()))
    if not args.check:
        for path, text in outputs:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8", newline="\n")
            print(f"{TAG} wrote {path.relative_to(REPO_ROOT).as_posix()}", file=sys.stderr)
        return 0
    stale = []
    for path, text in outputs:
        rel = path.relative_to(REPO_ROOT).as_posix()
        committed = path.read_text(encoding="utf-8") if path.exists() else ""
        if committed == text:
            print(f"{TAG} {rel} is up to date.", file=sys.stderr)
            continue
        sys.stdout.writelines(difflib.unified_diff(
            committed.splitlines(keepends=True), text.splitlines(keepends=True),
            f"{rel} (committed)", f"{rel} (from the registry)"))
        stale.append(f"{rel} {'is out of date' if committed else 'is missing'}")
    if stale:
        print(f"{TAG} {'; '.join(stale)} — run `{REGENERATE}` and commit the result.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

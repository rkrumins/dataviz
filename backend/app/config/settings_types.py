"""What a versioned-graph setting IS — declared in code, with the words that explain it.

Settings had grown seven ways of being stored and explained: a JSON blob, typed columns, columns on
workspaces and data sources, the projection state, labels written once in Python and again in the
app and again in the docs. The explanation of one setting, the read mode, existed seven times, and
some of them contradicted what the code does. An administrator could not tell what a value meant,
what it would change, or where the value in force had come from.

So the split the feature switches already use (``feature_wiring.py``) applies here too:

    CODE owns the FACTS and the WORDS — what a setting is, its range, its default, where it may be
                set and by whom, what it needs to have any effect, when a change takes effect,
                and the guidance: what it means, what it changes, when to change it.
    THE STORE owns the VALUES          — what the platform, a workspace or a graph chose.

``backend/app/config/versioned_graph_settings.py`` holds the content; this module holds only its
shape. It imports nothing but the standard library, so CI's guard job can import it without the
app (``--noconftest``), and the generated guide and the app's catalogue come from the same objects.

    WHO READS WHAT
    --------------
    ``audience`` decides which lens shows a setting first. ``business``: a workspace admin or data
    owner configures it, and the app asks its ``question`` in plain words with outcome cards.
    ``operator``: platform tuning; the app shows it under its category with the technical detail
    (env var, timing, caps). Both lenses show every setting a person may change; the audience only
    orders and frames them.

    GUIDANCE IS REQUIRED
    --------------------
    Every setting carries a summary, what it means, what it changes along each ``Dimension`` when
    raised and when lowered, when to change it, a recommended value and why, a risk, an example,
    and the symptoms it answers. ``tests/test_settings_registry.py`` fails a setting that lacks any
    of them, so a setting cannot ship without its explanation.
"""
from __future__ import annotations

from dataclasses import dataclass, field, fields, is_dataclass
from typing import Any, Callable, Literal, Mapping, Optional, Sequence, Tuple

#: Where a value may be chosen. ``graph`` is a data source's versioned graph (one per data source);
#: a fork has no values of its own and follows its root.
Scope = Literal["platform", "workspace", "graph"]
SCOPES: Tuple[Scope, ...] = ("platform", "workspace", "graph")

#: Who may choose a value at a scope. Platform values are always a system administrator's.
Editor = Literal["system_admin", "workspace_admin"]

#: What a setting trades. Every effect names one, in the words the app shows.
Dimension = Literal["consistency", "availability", "read_speed", "update_speed", "memory",
                    "database_load", "cost"]
DIMENSIONS: Tuple[Dimension, ...] = ("consistency", "availability", "read_speed", "update_speed",
                                     "memory", "database_load", "cost")
DIMENSION_LABELS: Mapping[str, str] = {
    "consistency": "Consistency", "availability": "Availability", "read_speed": "Read speed",
    "update_speed": "Update speed", "memory": "Memory", "database_load": "Database load",
    "cost": "Cost",
}

#: How a value is entered and shown. ``*_or_unlimited`` / ``days_or_forever`` store the words
#: ``"unlimited"`` / ``"forever"`` as values; ``None`` always means "nothing chosen here".
Kind = Literal["bool", "count", "ratio", "percent", "ms", "seconds", "bytes", "choice", "days",
               "days_or_forever", "count_or_unlimited", "bytes_or_unlimited", "identifier",
               "refusal_budget"]

#: When a change is acted on — said in words that are true of the code, each pinned by a test.
TakesEffect = Literal["next_read", "next_write", "next_pass", "next_publish", "build_start",
                      "build_step", "next_switch", "capacity_pass", "hourly_sweep", "reaper_pass",
                      "next_import", "next_draft", "next_review_action", "next_fork", "new_graphs",
                      "next_load"]

Audience = Literal["business", "operator"]
Weight = Literal["low", "medium", "high"]
Risk = Literal["low", "medium", "high"]
Verdict = Literal["better", "same", "worse"]

#: The interactive explainer the app draws beside a setting, if any.
Visual = Literal["read_timeline", "write_rhythm", "memory_marks", "copy_room", "retention_timeline",
                 "idle_timeline", "guard_meter"]

#: A platform administrator's limits on what lower scopes may choose.
LimitKind = Literal["allowed", "range", "lock"]

Values = Mapping[str, Any]          # effective values, by setting key
Facts = Mapping[str, Any]           # live facts about the platform or a graph (sizes, memory, ...)


@dataclass(frozen=True)
class Default:
    """The value in force when no scope chose one: the deployment's env var if it is set and valid,
    else ``code``. ``attr`` names the ``versioning.config`` attribute that reads the env var, so the
    registry test can check the two agree."""
    code: Any
    env: Optional[str] = None
    attr: Optional[str] = None


@dataclass(frozen=True)
class Effect:
    """What raising and lowering a value does to one dimension, in a sentence each. ``up_verdict``
    says whether ``up`` is the better or the worse side for the dimension (``down`` is the other),
    so the app can draw the trade without reading the words. For a switch, ``up`` is turning it on;
    for a choice, ``up`` names the choices that do better on the dimension."""
    dimension: Dimension
    up: str
    down: str
    weight: Weight = "medium"
    up_verdict: Optional[Verdict] = None


@dataclass(frozen=True)
class Frame:
    """One moment of a choice's story: what readers see, and where it is read from."""
    when: Literal["before", "while", "after"]
    shows: str
    source: Literal["graph store", "database"]
    note: str = ""


@dataclass(frozen=True)
class Requirement:
    """A condition for a setting, or one of its choices, to have any effect. Unmet, the setting is
    dormant or the choice falls back, and ``why`` names the text that says so."""
    feature: Optional[str] = None           # a feature switch that must be on
    setting: Optional[str] = None           # another setting that must hold one of ``one_of``
    one_of: Tuple[Any, ...] = ()
    graph_fact: Optional[str] = None        # e.g. "platform_copy": the graph's copy is the platform's
    why: str = ""                           # a key of ``WHY``


@dataclass(frozen=True)
class Choice:
    """One of a ``choice`` setting's options, told as an outcome."""
    id: str
    title: str
    short: str
    promise: str
    effects: Mapping[str, Tuple[Verdict, str]] = field(default_factory=dict)  # dimension → verdict
    good_for: str = ""
    needs: str = ""
    pros: Tuple[str, ...] = ()
    cons: Tuple[str, ...] = ()
    frames: Tuple[Frame, ...] = ()
    example: str = ""
    requires: Tuple[Requirement, ...] = ()
    falls_back_to: Optional[str] = None     # what readers get while a requirement is unmet


@dataclass(frozen=True)
class Cap:
    """A ceiling another value puts on this one. ``enforced`` caps clamp the effective value (and say
    so); advisory ones only warn."""
    setting: Optional[str] = None
    deployment: Optional[str] = None        # an env var name the deployment sets
    enforced: bool = True
    why: str = ""


@dataclass(frozen=True)
class Rule:
    """A cross-field rule checked on save: ``this <op> other (+/- margin)``."""
    op: Literal["<=", ">="]
    other: str
    margin: float = 0
    message: str = ""


@dataclass(frozen=True)
class Recommendation:
    """The value to start from, and why. ``compute`` (optional) recommends from live facts and
    returns ``(value, why)`` or ``None`` to fall back to ``value``."""
    value: Any
    why: str
    compute: Optional[Callable[[Values, Facts], Optional[Tuple[Any, str]]]] = None


@dataclass(frozen=True)
class Guidance:
    """Everything a person needs to decide: required for every setting."""
    summary: str
    means: str
    effects: Tuple[Effect, ...]
    change_when: Tuple[str, ...]
    recommended: Recommendation
    risk: Risk
    risk_note: str
    symptoms: Tuple[str, ...]               # problems this setting is one answer to
    example: Optional[Callable[[Values, Optional[Facts]], str]] = None
    evidence: str = ""
    aliases: Tuple[str, ...] = ()           # words people search with


@dataclass(frozen=True)
class Legacy:
    """Where the value lived before the settings store, for the one-release write-through and the
    old endpoints. ``encode`` says how a value maps to the old shape."""
    build_policy: Optional[str] = None
    residency_policy: Optional[str] = None
    platform_column: Optional[str] = None
    workspace_column: Optional[str] = None
    data_source_column: Optional[str] = None
    projection_state_column: Optional[str] = None
    encode: Optional[Literal["zero_is_forever", "zero_is_unlimited", "minus_one_is_unlimited",
                             "fraction"]] = None


@dataclass(frozen=True)
class Setting:
    key: str
    category: str
    label: str
    kind: Kind
    default: Default
    scopes: Mapping[str, Editor]
    takes_effect: Tuple[TakesEffect, str]
    guidance: Guidance
    audience: Audience = "operator"
    question: str = ""                      # the plain question the business lens asks
    section: Optional[str] = None
    range: Optional[Tuple[float, float]] = None
    unit: Optional[str] = None
    choices: Tuple[Choice, ...] = ()
    limitable: Tuple[LimitKind, ...] = ()
    default_limits: Mapping[str, Any] = field(default_factory=dict)
    requires: Tuple[Requirement, ...] = ()
    uses: Tuple[str, ...] = ()
    caps: Tuple[Cap, ...] = ()
    rules: Tuple[Rule, ...] = ()
    routing: bool = False                   # a change moves route tokens
    freshness: Literal["memo", "strict"] = "memo"
    unreadable: Literal["last_known", "skip"] = "last_known"
    materialized: Optional[str] = None      # e.g. "projection_state.residency"
    visual: Optional[Visual] = None
    legacy: Optional[Legacy] = None
    ui: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Category:
    id: str
    label: str
    summary: str
    icon: str                               # a lucide icon name
    order: int
    audience: Tuple[Audience, ...] = ("operator",)
    master_switch: Optional[str] = None     # a feature switch key
    sections: Tuple[Tuple[str, str], ...] = ()   # (id, title)
    posture: Optional[Callable[[Values, Mapping[str, Any]], str]] = None  # values, switches → sentence


@dataclass(frozen=True)
class Term:
    term: str
    definition: str
    technical: str = ""                     # the engineering word, shown under Technical details


@dataclass(frozen=True)
class Why:
    """Why an effective value differs from the one chosen, and how to fix it."""
    code: str
    text: str
    fix: Optional[Mapping[str, Any]] = None


@dataclass(frozen=True)
class DeploymentFact:
    """A value the deployment sets (env only), shown read-only beside the settings it bounds."""
    env: str
    label: str
    category: str
    means: str
    attr: Optional[str] = None


@dataclass(frozen=True)
class Retired:
    name: str
    why: str


# ---------------------------------------------------------------------------------------------
# One serialisation, used by the API, the generated catalogue and the generated guide
# ---------------------------------------------------------------------------------------------

def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def _plain(obj: Any) -> Any:
    """A dataclass tree as JSON-ready data, camelCase keys, callables left out."""
    if is_dataclass(obj) and not isinstance(obj, type):
        out = {}
        for f in fields(obj):
            value = getattr(obj, f.name)
            if callable(value):
                continue
            out[_camel(f.name)] = _plain(value)
        return out
    if isinstance(obj, Mapping):
        return {str(k): _plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_plain(v) for v in obj]
    return obj


def defaults_of(settings: Sequence[Setting]) -> dict:
    """Each setting's code default, by key: the values an example is rendered with offline."""
    return {s.key: s.default.code for s in settings}


def schema(*, domain: str, categories: Sequence[Category], settings: Sequence[Setting],
           glossary: Sequence[Term], why: Sequence[Why], deployment: Sequence[DeploymentFact],
           retired: Sequence[Retired], values: Optional[Values] = None,
           facts: Optional[Facts] = None) -> dict:
    """The registry as one JSON document. Examples and posture sentences are rendered here, with
    ``values`` (else the code defaults) and ``facts``, so no template language crosses to the app."""
    vals = dict(defaults_of(settings))
    vals.update(values or {})
    out_settings = []
    for s in settings:
        item = _plain(s)
        g = item["guidance"]
        g["example"] = s.guidance.example(vals, facts) if s.guidance.example else ""
        rec = s.guidance.recommended.compute(vals, facts) if (
            s.guidance.recommended.compute and facts) else None
        g["recommended"].pop("compute", None)
        g["recommended"]["forThisPlatform"] = (
            {"value": rec[0], "why": rec[1]} if rec else None)
        item["takesEffect"] = {"when": s.takes_effect[0], "text": s.takes_effect[1]}
        item["docs"] = f"versioned-graph-settings#{s.key.replace('.', '-').lower()}"
        out_settings.append(item)
    out_categories = []
    for c in categories:
        item = _plain(c)
        item["posture"] = c.posture(vals, {}) if c.posture else ""
        item["sections"] = [{"id": sid, "title": title} for sid, title in c.sections]
        out_categories.append(item)
    return {
        "domain": domain,
        "dimensions": [{"id": d, "label": DIMENSION_LABELS[d]} for d in DIMENSIONS],
        "scopes": [{"id": "platform", "label": "Platform"}, {"id": "workspace", "label": "Workspace"},
                   {"id": "graph", "label": "Graph"}],
        "categories": out_categories,
        "settings": out_settings,
        "glossary": _plain(list(glossary)),
        "why": {w.code: {"text": w.text, "fix": _plain(w.fix)} for w in why},
        "deployment": _plain(list(deployment)),
        "retired": _plain(list(retired)),
    }

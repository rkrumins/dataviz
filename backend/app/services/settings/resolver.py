"""Each setting's effective value, and where it came from: pure functions, no IO.

Given the registry (a sequence of :class:`~backend.app.config.settings_types.Setting`), the stored
rows, the feature switches, the deployment's environment (read through an injected reader) and a
target — the platform, a workspace, or a graph — a value is found, most specific first:

    graph (a fork: its root's) → workspace → platform → environment → code default

* The environment counts only if its value parses and is in range; otherwise the code default
  applies and the status says ``invalid_env``.
* The platform's limits: ``lock`` ignores every lower scope; ``allowed`` and ``range`` bound what
  workspace admins may write, but a value already chosen outside them stays in force, marked
  ``exception`` — tightening a limit never silently changes behaviour.
* Then, in order: enforced caps (the deployment's or another setting's, and the cross-field rules,
  as today's policies clamp them), derived values (allowed draft levels force the new-draft
  visibility), and requirements: a setting whose switch is off is ``dormant``; one another setting
  makes unused is ``not_used``; a choice whose requirement is unmet falls back to its
  ``falls_back_to``, ``adjusted``, with the reason and how to fix it.

:func:`resolve` and :func:`resolve_all` give the full answer (``trail``, ``why``, and for an editor
role what it may change); :func:`effective` only the value, for hot paths.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

from backend.app.config.settings_types import SCOPES, Requirement, Setting, Why
from backend.app.services.versioning.import_export import identifier as identifiers

UNLIMITED, FOREVER = "unlimited", "forever"
SYSTEM_ADMIN, WORKSPACE_ADMIN = "system_admin", "workspace_admin"
#: The word a kind takes besides a number.
WORDS = {"count_or_unlimited": UNLIMITED, "bytes_or_unlimited": UNLIMITED,
         "days_or_forever": FOREVER}
#: Kinds whose numbers are whole.
_WHOLE = ("count", "percent", "ms", "seconds", "bytes", "days", *WORDS)


# ── What a resolution reads ───────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Row:
    """One stored value (``setting_values``). ``value`` None: nothing chosen at its scope."""
    key: str
    scope: str
    scope_id: str
    value: Any = None
    limits: Optional[Mapping[str, Any]] = None
    version: int = 0
    rev: int = 0
    updated_at: Any = None
    updated_by: Optional[str] = None


RowKey = Tuple[str, str, str]            # (key, scope, scope_id)


def index(rows: Iterable[Row]) -> Dict[RowKey, Row]:
    """Rows by ``(key, scope, scope_id)``."""
    return {(r.key, r.scope, r.scope_id): r for r in rows}


@dataclass(frozen=True)
class EnvReading:
    """An environment variable as the deployment gives it: ``value`` as the app's config parsed it;
    ``set``: whether the variable is set at all (if not, ``value`` is config's own fallback)."""
    name: str
    value: Any
    set: bool = True


EnvReader = Callable[[str], Optional[EnvReading]]


def no_env(_name: str) -> Optional[EnvReading]:
    """A deployment that sets nothing."""
    return None


@dataclass(frozen=True)
class Target:
    """Whose settings: the platform's; a workspace's (``workspace_id``); or a graph's — ``graph_id``
    is its data source's id, with its ``workspace_id``. ``graph_facts``: what requirements ask of
    the graph — ``platform_copy`` (False: a connected graph, whose copy isn't the platform's) and
    ``fork_of`` (a fork: its root's data source id, whose values it follows). A fact left out is
    not held against the graph."""
    scope: str = "platform"
    workspace_id: Optional[str] = None
    graph_id: Optional[str] = None
    graph_facts: Mapping[str, Any] = field(default_factory=dict)


PLATFORM = Target()


@dataclass(frozen=True)
class Context:
    """Everything a resolution reads, as plain data: build it once per snapshot
    (:func:`context`)."""
    settings: Mapping[str, Setting]
    rows: Mapping[RowKey, Row]
    switches: Mapping[str, Any] = field(default_factory=dict)
    env: EnvReader = no_env
    why: Mapping[str, Why] = field(default_factory=dict)


def context(settings: Sequence[Setting], rows: Union[Mapping[RowKey, Row], Iterable[Row]], *,
            switches: Optional[Mapping[str, Any]] = None, env: EnvReader = no_env,
            why: Sequence[Why] = ()) -> Context:
    """A :class:`Context` from the registry's ``SETTINGS`` and ``WHY``, the rows (or their
    :func:`index`), the feature switches by key (on only when True) and the environment reader."""
    return Context(settings={s.key: s for s in settings},
                   rows=rows if isinstance(rows, Mapping) else index(rows),
                   switches=switches or {}, env=env, why={w.code: w for w in why})


# ── Values ────────────────────────────────────────────────────────────────────────────────────────
def _means(value: Any, n: int) -> bool:
    """Whether ``value`` is the whole number ``n``, as a number or as text (``"-1"``)."""
    return ((type(value) is int and value == n)
            or (isinstance(value, str) and value.strip() == str(n)))


def decode(setting: Setting, old: Any) -> Any:
    """A value in its old spelling (the environment's, or a column's) as the store keeps it:
    ``-1`` or ``0`` as ``"unlimited"`` or ``"forever"``, as the setting's ``legacy.encode`` says."""
    encode = setting.legacy.encode if setting.legacy else None
    if encode == "minus_one_is_unlimited" and _means(old, -1):
        return UNLIMITED
    if encode == "zero_is_unlimited" and _means(old, 0):
        return UNLIMITED
    if encode == "zero_is_forever" and _means(old, 0):
        return FOREVER
    return old


def encode(setting: Setting, value: Any) -> Any:
    """A value in its old spelling: :func:`decode` the other way."""
    encoding = setting.legacy.encode if setting.legacy else None
    if encoding == "minus_one_is_unlimited" and value == UNLIMITED:
        return "-1" if setting.kind == "refusal_budget" else -1
    if encoding == "zero_is_unlimited" and value == UNLIMITED:
        return 0
    if encoding == "zero_is_forever" and value == FOREVER:
        return 0
    return value


def identifier_ok(value: Any) -> bool:
    """An import identifier in its one spelling (``entity_id``, ``urn``, ``prop.<name>``,
    ``prop.<name>,urn``), as ``import_export.identifier.parse`` writes it."""
    try:
        return isinstance(value, str) and identifiers.parse(value) == value
    except identifiers.IdentifierError:
        return False


def budget_ok(value: Any) -> bool:
    """A refused-rows budget: ``"unlimited"``, or ``0``, a count or a share (``"0.5%"``) as the
    import worker reads it (``import_worker.refused_budget``); not its old ``-1``."""
    if value == UNLIMITED:
        return True
    if not isinstance(value, str) or _means(value, -1):
        return False
    # The import worker is heavy to import, and only this needs it: imported when first asked.
    from backend.app.services.versioning.import_export.import_worker import refused_budget

    try:
        return refused_budget(value) == value
    except ValueError:
        return False


def value_error(setting: Setting, value: Any, *, ranged: bool = True) -> Optional[str]:
    """Why ``value`` can't be the setting's — ``invalid_value`` (the wrong kind),
    ``invalid_choice``, ``invalid_identifier``, ``invalid_budget`` or ``out_of_range`` (only with
    ``ranged``) — or None when it can."""
    kind = setting.kind
    if kind == "bool":
        return None if isinstance(value, bool) else "invalid_value"
    if kind == "choice":
        return None if any(c.id == value for c in setting.choices) else "invalid_choice"
    if kind == "identifier":
        return None if identifier_ok(value) else "invalid_identifier"
    if kind == "refusal_budget":
        return None if budget_ok(value) else "invalid_budget"
    if kind in WORDS and value == WORDS[kind]:
        return None
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or (kind in _WHOLE and not isinstance(value, int)) or not math.isfinite(value)):
        return "invalid_value"
    if ranged and setting.range is not None and not setting.range[0] <= value <= setting.range[1]:
        return "out_of_range"
    return None


def as_number(value: Any) -> Optional[float]:
    """A value as a number to compare: the words are infinite; None for anything else."""
    if value in (UNLIMITED, FOREVER):
        return math.inf
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _in_range(setting: Setting, value: Any) -> Any:
    """A number held within the setting's own range, as today's policies hold a saved value."""
    if setting.range is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return value
    lo, hi = setting.range
    held = max(lo, min(hi, value))
    return int(held) if setting.kind in _WHOLE else held


def _at_most(setting: Setting, value: Any, ceiling: Any) -> Any:
    """``value`` capped by ``ceiling`` — never under the setting's own minimum."""
    v, c = as_number(value), as_number(ceiling)
    if v is None or c is None or v <= c:
        return value
    held = max(setting.range[0], c) if setting.range is not None else c
    return int(held) if setting.kind in _WHOLE else held


def _at_least(setting: Setting, value: Any, floor: Any) -> Any:
    v, f = as_number(value), as_number(floor)
    if v is None or f is None or v >= f:
        return value
    held = min(setting.range[1], f) if setting.range is not None else f
    return int(held) if setting.kind in _WHOLE and math.isfinite(held) else held


def _same(a: Any, b: Any) -> bool:
    return a == b and isinstance(a, bool) == isinstance(b, bool)


def outside_limits(limits: Mapping[str, Any], value: Any) -> bool:
    """Whether a value is outside the platform's ``allowed`` or ``range``."""
    allowed = limits.get("allowed")
    if allowed is not None and value not in allowed:
        return True
    bounds = limits.get("range")
    number = as_number(value)
    return bool(bounds) and number is not None and not bounds[0] <= number <= bounds[1]


def _visibility_of_levels(levels: Any) -> Optional[str]:
    """The level a new draft must start at when only one is allowed (``drafts_policy.resolve``)."""
    return levels[:-len("_only")] if isinstance(levels, str) and levels.endswith("_only") else None


#: What one setting forces on another, which no field of ``Setting`` says: the setting that forces
#: it, what it forces for each of its values (None: nothing), and why.
DERIVED: Dict[str, Tuple[str, Callable[[Any], Any], str]] = {
    "drafts.defaultVisibility": ("drafts.levels", _visibility_of_levels, "derived_from_levels"),
}


# ── Resolution ────────────────────────────────────────────────────────────────────────────────────
class _At:
    """The resolutions at one target, each setting's effective value worked out once."""

    def __init__(self, ctx: Context, target: Target):
        self.ctx, self.target = ctx, target
        self.root = target.graph_facts.get("fork_of") if target.scope == "graph" else None
        self.done: Dict[str, Tuple[Any, str]] = {}

    def value(self, key: str) -> Any:
        return self._done(key)[0]

    def source(self, key: str) -> str:
        return self._done(key)[1]

    def _done(self, key: str) -> Tuple[Any, str]:
        if key not in self.done:
            self.resolve(key, explain=False)
        return self.done[key]

    def scope_id(self, scope: str) -> Optional[str]:
        """The target's id at ``scope``: a fork's graph values are its root's."""
        t = self.target
        return {"platform": "", "workspace": t.workspace_id,
                "graph": self.root or t.graph_id}[scope]

    def _chain(self, s: Setting) -> List[Tuple[str, str]]:
        """The scopes the target reads the setting at, from the platform down."""
        chain = []
        for scope in SCOPES[:SCOPES.index(self.target.scope) + 1]:
            scope_id = self.scope_id(scope)
            if scope in s.scopes and (scope == "platform" or scope_id):
                chain.append((scope, scope_id))
        return chain

    def met(self, req: Requirement) -> bool:
        if req.feature is not None and self.ctx.switches.get(req.feature) is not True:
            return False
        if req.setting is not None and self.value(req.setting) not in req.one_of:
            return False
        return not (req.graph_fact is not None and self.target.scope == "graph"
                    and self.target.graph_facts.get(req.graph_fact) is False)

    def resolve(self, key: str, *, explain: bool, editor: Optional[str] = None
                ) -> Dict[str, Any]:
        ctx, t = self.ctx, self.target
        s = ctx.settings[key]
        why: List[Tuple[str, Optional[Mapping[str, Any]]]] = []

        def say(code: str, fix: Optional[Mapping[str, Any]] = None) -> None:
            if explain and all(code != c for c, _f in why):
                why.append((code, fix))

        default, source, env_entry, env_invalid = _default(s, ctx.env)
        chain = self._chain(s)
        platform = ctx.rows.get((key, "platform", ""))
        limits = (platform.limits if platform is not None and platform.limits is not None
                  else s.default_limits)
        below = t.scope != "platform"
        locked = bool(limits.get("lock"))
        if self.root:
            say("follows_root")
        if locked and below:
            say("locked_by_platform")
        declared, exception = default, False
        for scope, scope_id in reversed(chain):
            if locked and scope != "platform":
                continue
            row = ctx.rows.get((key, scope, scope_id))
            if row is None or row.value is None or value_error(s, row.value, ranged=False):
                continue
            declared, source = row.value, scope
            exception = scope != "platform" and outside_limits(limits, row.value)
            break
        if exception:
            say("outside_limits_exception")
        if env_invalid and source == "default":
            say("invalid_env")
        value = _in_range(s, declared)

        for cap in s.caps:
            if not cap.enforced:
                continue
            if cap.setting is not None:
                ceiling = self.value(cap.setting)
            else:
                reading = ctx.env(cap.deployment) if cap.deployment else None
                ceiling = reading.value if reading is not None else None
            capped = _at_most(s, value, ceiling)
            if not _same(capped, value):
                value = capped
                say(cap.why or ("capped_by_setting" if cap.setting else "capped_by_deployment"))
        for rule in s.rules:
            other = as_number(self.value(rule.other))
            if other is None:
                continue
            bound = other - rule.margin if rule.op == "<=" else other + rule.margin
            held = _at_most(s, value, bound) if rule.op == "<=" else _at_least(s, value, bound)
            if not _same(held, value):
                value = held
                say("capped_by_setting")

        derived = DERIVED.get(key)
        if derived is not None and derived[0] in ctx.settings:
            by, forced_by, code = derived
            forced = forced_by(self.value(by))
            if forced is not None and not _same(forced, value):
                value, source = forced, self.source(by)
                say(code)

        dormant = not_used = False
        for req in s.requires:
            if self.met(req):
                continue
            if req.feature is not None and ctx.switches.get(req.feature) is not True:
                dormant = True
            else:
                not_used = True
            say(req.why, _fix(req))
        if s.kind == "choice":
            tried = set()
            while value not in tried:
                tried.add(value)
                choice = next((c for c in s.choices if c.id == value), None)
                unmet = [r for r in (choice.requires if choice else ()) if not self.met(r)]
                for req in unmet:
                    say(req.why, _fix(req))
                if not unmet:
                    break
                if choice.falls_back_to is None:
                    not_used = True
                    break
                value = choice.falls_back_to

        self.done[key] = (value, source)
        status = ("dormant" if dormant else "not_used" if not_used
                  else "adjusted" if not _same(value, declared)
                  else "locked" if locked and below
                  else "exception" if exception
                  else "invalid_env" if env_invalid and source == "default"
                  else "in_effect")
        out: Dict[str, Any] = {"key": key, "effective": value, "declared": declared,
                               "source": source}
        if not explain:
            out["status"] = status
            return out
        out["trail"] = self._trail(s, chain, default, env_entry, limits, locked)
        out["status"] = status
        out["why"] = [_why(ctx, code, fix) for code, fix in why]
        out.update(self._editing(s, limits, locked, editor))
        own = ctx.rows.get((key, t.scope, self.scope_id(t.scope) or ""))
        out["version"] = own.version if own is not None else 0
        return out

    def _trail(self, s: Setting, chain: List[Tuple[str, str]], default: Any,
               env_entry: Optional[Dict[str, Any]], limits: Mapping[str, Any],
               locked: bool) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = [{"scope": "default", "value": default, "env": env_entry}]
        for scope, scope_id in chain:
            row = self.ctx.rows.get((s.key, scope, scope_id))
            value = row.value if row is not None else None
            if scope == "platform":
                out.append({"scope": scope, "value": value, "locked": locked,
                            "limits": dict(limits) if s.limitable else None})
            else:
                entry: Dict[str, Any] = {"scope": scope, "value": value}
                if value is not None:
                    entry["exception"] = outside_limits(limits, value)
                out.append(entry)
        return out

    def _editing(self, s: Setting, limits: Mapping[str, Any], locked: bool,
                 editor: Optional[str]) -> Dict[str, Any]:
        """Who may set the value here, whether ``editor`` (a role) may, and what it may choose."""
        scope = self.target.scope
        may = s.scopes.get(scope)
        editable = (may is not None and not self.root and not (locked and scope != "platform")
                    and (editor == SYSTEM_ADMIN
                         or (editor == WORKSPACE_ADMIN and may == WORKSPACE_ADMIN)))
        return {"editable": editable, "editor": may,
                "allowed": _allowed(s, limits, editor) if editable else None}


def _default(setting: Setting, env: EnvReader
             ) -> Tuple[Any, str, Optional[Dict[str, Any]], bool]:
    """The value in force with nothing chosen: the environment's when it is valid, else the code
    default. Returns it, its source (``env`` or ``default``), the trail's ``env`` entry (None when
    the deployment gives nothing of its own) and whether the environment's value was invalid."""
    code = setting.default.code
    reading = env(setting.default.env) if setting.default.env else None
    if reading is None:
        return code, "default", None, False
    value = decode(setting, reading.value)
    valid = value_error(setting, value) is None
    own = reading.set or not valid or not _same(value, code)
    entry = ({"name": reading.name, "value": value if valid else reading.value, "valid": valid}
             if own else None)
    if not valid:
        return code, "default", entry, True
    return value, "env" if own else "default", entry, False


def _fix(req: Requirement) -> Optional[Dict[str, Any]]:
    """How to meet a requirement, when the registry's reason gives no fix of its own."""
    if req.feature is not None:
        return {"feature": req.feature, "to": True}
    if req.setting is not None and req.one_of:
        return {"setting": req.setting, "to": req.one_of[0]}
    return None


def _why(ctx: Context, code: str, fix: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    known = ctx.why.get(code)
    chosen = known.fix if known is not None and known.fix is not None else fix
    return {"code": code, "text": known.text if known is not None else "",
            "fix": dict(chosen) if chosen is not None else None}


def _allowed(setting: Setting, limits: Mapping[str, Any], editor: Optional[str]) -> Any:
    """What ``editor`` may choose: a choice's ids, or a number's ``{min, max}`` — within the
    platform's limits for a workspace admin."""
    bound = editor != SYSTEM_ADMIN
    if setting.kind == "choice":
        ids = [c.id for c in setting.choices]
        allowed = limits.get("allowed") if bound else None
        return [i for i in ids if i in allowed] if allowed is not None else ids
    if setting.range is None:
        return None
    lo, hi = setting.range
    bounds = limits.get("range") if bound else None
    if bounds:
        lo, hi = max(lo, bounds[0]), min(hi, bounds[1])
    return {"min": lo, "max": hi}


# ── Entry points ──────────────────────────────────────────────────────────────────────────────────
def resolve(ctx: Context, key: str, target: Target = PLATFORM, *,
            editor: Optional[str] = None) -> Dict[str, Any]:
    """One setting at ``target``: ``effective``, ``declared``, ``source`` (``graph``,
    ``workspace``, ``platform``, ``env`` or ``default``), ``trail``, ``status`` (``in_effect``,
    ``adjusted``, ``dormant``, ``not_used``, ``locked``, ``exception``, ``invalid_env``), ``why``
    (``{code, text, fix}``), and for ``editor`` (``system_admin``, ``workspace_admin`` or None)
    ``editable`` and ``allowed``, with ``editor`` the role that may set it here and ``version``
    the value's at this scope (0: none saved)."""
    return _At(ctx, target).resolve(key, explain=True, editor=editor)


def resolve_all(ctx: Context, target: Target = PLATFORM, *,
                editor: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
    """Every setting at ``target``, by key, as :func:`resolve` gives each."""
    at = _At(ctx, target)
    return {key: at.resolve(key, explain=True, editor=editor) for key in ctx.settings}


def effective(ctx: Context, key: str, target: Target = PLATFORM) -> Any:
    """Only the value in force: no trail, no reasons — for a path that runs per request."""
    return _At(ctx, target).value(key)

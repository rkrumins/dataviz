"""What a proposed change set may not do, before :func:`~.store.apply` saves it.

:func:`validate` raises :class:`SettingNotPermitted` (403 ``setting_not_permitted``) for a value the
editor may not set at that scope, naming who may; otherwise it returns every other problem
(422 ``invalid_settings``), each ``{key, code, message}``:

* ``unknown_setting``, ``not_at_scope``: no such setting, or not one chosen at this scope;
* ``invalid_value``, ``out_of_range``, ``invalid_choice``, ``invalid_identifier``,
  ``invalid_budget``: not a value of the setting's kind — the identifier and refused-rows budget
  read as the import paths read them (``import_export.identifier``, ``import_worker``);
* ``rule_violated``: a cross-field rule, on the values that would be chosen once saved (each
  through its scopes, before caps), for the rules a changed value is in;
* ``locked``: the platform locked the setting, so nothing below it may be chosen;
* ``outside_limits``: a workspace admin's value outside the platform's ``allowed`` or ``range``;
* ``limits_not_on_platform``, ``invalid_limits``: limits are the platform's, and say only what the
  setting is ``limitable`` by.
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

from backend.app.config.settings_types import Setting

from . import resolver
from .resolver import SYSTEM_ADMIN, WORKSPACE_ADMIN, Context, Row, Target
from .store import KEEP, Change

_ROLE = {SYSTEM_ADMIN: "a system administrator", WORKSPACE_ADMIN: "a workspace administrator"}
_SCOPE = {"platform": "the platform", "workspace": "a workspace", "graph": "a graph"}


class SettingNotPermitted(Exception):
    """Values the editor may not set (403 ``setting_not_permitted``): ``denied`` holds each,
    ``{key, code, message, editor}``, ``editor`` the role that may set it there (None: no one)."""
    code = "setting_not_permitted"

    def __init__(self, denied: List[Dict[str, Any]]):
        self.denied = denied
        super().__init__("; ".join(d["message"] for d in denied))


def _error(key: str, code: str, message: str) -> Dict[str, str]:
    return {"key": key, "code": code, "message": message}


def _value_message(s: Setting, code: str) -> str:
    if code == "out_of_range":
        lo, hi = s.range
        return f"{s.label} must be from {lo:g} to {hi:g}"
    if code == "invalid_choice":
        return f"{s.label} must be one of: {', '.join(c.id for c in s.choices)}"
    if code == "invalid_identifier":
        return (f"{s.label} must be entity_id, urn, prop.<name> or prop.<name>,urn, written as "
                "the import reads it")
    if code == "invalid_budget":
        return (f"{s.label} must be 0, a count such as 100, a share of the file's rows such as "
                "0.5%, or unlimited")
    words = {"bool": "true or false", "ratio": "a number"}.get(s.kind, "a whole number")
    word = resolver.WORDS.get(s.kind)
    return f"{s.label} must be {words}" + (f", or {word}" if word else "")


def _limits_problem(s: Setting, limits: Any) -> bool:
    """Whether ``limits`` isn't a set of limits the setting may have."""
    if limits is None:
        return False
    if not isinstance(limits, Mapping) or not set(limits) <= set(s.limitable):
        return True
    allowed, bounds, lock = limits.get("allowed"), limits.get("range"), limits.get("lock")
    if allowed is not None and (not isinstance(allowed, list)
                                or any(resolver.value_error(s, v) for v in allowed)):
        return True
    if bounds is not None and not (
            isinstance(bounds, list) and len(bounds) == 2
            and all(resolver.value_error(s, v) is None and not isinstance(v, str) for v in bounds)
            and bounds[0] <= bounds[1]):
        return True
    return lock is not None and not isinstance(lock, bool)


def validate(ctx: Context, target: Target, changes: Sequence[Change], *,
             editor: str) -> List[Dict[str, str]]:
    """Check ``changes`` (all at ``target``'s scope) by ``editor`` (``system_admin`` or
    ``workspace_admin``) against ``ctx`` (the registry and the rows as they are)."""
    scope = target.scope
    denied: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    known: List[Change] = []
    for c in changes:
        s = ctx.settings.get(c.key)
        if s is None:
            errors.append(_error(c.key, "unknown_setting", f"{c.key} is not a setting"))
            continue
        may = s.scopes.get(scope)
        if may is None:
            errors.append(_error(c.key, "not_at_scope",
                                 f"{s.label} can't be set for {_SCOPE[scope]}"))
            continue
        if editor != SYSTEM_ADMIN and not (editor == WORKSPACE_ADMIN and may == WORKSPACE_ADMIN):
            denied.append({"key": c.key, "code": SettingNotPermitted.code, "editor": may,
                           "message": f"Only {_ROLE[may]} may set {s.label} for "
                                      f"{_SCOPE[scope]}"})
            continue
        known.append(c)
    if denied:
        raise SettingNotPermitted(denied)

    for c in known:
        s = ctx.settings[c.key]
        row = ctx.rows.get((c.key, "platform", ""))
        limits = row.limits if row is not None and row.limits is not None else s.default_limits
        below = scope != "platform"
        if c.limits is not KEEP:
            if below:
                errors.append(_error(c.key, "limits_not_on_platform",
                                     f"Only the platform's value of {s.label} has limits"))
            elif _limits_problem(s, c.limits):
                allowed = ", ".join(s.limitable) or "none"
                errors.append(_error(c.key, "invalid_limits",
                                     f"{s.label}'s limits may say only: {allowed}"))
        if c.value is KEEP or c.value is None:
            continue
        code = resolver.value_error(s, c.value)
        if code is not None:
            errors.append(_error(c.key, code, _value_message(s, code)))
        elif below and limits.get("lock"):
            errors.append(_error(c.key, "locked", f"{s.label} is set for the whole platform and "
                                                  "can't be chosen here"))
        elif below and editor != SYSTEM_ADMIN and resolver.outside_limits(limits, c.value):
            bounds = limits.get("range")
            within = (", ".join(map(str, limits["allowed"])) if limits.get("allowed") is not None
                      else f"from {bounds[0]:g} to {bounds[1]:g}")
            errors.append(_error(c.key, "outside_limits",
                                 f"{s.label} may be chosen here only as the platform allows: "
                                 f"{within}"))
    if errors:
        return errors
    return _rules(ctx, target, known)


def _rules(ctx: Context, target: Target, changes: Sequence[Change]) -> List[Dict[str, str]]:
    """The cross-field rules a changed value is in, on what would be chosen once saved."""
    own_id = {"platform": "", "workspace": target.workspace_id,
              "graph": target.graph_id}[target.scope] or ""
    rows: Dict[Any, Row] = dict(ctx.rows)
    for c in changes:
        if c.value is not KEEP:
            old = rows.get((c.key, target.scope, own_id))
            rows[(c.key, target.scope, own_id)] = Row(
                c.key, target.scope, own_id, c.value,
                old.limits if old is not None else None)
    after = Context(ctx.settings, rows, ctx.switches, ctx.env, ctx.why)
    changed = {c.key for c in changes if c.value is not KEEP}
    errors = []
    for s in ctx.settings.values():
        for rule in s.rules:
            if not {s.key, rule.other} & changed:
                continue
            this = resolver.resolve(after, s.key, target)["declared"]
            other = resolver.resolve(after, rule.other, target)["declared"]
            a, b = resolver.as_number(this), resolver.as_number(other)
            if a is None or b is None:
                continue
            broken = a > b - rule.margin if rule.op == "<=" else a < b + rule.margin
            if broken:
                other_label = ctx.settings[rule.other].label
                bound = f"{other_label} ({other})" + (
                    f" {'-' if rule.op == '<=' else '+'} {rule.margin:g}" if rule.margin else "")
                word = "more" if rule.op == "<=" else "less"
                errors.append(_error(s.key if s.key in changed else rule.other, "rule_violated",
                                     rule.message or f"{s.label} ({this}) may not be {word} "
                                                     f"than {bound}"))
    return errors

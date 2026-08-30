"""Package-split guard tests for ``backend/app/providers/falkordb/``.

``FalkorDBProvider`` is a bases tuple over fifteen mixins. Nothing about
ordinary Python enforces that the split stayed honest: a mixin could read an
attribute no one sets, a memo set could have been duplicated across two
modules, a satellite module could start importing the shim at module level
and put an import cycle one edit away. These seven guards make each of
those states fail loudly instead of silently.

AST/grep based, no conftest dependency -- same reasoning as
``test_falkordb_no_unlabeled_unwind_match.py``: it must run without
spinning up the full conftest stack (auth-service deps that aren't
installed in every CI lane).

The seven guards (several map to more than one test function below so a
failure names exactly what broke):

  1. No private import from the shim (``falkordb_provider``) in
     ``backend/app`` or ``backend/common``, outside a shrinking allow-list.
  2. Every ``self._x`` read in the package resolves to something real.
  3. The three memo sets (``_UNLABELED_URN_UNSUPPORTED``,
     ``_INDEX_HEALTH_LOGGED``, ``_BULK_CREATE_KNOBS_CACHE``) are defined
     exactly once and re-exported as the same object everywhere.
  4. No module-level import of the four satellite modules
     (``falkordb_deep_search``, ``falkordb_materialize``,
     ``falkordb_connection``, ``manager``) -- the cycle guard.
  5. No relative imports in ``falkordb/*.py`` except ``__init__.py``'s
     level-1 sibling imports; no level->=2 relative import anywhere.
  6. The shim and the package hand back the identical object for every
     name in the measured export surface.
  7. The instance-patch seam (assigning over ``_ro_query`` /
     ``_ensure_connected`` on a live instance) is intact.
"""
from __future__ import annotations

import ast
import asyncio
import collections
import pathlib
import types
from typing import Dict, FrozenSet, List, Optional, Set, Tuple

from backend.app.providers.falkordb._state import (
    CLASS_CONSTANTS,
    INIT_ASSIGNED,
    LATE_ASSIGNED,
)

_APP_DIR = pathlib.Path(__file__).resolve().parent.parent / "app"
_COMMON_DIR = pathlib.Path(__file__).resolve().parent.parent / "common"
_PKG_DIR = _APP_DIR / "providers" / "falkordb"


def _run(coro):
    return asyncio.run(coro)


def _parse(path: pathlib.Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


# ===========================================================================
# Guard 1 -- no private import from the shim outside the (expiring)
# allow-list.
# ===========================================================================

_SHIM_MODULE = "backend.app.providers.falkordb_provider"

# Measured directly against backend/app and backend/common. PR 2 repoints
# every one of these six versioning-family call sites at the package
# directly (see docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md
# section 5.1) and this allow-list is deleted with them -- an allow-list
# that names its own expiry. Keyed by (file, exact private names it may
# import) rather than just by file, so a NEW private import from an
# already-listed file also fails the guard, not just a new file.
_GUARD1_ALLOWLIST: Dict[str, FrozenSet[str]] = {
    "app/api/v1/endpoints/versioning.py": frozenset({"_edge_from_row", "_node_from_props"}),
    "app/services/versioning/service.py": frozenset({"_sanitize_node_properties"}),
    "app/services/versioning/entity_serde.py": frozenset({"_sanitize_node_properties"}),
    "app/services/versioning/projection.py": frozenset({
        "_compute_searchable_text", "_sanitize_label", "_split_user_properties",
    }),
    "app/services/versioning/reconcile.py": frozenset({"_sanitize_label"}),
    "app/services/versioning/bootstrap_worker.py": frozenset({"_node_from_props", "_edge_from_row"}),
}


def _is_private(name: str) -> bool:
    return name.startswith("_") and not name.startswith("__")


def test_guard1_no_private_shim_imports_outside_allowlist():
    """Every ``from backend.app.providers.falkordb_provider import _x`` in
    backend/app or backend/common must be on the allow-list above. A
    private import from a file that isn't listed -- or a NEW private name
    from a file that is -- means a fresh dependency on the shim's
    internals was added; point it at the package's leaf module instead of
    growing this list.
    """
    violations: List[str] = []
    for root in (_APP_DIR, _COMMON_DIR):
        for path in sorted(root.rglob("*.py")):
            tree = _parse(path)
            rel = path.relative_to(_APP_DIR.parent).as_posix()
            allowed = _GUARD1_ALLOWLIST.get(rel, frozenset())
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom) or node.module != _SHIM_MODULE:
                    continue
                for alias in node.names:
                    if _is_private(alias.name) and alias.name not in allowed:
                        violations.append(
                            f"{rel}:{node.lineno} imports private name "
                            f"{alias.name!r} from the shim ({_SHIM_MODULE}) "
                            f"and is not on _GUARD1_ALLOWLIST. Point it at "
                            f"the package's leaf module instead, or -- if "
                            f"this genuinely cannot move yet -- add it to "
                            f"the allow-list here with a comment saying why."
                        )
    assert not violations, "\n".join(violations)


# ===========================================================================
# Shared AST measurement for guards 2, 3, 4 and 5 -- an AST walk of every
# `self.X` store and load in the package's mixin classes, plus every
# class-level constant and method/property they define. Computed fresh
# here at collection time rather than trusted from a prior run, so a later
# carve that changes the package is judged against itself, not a stale
# snapshot.
# ===========================================================================


def _is_provider_class(name: str) -> bool:
    """Only mixins and the composed class carry provider state -- the
    package's small helper dataclasses (``AggRunMeta``,
    ``AggregationBatchAbort``, ``_ClosureWalk``, ``_EmptyResult``; see
    ``_state.HELPER_CLASSES_EXCLUDED``) have their own unrelated
    ``self.x`` attributes and must not be folded in."""
    return name.endswith("Mixin") or name == "FalkorDBProvider"


class _PackageState:
    """One AST pass over every ``falkordb/*.py`` module, collecting
    everything guard 2 needs to judge whether a ``self._x`` read resolves,
    plus the module-level data guards 3-5 need."""

    def __init__(self, pkg_dir: pathlib.Path):
        self.init_assigned: Set[str] = set()
        self.assigned_elsewhere: Dict[str, List[str]] = collections.defaultdict(list)
        self.methods: Set[str] = set()
        self.class_consts: Set[str] = set()
        self.const_owners: Dict[str, List[str]] = collections.defaultdict(list)
        self.read_sites: Dict[str, List[str]] = collections.defaultdict(list)

        for path in sorted(pkg_dir.glob("*.py")):
            tree = _parse(path)
            module = path.stem
            for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
                if not _is_provider_class(cls.name):
                    continue
                for node in cls.body:
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        self.methods.add(node.name)
                    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        for t in targets:
                            if isinstance(t, ast.Name):
                                self.class_consts.add(t.id)
                                self.const_owners[t.id].append(f"{module}.{cls.name}")
                for fn in (n for n in ast.walk(cls) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
                    where = f"{module}.{cls.name}.{fn.name}"
                    for sub in ast.walk(fn):
                        targets = []
                        if isinstance(sub, ast.Assign):
                            targets = sub.targets
                        elif isinstance(sub, (ast.AugAssign, ast.AnnAssign)):
                            targets = [sub.target]
                        for t in targets:
                            for leaf in ast.walk(t):
                                if (
                                    isinstance(leaf, ast.Attribute)
                                    and isinstance(leaf.value, ast.Name)
                                    and leaf.value.id == "self"
                                ):
                                    if fn.name == "__init__":
                                        self.init_assigned.add(leaf.attr)
                                    else:
                                        self.assigned_elsewhere[leaf.attr].append(f"{where}:{sub.lineno}")
                        if (
                            isinstance(sub, ast.Attribute)
                            and isinstance(sub.ctx, ast.Load)
                            and isinstance(sub.value, ast.Name)
                            and sub.value.id == "self"
                        ):
                            self.read_sites[sub.attr].append(f"{where}:{sub.lineno}")

        self.late_assigned: Set[str] = {
            n for n in self.assigned_elsewhere if n not in self.init_assigned
        }


_STATE = _PackageState(_PKG_DIR)


# ===========================================================================
# Guard 2 -- every self._x read resolves, and _state.py stays honest about
# what "resolves" means.
# ===========================================================================


def test_guard2_init_assigned_matches_state_py():
    """``_state.py``'s ``INIT_ASSIGNED`` must name exactly the attributes
    ``ConnectionMixin.__init__`` assigns -- no more, no fewer. This is
    ``_state.py`` drifting out of sync with the code it documents, not a
    read-resolution failure; the failure message below names exactly what
    changed, so update ``_state.py`` to match in the same commit as
    whatever carve changed ``__init__``.
    """
    missing = _STATE.init_assigned - INIT_ASSIGNED
    extra = INIT_ASSIGNED - _STATE.init_assigned
    assert not missing and not extra, (
        f"_state.py's INIT_ASSIGNED is out of sync with "
        f"ConnectionMixin.__init__. Assigned in __init__ but missing from "
        f"_state.py: {sorted(missing)}. Documented in _state.py but no "
        f"longer assigned in __init__: {sorted(extra)}."
    )


def test_guard2_late_assigned_matches_state_py():
    """Mirror of the above for ``LATE_ASSIGNED`` -- the attributes assigned
    only outside ``__init__``, absent on a ``__new__``-built instance."""
    missing = _STATE.late_assigned - set(LATE_ASSIGNED)
    extra = set(LATE_ASSIGNED) - _STATE.late_assigned
    assert not missing and not extra, (
        f"_state.py's LATE_ASSIGNED is out of sync with the package. "
        f"Newly late-assigned attributes not yet documented: "
        f"{sorted(missing)}. Documented as late-assigned but the code no "
        f"longer matches (now assigned in __init__, or not assigned "
        f"anywhere): {sorted(extra)}."
    )


def test_guard2_self_attribute_reads_resolve():
    """The guard that catches a carve that took a method away from the
    attribute (or constant) that feeds it. Every ``self._x``-shaped read
    anywhere in the package's mixins must resolve to one of:

      (a) an attribute ``ConnectionMixin.__init__`` assigns,
      (b) a name in ``_state.py``'s ``LATE_ASSIGNED`` list,
      (c) a method or property defined on some mixin (cross-mixin calls
          resolve through ``FalkorDBProvider``'s MRO, never an import),
      (d) a class-level constant defined on some mixin (same MRO
          reasoning -- see ``_state.CLASS_CONSTANTS`` for the eight that
          are read from a DIFFERENT mixin than the one that defines them,
          which resolve for exactly this reason).

    Honest limit, stated rather than implied: a dynamically-named
    ``getattr(self, some_variable)`` -- see
    ``ontology.OntologyMixin._alias_types``, whose one caller passes the
    attribute name as a parameter rather than a literal -- is invisible to
    this or any static guard. ``_state.py``'s ``LATE_ASSIGNED`` documents
    both attributes reached only that way (``_source_rel_aliases``,
    ``_source_entity_aliases``) by hand for exactly this reason; this test
    cannot see their reads at all, only their assignment.
    """
    assigned_or_callable = _STATE.init_assigned | _STATE.late_assigned | _STATE.methods
    # Names read via self.X that are neither assigned anywhere (init or
    # late) nor a method/property -- these must be explained as class
    # constants (category d) or they are genuinely unresolved.
    remaining = {
        name: sites
        for name, sites in _STATE.read_sites.items()
        if name not in assigned_or_callable and not name.startswith("__")
    }
    unresolved = {
        name: sites for name, sites in remaining.items() if name not in _STATE.class_consts
    }
    assert not unresolved, "\n".join(
        f"self.{name} is read at {sites} but is never assigned in the "
        f"package (init or late), never a method/property on any mixin, "
        f"and never a class constant. Likely a carve that moved a method "
        f"away from the attribute/constant that feeds it, or a typo'd "
        f"attribute name -- fix the read, or add the attribute to "
        f"_state.py's LATE_ASSIGNED if it is genuinely new provider state."
        for name, sites in sorted(unresolved.items())
    )


def test_guard2_class_constants_matches_state_py():
    """The names left over once every assigned attribute, method and
    property is accounted for (guard 2's ``remaining``, above) must be
    EXACTLY ``_state.py``'s documented ``CLASS_CONSTANTS`` -- the constants
    read from a mixin other than the one that owns them. Fewer means a
    documented cross-boundary constant stopped being read that way (dead
    documentation, harmless but stale); more means a NEW one appeared
    without being added to ``_state.py``, which is the same drift guard 2's
    other two cross-checks run for ``INIT_ASSIGNED`` / ``LATE_ASSIGNED``.
    """
    assigned_or_callable = _STATE.init_assigned | _STATE.late_assigned | _STATE.methods
    remaining = {
        name for name in _STATE.read_sites if name not in assigned_or_callable and not name.startswith("__")
    }
    documented = set(CLASS_CONSTANTS)
    missing = remaining - documented
    extra = documented - remaining
    assert not missing and not extra, (
        f"_state.py's CLASS_CONSTANTS is out of sync with the package. "
        f"Read cross-boundary but not documented: {sorted(missing)}. "
        f"Documented but no longer read that way: {sorted(extra)}."
    )
    owner_problems = [
        f"CLASS_CONSTANTS[{name!r}] says owner {owner!r}, but the package "
        f"defines it on {_STATE.const_owners.get(name, [])!r}"
        for name, owner in CLASS_CONSTANTS.items()
        if name in remaining and owner not in _STATE.const_owners.get(name, [])
    ]
    assert not owner_problems, "\n".join(owner_problems)


# ===========================================================================
# Guard 3 -- the three memo sets are defined exactly once and re-exported
# as the same object everywhere.
# ===========================================================================

_MEMO_SET_NAMES = ("_UNLABELED_URN_UNSUPPORTED", "_INDEX_HEALTH_LOGGED", "_BULK_CREATE_KNOBS_CACHE")


def _module_level_assign_targets(tree: ast.Module) -> Set[str]:
    """Names assigned at module top level (not inside a function or
    class) -- where module state like the memo sets is defined."""
    names: Set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def test_guard3_memo_sets_defined_exactly_once():
    """A second ``_INDEX_HEALTH_LOGGED = set()`` in another module -- even
    if only one of the two copies is re-exported -- means whichever mixin
    reads the OTHER copy re-probes and re-logs a per-server fact once per
    graph: cheap to write, invisible in tests, expensive in production.
    Each of the three memo names must be defined at module level in
    exactly one ``falkordb/*.py`` file.
    """
    defined_in: Dict[str, List[str]] = collections.defaultdict(list)
    for path in sorted(_PKG_DIR.glob("*.py")):
        tree = _parse(path)
        for name in _module_level_assign_targets(tree) & set(_MEMO_SET_NAMES):
            defined_in[name].append(path.name)
    problems = [
        f"{name} is defined at module level in {files} -- expected exactly one file."
        for name in _MEMO_SET_NAMES
        for files in [defined_in.get(name, [])]
        if len(files) != 1
    ]
    assert not problems, "\n".join(problems)


def test_guard3_memo_sets_are_the_same_object_everywhere():
    """The package's ``__init__.py`` and the compatibility shim must both
    re-export the SAME object the owning module defines, not an equal
    copy. ``tests/test_falkordb_empty_graph.py`` calls
    ``fp._BULK_CREATE_KNOBS_CACHE.clear()`` through the shim; a re-exported
    copy would leave the real cache warm while that test believed it had
    reset it."""
    import backend.app.providers.falkordb as pkg
    import backend.app.providers.falkordb_provider as shim
    from backend.app.providers.falkordb import knobs, schema

    owners = {
        "_UNLABELED_URN_UNSUPPORTED": schema,
        "_INDEX_HEALTH_LOGGED": schema,
        "_BULK_CREATE_KNOBS_CACHE": knobs,
    }
    problems = []
    for name, owner in owners.items():
        owner_obj = getattr(owner, name)
        pkg_obj = getattr(pkg, name, None)
        shim_obj = getattr(shim, name, None)
        if pkg_obj is not owner_obj:
            problems.append(f"falkordb.{name} is not the same object as {owner.__name__}.{name}")
        if shim_obj is not owner_obj:
            problems.append(f"falkordb_provider.{name} is not the same object as {owner.__name__}.{name}")
    assert not problems, "\n".join(problems)


# ===========================================================================
# Guard 4 -- the cycle guard: no import-time (module- or class-body-level)
# import of the four satellite modules.
# ===========================================================================

_SATELLITE_LAST_COMPONENTS = frozenset({
    "falkordb_deep_search", "falkordb_materialize", "falkordb_connection", "manager",
})


def _import_time_statements(node):
    """Yield statements that execute when the module is first imported --
    direct children of the module body and (recursively) of any nested
    compound statement or class body, EXCEPT the body of a
    function/``async def`` (which only runs when called, so an import
    inside one is deliberately lazy, not import-time)."""
    for child in (
        list(getattr(node, "body", []))
        + list(getattr(node, "orelse", []))
        + list(getattr(node, "finalbody", []))
    ):
        yield child
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield from _import_time_statements(child)


def _satellite_hit(node) -> Optional[str]:
    if isinstance(node, ast.Import):
        for alias in node.names:
            last = alias.name.rsplit(".", 1)[-1]
            if last in _SATELLITE_LAST_COMPONENTS:
                return alias.name
    elif isinstance(node, ast.ImportFrom) and node.module:
        last = node.module.rsplit(".", 1)[-1]
        if last in _SATELLITE_LAST_COMPONENTS:
            return node.module
        for alias in node.names:
            if alias.name in _SATELLITE_LAST_COMPONENTS:
                return f"{node.module}.{alias.name}"
    return None


def test_guard4_no_module_level_satellite_imports():
    """``falkordb_deep_search``, ``falkordb_materialize``,
    ``falkordb_connection`` and ``manager`` may appear only inside function
    bodies in ``falkordb/*.py`` -- the cycle guard. An import-time import
    of any of them puts a real import cycle one edit away:
    ``falkordb_connection.py:1380`` already back-imports the provider's
    error classifiers, lazily, for exactly this reason -- an eager version
    of that same import would deadlock the two modules' imports of each
    other.
    """
    violations = []
    for path in sorted(_PKG_DIR.glob("*.py")):
        tree = _parse(path)
        for node in _import_time_statements(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                hit = _satellite_hit(node)
                if hit:
                    violations.append(f"{path.name}:{node.lineno} imports {hit!r} at import time, not lazily")
    assert not violations, "\n".join(violations)


# ===========================================================================
# Guard 5 -- relative imports: absolute everywhere except __init__.py's
# level-1 sibling imports; never level >= 2 anywhere.
# ===========================================================================


def test_guard5_no_relative_imports_outside_init():
    """Leaf and mixin modules stay absolute so a later PR can relocate them
    without rewriting imports. ``__init__.py`` is the package aggregator --
    its ten level-1 sibling imports (``.provider``, ``._log``, ``.rowmap``,
    etc.) are the standard idiom for an aggregator and are correct, not
    what this guard is about: "no relative imports anywhere, full stop"
    would be the wrong rule, since it would flag those ten correct imports
    right alongside a genuine mistake. This guard is written to the actual
    rationale (absolute imports outside the aggregator so a later PR can
    relocate a leaf module freely) rather than to that broader-sounding
    but wrong rule.
    """
    violations = []
    for path in sorted(_PKG_DIR.glob("*.py")):
        if path.name == "__init__.py":
            continue
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level > 0:
                violations.append(f"{path.name}:{node.lineno} is a relative import (level {node.level})")
    assert not violations, "\n".join(violations)


def test_guard5_no_deep_relative_imports_anywhere():
    """``..config`` one directory deeper resolves somewhere else entirely
    (``backend.app.providers.config``, which does not exist) and would
    fail at call time, not import time. No level->=2 relative import
    anywhere in the package, ``__init__.py`` included.
    """
    violations = []
    for path in sorted(_PKG_DIR.glob("*.py")):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level >= 2:
                violations.append(f"{path.name}:{node.lineno} is a level-{node.level} relative import")
    assert not violations, "\n".join(violations)


# ===========================================================================
# Guard 6 -- shim/package export identity.
# ===========================================================================

# The measured union export-surface.md computed the shim must satisfy
# (AST pass over all of backend/ at commit d7e57103): every name the repo
# imports from the shim by name or reads off the module object, plus the
# plan's defensive additions. Deliberately NOT derived from either
# module's own __all__ -- that would make this guard blind to exactly the
# failure it exists to catch, one of the two __all__ lists quietly losing
# a name.
_EXPORT_SURFACE: Tuple[str, ...] = (
    "asyncio", "FalkorDBProvider", "_sanitize_label", "AggRunMeta", "_node_from_props",
    "_RESERVED_NODE_KEYS", "_split_user_properties", "resolve_falkordb_target",
    "_compute_searchable_text", "_decode_keyset_cursor", "_sanitize_node_properties",
    "CursorMismatchError", "_edge_from_row", "_encode_keyset_cursor",
    "_is_transient_connection_error", "_is_cluster_routing_error", "_is_loading_error",
    "_is_missing_graph_error", "_is_null_handle_error", "_keyset_sort", "_keyset_sort_key",
    "_normalize_falkordb_host", "_validate_sort_direction", "_BULK_CREATE_KNOBS_CACHE",
    "CLOSURE_QUERY_CAP_SECS", "_BULK_CREATE_BATCH_DEFAULT", "_BULK_CREATE_TIMEOUT_DEFAULT",
    "logger", "AggregationBatchAbort", "_EmptyResult", "_CURSOR_PREFIX",
    "_TRANSIENT_RETRY_BACKOFFS", "_ClosureWalk", "_completed", "CLOSURE_FRONTIER_PROBE_CAP",
    "CLOSURE_WALK_SLICE", "CLOSURE_WALK_RESERVE_FRACTION", "_UNLABELED_URN_UNSUPPORTED",
    "_INDEX_HEALTH_LOGGED", "_resolve_bulk_create_knobs",
)


def test_guard6_export_list_identity():
    """For every name ``export-surface.md`` measured as required, the shim
    and the package must hand back the SAME object, not an equal copy --
    what makes ``fp._BULK_CREATE_KNOBS_CACHE.clear()`` (an existing test)
    reset the cache the real code actually reads, instead of a re-exported
    copy that leaves it warm.
    """
    import backend.app.providers.falkordb as pkg
    import backend.app.providers.falkordb_provider as shim

    problems = []
    for name in _EXPORT_SURFACE:
        has_pkg = hasattr(pkg, name)
        has_shim = hasattr(shim, name)
        if not (has_pkg and has_shim):
            problems.append(
                f"{name!r} missing from {'shim' if not has_shim else 'package'} "
                f"(package has it: {has_pkg}, shim has it: {has_shim})"
            )
            continue
        if getattr(pkg, name) is not getattr(shim, name):
            problems.append(f"{name!r} resolves to a DIFFERENT object in the package vs. the shim")
    assert not problems, "\n".join(problems)


# ===========================================================================
# Guard 7 -- the instance-patch seam is intact.
#
# The unit suite fakes the database by ASSIGNING OVER a provider's own
# methods on a live instance: `p._ro_query = fake` (26 sites),
# `p._ensure_connected = noop` (37 sites). That only works because these
# are plain instance methods a plain attribute assignment can shadow. If a
# refactor ever turns either into something an instance assignment can no
# longer intercept (a module-level function call, something bound at
# class-definition time via a decorator or descriptor, etc.), every one of
# those sites starts silently exercising the REAL code path -- or hitting
# a real database -- while still reporting green. These two tests are the
# tripwire; they are worthless if they can never fail, which is why each
# was deliberately broken and confirmed to fail (with these exact
# messages) before being committed passing.
#
# ``get_counts_fast`` is the target because ``tests/test_falkordb_counts_
# fast.py:42-70`` is already the suite's canonical instance-patch fixture
# for it -- this follows that shape rather than inventing a new one. Two
# things carried over from it, both load-bearing: ``_SCHEMA_CACHE_TTL = 0``
# (a cache hit would let ``get_counts_fast`` -- or a sibling like
# ``get_stats`` -- return early having issued zero Cypher, which would look
# EXACTLY like a broken seam even though the seam is fine; forcing the TTL
# to 0 removes that ambiguity) and the fake's ``(cypher, params=None,
# **kw)`` signature (the chokepoints call with ``timeout=``/``op=``
# keywords; a narrower signature fails with a TypeError that reads like a
# bug in the provider rather than in the test).
# ===========================================================================


def test_guard7_ro_query_patch_seam_is_intact():
    from backend.app.providers.falkordb import FalkorDBProvider

    p = FalkorDBProvider(host="x", graph_name="g")
    p._SCHEMA_CACHE_TTL = 0  # load-bearing -- see the guard-7 block comment above

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect  # neutralize the OTHER chokepoint; not under test here

    issued: List[str] = []

    async def _ro_query(cypher, params=None, **kw):
        issued.append(cypher)
        return types.SimpleNamespace(result_set=[])

    p._ro_query = _ro_query

    result = _run(p.get_counts_fast())

    assert issued, (
        "assigning `p._ro_query = <fake>` on a live FalkorDBProvider "
        "instance did not intercept get_counts_fast()'s queries (issued "
        "via _ro_query_tolerant, which itself calls self._ro_query, so "
        "patching the instance attribute intercepts both). This is the "
        "exact shape 26 test call sites in this suite depend on -- "
        "if `_ro_query` stopped being a plain instance method, every test "
        "that patches it is now silently exercising the real code path "
        "(or hitting a real database) instead of its fake, while still "
        "reporting green. (A cache hit would look identical to this "
        "failure, which is why _SCHEMA_CACHE_TTL is forced to 0 above --  "
        "rule that out before suspecting the seam.)"
    )
    assert result == {"nodeCount": 0, "edgeCount": 0, "entityTypeCounts": {}, "edgeTypeCounts": {}}


def test_guard7_ensure_connected_patch_seam_is_intact():
    from backend.app.providers.falkordb import FalkorDBProvider

    p = FalkorDBProvider(host="x", graph_name="g")
    p._SCHEMA_CACHE_TTL = 0  # load-bearing -- see the guard-7 block comment above

    async def _ro_query(cypher, params=None, **kw):
        return types.SimpleNamespace(result_set=[])

    p._ro_query = _ro_query  # neutralize the OTHER chokepoint; not under test here

    calls: List[None] = []

    async def _ensure_connected_spy():
        calls.append(None)

    p._ensure_connected = _ensure_connected_spy

    result = _run(p.get_counts_fast())

    assert calls, (
        "assigning `p._ensure_connected = <fake>` on a live FalkorDBProvider "
        "instance did not intercept get_counts_fast()'s connection check. "
        "This is the exact shape 37 test call sites in this suite depend "
        "on -- if `_ensure_connected` stopped being a plain instance "
        "method, every test that patches it is now silently "
        "attempting a real connection instead of its fake, while still "
        "reporting green. (A cache hit would look identical to this "
        "failure, which is why _SCHEMA_CACHE_TTL is forced to 0 above -- "
        "rule that out before suspecting the seam.)"
    )
    assert result == {"nodeCount": 0, "edgeCount": 0, "entityTypeCounts": {}, "edgeTypeCounts": {}}

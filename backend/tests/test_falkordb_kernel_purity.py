"""Kernel-purity guard: ``backend/common/providers/`` imports zero
``backend.app`` modules.

That is the whole point of the kernel split this PR started: the kernel
is imported by graph adapters (FalkorDB today, a second engine in PR 3)
and by workers that never mount the app, so an app import here would
break those at import time -- or at call time, for an import inside a
function body -- rather than merely being an unwanted dependency. Task
12's guards cover the falkordb package only; nothing enforced this for
the kernel until now, and this task is the one that makes it load-bearing
by adding the kernel's first subpackage
(``backend/common/providers/cypher/``).

AST-based, not grep-based, so a docstring or comment mentioning
"backend.app" doesn't count -- only a real ``Import``/``ImportFrom`` node,
wherever it appears in the module (module level or nested inside a
function body; a lazy import is still a violation here, unlike the
falkordb package's cycle guard, which deliberately tolerates lazy
imports of its four satellites).

Scoped to ``backend/common/providers/`` only, not ``backend/common/`` at
large: ``backend/common/models/search.py:605`` has a deliberate
in-function import of an app module, with a comment explaining the
circular dependency it avoids. It predates this PR and is out of scope
here -- widening this guard to cover it would fail on arrival and pull an
unrelated fix into this diff.

(The filename carries ``falkordb``, which is what puts it in CI's
required lane, even though the guard itself is about the kernel package
rather than the falkordb package -- the same reasoning that names
``test_falkordb_no_unlabeled_unwind_match.py``, which also scans beyond
the falkordb package under that filename constraint.)
"""
from __future__ import annotations

import ast
import pathlib
from typing import List, Optional

_PROVIDERS_DIR = pathlib.Path(__file__).resolve().parent.parent / "common" / "providers"
_BACKEND_DIR = _PROVIDERS_DIR.parent.parent


def _parse(path: pathlib.Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _backend_app_import_target(node) -> Optional[str]:
    """The offending dotted import target, or None."""
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name == "backend.app" or alias.name.startswith("backend.app."):
                return alias.name
    elif isinstance(node, ast.ImportFrom) and node.module:
        if node.module == "backend.app" or node.module.startswith("backend.app."):
            return node.module
    return None


def test_kernel_imports_zero_backend_app_modules():
    """``backend/common/providers/`` is the kernel a second database
    engine -- and PR-3's provider base -- is built on, and it is also
    imported by workers that never mount the app. An app import anywhere
    in this tree (module level or inside a function body) breaks those
    the moment it runs, not just the moment it's noticed.
    """
    violations: List[str] = []
    for path in sorted(_PROVIDERS_DIR.rglob("*.py")):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                target = _backend_app_import_target(node)
                if target:
                    rel = path.relative_to(_BACKEND_DIR)
                    violations.append(f"{rel}:{node.lineno} imports {target!r}")
    assert not violations, (
        "backend/common/providers/ must import zero backend.app modules -- "
        "it is the kernel a second database engine (and PR-3's provider "
        "base) is built on, and it is also imported by workers that never "
        "mount the app. An app import here breaks those at import time "
        "(or at call time, if the import sits inside a function body), not "
        "merely adds an unwanted dependency:\n" + "\n".join(violations)
    )

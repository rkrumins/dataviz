"""
Module-boundary regression test.

The auth service is being prepared for extraction into its own
microservice; this test asserts that nothing inside ``backend/auth_service/``
imports from ``backend/app/``. If this test fails, a recently added
module pulled in app code that would have to be packaged into the new
service alongside the auth code — usually a sign that the wrong layer
owns the new symbol.

Allowed dependencies for ``auth_service``:

* the Python standard library
* third-party packages (FastAPI, SQLAlchemy, PyJWT, etc.)
* ``backend.common.*`` — shared DTOs intentionally cross-cutting
* siblings within ``backend.auth_service.*``

Anything importing from ``backend.app.*`` is the regression we want to
catch early.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest


_AUTH_SERVICE = Path(__file__).resolve().parent.parent / "auth_service"


def _python_files() -> list[Path]:
    return sorted(p for p in _AUTH_SERVICE.rglob("*.py") if "__pycache__" not in p.parts)


def _imports_from_app(source: str) -> list[str]:
    """Return any forbidden imports found in *source*.

    We treat ``backend.app`` (and the bare ``app.*`` form, in case some
    code paths use relative-style absolute imports) as the forbidden root.
    """
    tree = ast.parse(source)
    bad: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if mod.startswith("backend.app") or mod == "backend.app":
                bad.append(f"from {mod} import ...")
            elif mod.startswith("app.") or mod == "app":
                bad.append(f"from {mod} import ...")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("backend.app") or alias.name.startswith("app."):
                    bad.append(f"import {alias.name}")
    return bad


@pytest.mark.parametrize("path", _python_files(), ids=lambda p: str(p.relative_to(_AUTH_SERVICE)))
def test_no_imports_from_backend_app(path: Path):
    src = path.read_text(encoding="utf-8")
    violations = _imports_from_app(src)
    assert not violations, (
        f"{path.relative_to(_AUTH_SERVICE)} pulls in app-side code: "
        f"{violations!r}. The auth service must stay self-contained so "
        f"it can be lifted into its own microservice."
    )

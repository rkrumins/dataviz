"""The aggregation service must not depend on the auth service.

``app/services/aggregation/__init__.py`` has always said so — "Zero
imports from the monolith's API, auth, middleware, or main.py layers",
with ``app/auth/`` listed under *Forbidden imports*. Nothing checked it,
and it was not true.

It broke in production. ``ontology/runtime.py`` does a function-local
``from backend.app.db.repositories.stats_repo import get_data_source_stats``
to dodge a circular import. Python still initialises the repositories
package to get there, and that package eagerly imported all twenty-one
repos — one of which imports ``auth_service.providers.assurance``, whose
package ``__init__`` imports ``oidc``, which imports the auth config,
which resolved ``JWT_SECRET_KEY`` at module scope and raised
``MissingSigningSecret``. The aggregation control plane, a process that
neither mints nor verifies a token, 500'd on every aggregation trigger
that resolved an ontology.

Two things made it invisible. The import was function-local, so it
happened on first use rather than at boot — no crashloop, no failed
readiness probe, just a runtime 500 on one endpoint. And the boundary
was a docstring.

These tests are the boundary, expressed as something that fails. They
also protect the stated goal of eventually extracting the auth service:
a build-time edge from the aggregation package to ``auth_service`` is
exactly the kind of coupling that makes extraction a rewrite instead of
a move.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest

_REPO_ROOT = __file__.rsplit("/backend/", 1)[0]


def _import_in_clean_process(source: str, *, env_secret: str | None) -> str:
    """Run *source* in a fresh interpreter and return its stdout.

    A subprocess, not an import in this one: pytest has already imported
    half the codebase, so ``sys.modules`` here proves nothing about what
    a given entry point pulls in on its own. The whole question is what
    a cold process loads.
    """
    env = {
        "PATH": "/usr/bin:/bin",
        "PYTHONPATH": _REPO_ROOT,
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if env_secret is not None:
        env["JWT_SECRET_KEY"] = env_secret
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(source)],
        capture_output=True, text=True, env=env, timeout=180,
    )
    if result.returncode != 0:
        pytest.fail(
            f"import failed (exit {result.returncode}):\n{result.stderr[-4000:]}"
        )
    return result.stdout.strip()


# Deliberately unindented: ``dedent`` cannot find a common prefix once a
# multi-line ``imports`` block is interpolated at one indent level while
# its continuation lines sit at another.
_REPORT_AUTH_MODULES = """
import sys
{imports}
loaded = sorted(m for m in sys.modules if m.startswith('backend.auth_service'))
print('\\n'.join(loaded))
"""


def test_the_aggregation_package_pulls_in_no_auth_service():
    """The boundary its own docstring claims."""
    out = _import_in_clean_process(
        _REPORT_AUTH_MODULES.format(
            imports="import backend.app.services.aggregation",
        ),
        env_secret="x" * 48,
    )
    assert out == "", (
        "the aggregation package imported auth_service modules:\n" + out
    )


def test_the_control_plane_pulls_in_no_auth_service():
    """The process from the traceback — its own entry point, cold."""
    out = _import_in_clean_process(
        _REPORT_AUTH_MODULES.format(
            imports="import backend.app.services.aggregation.controlplane",
        ),
        env_secret="x" * 48,
    )
    assert out == "", (
        "the aggregation control plane imported auth_service modules:\n" + out
    )


def test_the_ontology_resolution_path_pulls_in_no_auth_service():
    """The exact chain that failed, isolated.

    ``build_resolution_report`` -> ``load_introspected_type_ids`` ->
    ``stats_repo``. This is the edge that reached auth, so it is the one
    most worth pinning.
    """
    out = _import_in_clean_process(
        _REPORT_AUTH_MODULES.format(
            imports=(
                "import backend.app.ontology.runtime\n"
                "from backend.app.db.repositories.stats_repo import "
                "get_data_source_stats"
            ),
        ),
        env_secret="x" * 48,
    )
    assert out == "", (
        "the ontology resolution path imported auth_service modules:\n" + out
    )


def test_a_service_that_signs_nothing_needs_no_signing_secret():
    """The failure as the operator met it: no JWT_SECRET_KEY at all.

    Even if some future edge does reach auth_service, importing it must
    not require a signing key. Resolving the key ring at import made
    every module under ``auth_service`` unimportable without one; it now
    resolves on first use, and the processes that need it assert for it
    by name at startup.
    """
    out = _import_in_clean_process(
        """
        import backend.app.services.aggregation.controlplane
        from backend.app.db.repositories.stats_repo import get_data_source_stats
        import backend.auth_service.core.config as cfg
        import backend.auth_service.providers.assurance
        print('imported')
        """,
        env_secret=None,
    )
    assert out == "imported"


def test_the_key_ring_still_refuses_when_it_is_actually_needed():
    """Laziness must not become leniency.

    The point of the original import-time resolution was that a process
    signing tokens with no secret should never start. That guarantee is
    unchanged — it just belongs to ``assert_signing_secret()`` and to the
    first real use of a key, instead of to whoever imported the module.
    """
    out = _import_in_clean_process(
        """
        import backend.auth_service.core.config as cfg
        from backend.auth_service.core.config import MissingSigningSecret

        for label, call in (
            ('assert', cfg.assert_signing_secret),
            ('attribute', lambda: cfg.JWT_SECRET_KEY),
            ('ring', lambda: cfg.JWT_VERIFICATION_KEYS),
        ):
            try:
                call()
            except MissingSigningSecret:
                print(f'{label}:refused')
            else:
                print(f'{label}:ACCEPTED')
        """,
        env_secret=None,
    )
    assert out.splitlines() == [
        "assert:refused", "attribute:refused", "ring:refused",
    ]


def test_importing_one_repository_does_not_import_them_all():
    """The mechanism behind the outage, guarded directly.

    An eager package ``__init__`` means a dependency added to any one
    repository becomes a dependency of every caller of every other. That
    is what turned "the ontology needs data-source stats" into "the
    aggregation worker needs a JWT signing key".
    """
    out = _import_in_clean_process(
        """
        import sys
        from backend.app.db.repositories import workspace_repo
        loaded = [
            m for m in sys.modules
            if m.startswith('backend.app.db.repositories.')
        ]
        print(len(loaded))
        """,
        env_secret="x" * 48,
    )
    # workspace_repo itself, plus whatever it genuinely needs — nowhere
    # near the twenty-one the eager list imported.
    assert int(out) < 10, f"{out} repository modules loaded for one import"

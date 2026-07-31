"""A background worker must boot without the session signing secret.

``auth_service.core.config`` resolves ``JWT_SECRET_KEY`` at *import* time and
raises ``MissingSigningSecret`` when it is absent — deliberately, so an
API server can never come up in a state where it mints tokens with an
ephemeral key. The cost of that design is that the requirement travels
along every import edge: whatever imports ``auth_service.core.config``,
however indirectly, now needs the secret to start.

``stats-service`` and ``versioning-worker`` are pollers. They serve no HTTP
surface, verify no session cookie, and authenticate to the control plane
with a separate ``AGGREGATION_INTERNAL_TOKEN``. They have no business
holding the key that signs user sessions. But on 2026-07-31 both
crash-looped on ``MissingSigningSecret``, because a single module-level
import — ``app/db/repositories/idp_group_mapping_repo.py`` reaching for
``auth_service.providers.assurance`` — executed the provider package's
``__init__``, which eagerly imports every provider implementation and so
reached ``custom`` -> ``core.tokens`` -> ``core.config``. The fix was to
move that pure-policy module to ``backend/common/assurance.py``, the layer
``test_auth_service_isolation`` already names as the sanctioned
cross-cutting home.

The obvious response — hand the workers the secret in compose — would have
made the symptom go away while spreading the session signing key to two
processes that never sign a session. This test encodes the invariant
instead, and it is deliberately *behavioural* rather than an AST rule: what
breaks a worker is not any particular import line but the transitive
resolution of the secret, and only actually importing the module proves
that path is clear. A lazy, function-level ``auth_service`` import inside
these layers stays legal, which is what
``user_identity_repo``/``idp_health`` already rely on.

GOTCHA, and the reason for ``tmp_path`` and ``ENV=prod`` below: the same
config module auto-sources ``.env.dev``/``.env`` from the CURRENT WORKING
DIRECTORY when ``ENV`` is not production-looking. Run this from the repo
root with a ``.env`` present and the secret arrives by the back door, the
subprocess exits 0, and the test passes while the invariant is broken. Both
gates have to be shut for the check to mean anything.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


_REPO_ROOT = Path(__file__).resolve().parents[2]

# The shared chokepoints a poller drags in, plus the two real entrypoints.
# Both entrypoints are guarded by ``if __name__ == "__main__"``, so importing
# them here loads the module graph without starting a worker.
_WORKER_IMPORTS = [
    "backend.app.db.repositories",
    "backend.app.services.permission_service",
    "backend.app.services.view_access",
    "backend.app.services.versioning.__main__",
    "backend.insights_service.__main__",
]


def _import_without_secret(module: str, cwd: Path) -> subprocess.CompletedProcess:
    """Import *module* in a subprocess that has no signing secret at all.

    A subprocess is required: ``core.config`` resolves the secret once at
    module scope, so an in-process test would be answered by whatever the
    first import in this session already cached.
    """
    env = {k: v for k, v in os.environ.items() if k != "JWT_SECRET_KEY"}
    env["ENV"] = "prod"          # shuts the dotenv auto-load gate
    env["PYTHONPATH"] = str(_REPO_ROOT)
    return subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        cwd=cwd,                 # ...and no .env file to find anyway
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


@pytest.mark.parametrize("module", _WORKER_IMPORTS)
def test_worker_module_imports_without_jwt_secret(module: str, tmp_path: Path) -> None:
    result = _import_without_secret(module, tmp_path)
    assert result.returncode == 0, (
        f"`import {module}` fails without JWT_SECRET_KEY, so stats-service and "
        f"versioning-worker cannot boot without the session signing secret.\n\n"
        f"Something in this module's import graph now reaches "
        f"auth_service.core.config at module scope. Move the shared symbol to "
        f"backend/common/, or make the auth_service import function-level as "
        f"user_identity_repo and idp_health do. Do not fix this by giving the "
        f"workers the secret.\n\n{result.stderr[-2000:]}"
    )

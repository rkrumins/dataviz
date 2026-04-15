"""Gate PR reviews: the cross-domain JOIN count does not grow.

Enforcement layer for DOMAIN_OWNERSHIP.md. The lint at
[`backend/scripts/check_cross_domain_joins.py`](../scripts/check_cross_domain_joins.py)
walks every module under `backend/app` and flags `select(...).join(...)`
chains whose classes span more than one logical domain.

Current baseline: **12 pre-existing violations** (documented in
DOMAIN_OWNERSHIP.md § "Known cross-domain debt"). The test fails if
the count grows. When an existing violation is paid down, decrement
the baseline here in lockstep with the doc.

Why a pytest test rather than a separate CI step: keeps enforcement
on the existing `pytest` surface. The day the project adds GitHub
Actions / GitLab CI / whatever, it already runs `pytest` and this
test travels along with it.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


# Keep in sync with docs/check_cross_domain_joins.py output and with
# backend/app/db/DOMAIN_OWNERSHIP.md § "Known cross-domain debt".
BASELINE_VIOLATIONS = 12


def test_cross_domain_join_baseline_does_not_grow():
    """Run the lint with the documented baseline; assert it exits 0."""
    repo_root = Path(__file__).resolve().parents[2]  # backend/tests -> backend -> repo root
    script = repo_root / "backend" / "scripts" / "check_cross_domain_joins.py"
    assert script.exists(), f"Expected lint script at {script}"

    result = subprocess.run(
        [sys.executable, str(script), "--baseline", str(BASELINE_VIOLATIONS)],
        capture_output=True,
        text=True,
        check=False,
    )
    # Useful context if the assertion fails — pytest shows captured output.
    print("--- lint stdout ---")
    print(result.stdout)
    print("--- lint stderr ---")
    print(result.stderr)

    assert result.returncode == 0, (
        f"Cross-domain JOIN lint exceeded baseline of {BASELINE_VIOLATIONS}. "
        "Either fix the offending query (preferred) or, if the JOIN is "
        "justified, annotate the line with `# noqa: cross-domain`. Do NOT "
        "raise the baseline without documenting the new violation in "
        "backend/app/db/DOMAIN_OWNERSHIP.md."
    )

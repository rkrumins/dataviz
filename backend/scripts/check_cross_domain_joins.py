#!/usr/bin/env python3
"""Cross-domain JOIN lint (Phase 1.5 §1.5.1).

Walks the backend Python source tree and rejects SQLAlchemy queries
that join tables owned by different domains. Run in CI to keep the
domain boundary enforceable as the codebase grows; documented in
[backend/app/db/DOMAIN_OWNERSHIP.md](../app/db/DOMAIN_OWNERSHIP.md).

What "cross-domain join" means here:

    select(WorkspaceORM, OntologyORM)            # cross-domain — fail
        .join(OntologyORM, ...)

    select(ViewORM).join(ContextModelORM, ...)   # intra-visualization — pass

The lint is conservative — it only flags joins it is confident are
cross-domain. The repository layer can reach across by emitting an
explicit `# noqa: cross-domain` comment, used sparingly for the
unavoidable cases (auth flow reading user roles, etc.).

Mechanism: AST walk for `select(...).join(...)` chains, look up the
ORM class names against a static map mirroring DOMAIN_OWNERSHIP.md,
flag any join whose two ORM classes belong to different domains.

Modes:
    default      — print violations, exit 0 (informational; baseline mode)
    --strict     — print violations, exit 1 on any (CI gate, once debt is paid)
    --baseline N — exit 1 only if total violations exceed N (ratchet down)
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path
from typing import Iterator

# Mirrors backend/app/db/DOMAIN_OWNERSHIP.md. Update both together.
ORM_TO_DOMAIN: dict[str, str] = {
    # identity
    "UserORM": "identity",
    "UserRoleORM": "identity",
    "UserApprovalORM": "identity",
    "RevokedRefreshJtiORM": "identity",
    # workspace
    "WorkspaceORM": "workspace",
    "WorkspaceDataSourceORM": "workspace",
    "AssignmentRuleSetORM": "workspace",
    # provider
    "ProviderORM": "provider",
    "CatalogItemORM": "provider",
    # ontology
    "OntologyORM": "ontology",
    "OntologyAuditLogORM": "ontology",
    "OntologySourceMappingORM": "ontology",
    # visualization
    "ContextModelORM": "visualization",
    "ViewORM": "visualization",
    "ViewFavouriteORM": "visualization",
    # aggregation
    "AggregationJobORM": "aggregation",
    "DataSourcePollingConfigORM": "aggregation",
    # stats
    "DataSourceStatsORM": "stats",
    # platform
    "FeatureFlagsORM": "platform",
    "FeatureCategoryORM": "platform",
    "FeatureDefinitionORM": "platform",
    "FeatureRegistryMetaORM": "platform",
    "AnnouncementORM": "platform",
    "AnnouncementConfigORM": "platform",
    "ManagementDbConfigORM": "platform",
    "SchemaMigrationORM": "platform",
    # events
    "OutboxEventORM": "events",
    # legacy (deprecated)
    "GraphConnectionORM": "legacy",
}

NOQA_MARKER = "noqa: cross-domain"


def _iter_python_files(root: Path) -> Iterator[Path]:
    for p in root.rglob("*.py"):
        # Skip tests, scripts, alembic versions, generated, and __pycache__
        parts = set(p.parts)
        if "tests" in parts or "alembic" in parts or "__pycache__" in parts:
            continue
        if p.name.startswith("test_"):
            continue
        yield p


def _orm_classes_in_call(node: ast.AST) -> list[str]:
    """Return every ORM class name (matching ORM_TO_DOMAIN keys) that
    appears as an `ast.Name` directly in a select(...) / join(...) call."""
    found: list[str] = []
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and child.id in ORM_TO_DOMAIN:
            found.append(child.id)
    return found


def _is_select_join_chain(node: ast.AST) -> bool:
    """Match `<expr>.join(...)` calls — the typical SQLAlchemy 2.0 idiom."""
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in {"join", "outerjoin", "select_from"}
    )


def _line_has_noqa(source_lines: list[str], lineno: int) -> bool:
    """Whether the (1-indexed) source line contains the noqa marker."""
    if 1 <= lineno <= len(source_lines):
        return NOQA_MARKER in source_lines[lineno - 1]
    return False


def check_file(path: Path) -> list[str]:
    """Return one violation message per cross-domain join found."""
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    if "ORM" not in source:  # cheap pre-filter
        return []
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError:
        return []

    source_lines = source.splitlines()
    violations: list[str] = []

    for node in ast.walk(tree):
        if not _is_select_join_chain(node):
            continue
        # Collect ORMs from the join() call AND the receiver chain
        all_orms = set(_orm_classes_in_call(node))
        if len(all_orms) < 2:
            continue
        domains = {ORM_TO_DOMAIN[name] for name in all_orms}
        if len(domains) <= 1:
            continue
        if _line_has_noqa(source_lines, node.lineno):
            continue
        violations.append(
            f"{path}:{node.lineno}: cross-domain JOIN — domains {sorted(domains)} "
            f"via classes {sorted(all_orms)}. Use the owning domain's API or an "
            f"outbox-driven projection. Add `# {NOQA_MARKER}` if intentional."
        )
    return violations


def _parse_args(argv: list[str]) -> tuple[bool, int | None]:
    """Return (strict, baseline). strict=True means fail on any violation;
    baseline=N means fail only when violation count exceeds N."""
    strict = False
    baseline: int | None = None
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == "--strict":
            strict = True
        elif arg == "--baseline":
            i += 1
            if i >= len(argv) or not argv[i].isdigit():
                print("--baseline requires an integer N", file=sys.stderr)
                sys.exit(2)
            baseline = int(argv[i])
        elif arg in {"-h", "--help"}:
            print(__doc__)
            sys.exit(0)
        else:
            print(f"Unknown arg: {arg!r}", file=sys.stderr)
            sys.exit(2)
        i += 1
    return strict, baseline


def main(argv: list[str] | None = None) -> int:
    strict, baseline = _parse_args(argv if argv is not None else sys.argv)

    here = Path(__file__).resolve().parent  # backend/scripts
    backend_app = here.parent / "app"        # backend/app
    if not backend_app.exists():
        print(f"check_cross_domain_joins: {backend_app} not found", file=sys.stderr)
        return 2

    total = 0
    for py_file in _iter_python_files(backend_app):
        for violation in check_file(py_file):
            print(violation)
            total += 1

    if total == 0:
        print("OK — no cross-domain JOINs detected.")
        return 0

    print(f"\n{total} cross-domain JOIN violation(s) found.", file=sys.stderr)
    if strict:
        return 1
    if baseline is not None:
        if total > baseline:
            print(
                f"FAIL: violations ({total}) exceed baseline ({baseline}). "
                f"Either fix the new ones or update the baseline.",
                file=sys.stderr,
            )
            return 1
        print(
            f"OK — within baseline of {baseline} (current: {total}). "
            f"Fix the existing ones to ratchet the baseline down.",
            file=sys.stderr,
        )
        return 0
    print(
        "(informational — pass --strict to fail CI on any violation, "
        "or --baseline N to ratchet the count down over time.)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

"""Export the SearchQuery JSON Schema to a versioned artifact on disk.

This is the build-time side of the JSON-DSL-as-source-of-truth contract.
The runtime side is ``GET /search/schema`` in
``backend/app/api/v1/endpoints/graph.py``; both compute the same schema
from the same Pydantic model.

Output layout (under ``--out-dir``)::

    searchquery.v{N}.json    — pretty-printed for diff / human review
    searchquery.v{N}.min.json — minified (stable key order) for codegen

A separate npm-publish step (run from CI) consumes the .json file via
``json-schema-to-typescript`` to produce ``@synodic/search-schema``'s
TypeScript declarations.

Usage::

    python -m backend.scripts.export_search_schema
    python -m backend.scripts.export_search_schema --out-dir frontend/src/types/generated
    python -m backend.scripts.export_search_schema --check  # CI: fail if drift

``--check`` reads any existing ``searchquery.v{N}.min.json`` under the
out-dir and exits non-zero if the freshly-generated schema differs from
it. Wire this into pre-commit / CI so anyone who edits a predicate
model is forced to regenerate the committed artifact.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from backend.common.models.search import (
    SCHEMA_VERSION,
    SearchApiContract,
    SearchQuery,
)


# Default destination — sits inside backend/common/ so the artifact
# travels with the API contract (and is reviewable in diffs). The
# FE codegen step reads from here at build time; the CI npm-publish
# step (separate, deferred) reads from the same place.
DEFAULT_OUT_DIR = Path("backend/common/schema")


def build_schema() -> dict:
    """Compute the canonical Search API JSON Schema.

    Uses ``SearchApiContract`` (the bundle root) so a single schema
    document describes every API-surface shape — request body
    (``SearchQuery``) plus every response shape. The runtime
    ``GET /search/schema`` endpoint serves the narrower
    ``SearchQuery``-only schema (clients only validate what they
    send); the bundled artifact powers FE codegen and external SDKs.

    ``by_alias=True`` so the wire-format field names (e.g.
    ``$schemaVersion``, ``viewId``, ``rootUrns``) appear in the schema —
    those are the names the FE and AI agents see on the wire.
    """
    return SearchApiContract.model_json_schema(by_alias=True)


def build_request_schema() -> dict:
    """Compute the narrower request-only schema used by ``/search/schema``."""
    return SearchQuery.model_json_schema(by_alias=True)


def canonical_json(schema: dict, *, indent: int | None = None) -> str:
    """Serialise the schema with stable key ordering.

    Stable ordering matters because the ``--check`` mode compares
    byte-for-byte against a committed artifact; without sorted keys
    every Python release that re-orders dict iteration would produce
    spurious diffs.
    """
    return json.dumps(schema, sort_keys=True, indent=indent, separators=(",", ":") if indent is None else (",", ": "))


def write_artifact(out_dir: Path, schema: dict) -> tuple[Path, Path]:
    """Write the pretty and minified artifacts; return both paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    pretty_path = out_dir / f"searchquery.v{SCHEMA_VERSION}.json"
    min_path = out_dir / f"searchquery.v{SCHEMA_VERSION}.min.json"
    pretty_path.write_text(canonical_json(schema, indent=2) + "\n", encoding="utf-8")
    min_path.write_text(canonical_json(schema), encoding="utf-8")
    return pretty_path, min_path


def check_drift(out_dir: Path, schema: dict) -> int:
    """Return 0 if the on-disk minified artifact matches; 1 otherwise.

    Used in CI / pre-commit. The minified file is the source of truth
    for drift; the pretty file is for humans.
    """
    min_path = out_dir / f"searchquery.v{SCHEMA_VERSION}.min.json"
    if not min_path.exists():
        print(
            f"[export_search_schema] missing committed artifact: {min_path}\n"
            f"                       run without --check to generate it.",
            file=sys.stderr,
        )
        return 1
    on_disk = min_path.read_text(encoding="utf-8")
    fresh = canonical_json(schema)
    if on_disk == fresh:
        return 0
    print(
        f"[export_search_schema] DRIFT detected against {min_path}\n"
        f"                       run `python -m backend.scripts.export_search_schema`\n"
        f"                       to regenerate, then commit the updated artifact.",
        file=sys.stderr,
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export SearchQuery JSON Schema as a versioned artifact.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=f"Where to write the schema files (default: {DEFAULT_OUT_DIR}).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Compare against the committed artifact; exit non-zero on drift.",
    )
    args = parser.parse_args()

    schema = build_schema()

    if args.check:
        return check_drift(args.out_dir, schema)

    pretty, mini = write_artifact(args.out_dir, schema)
    print(f"[export_search_schema] v{SCHEMA_VERSION} -> {pretty}")
    print(f"[export_search_schema] v{SCHEMA_VERSION} -> {mini}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

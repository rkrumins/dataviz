"""Write the JSON Schema of the import/export record format (``import-record.v1.json``).

A connector writes these records, one per node or edge, as NDJSON lines or JSON objects (a CSV,
TSV or Excel row carries the same columns as text). Their source of truth is the contract the
import reads them by, ``backend.app.services.versioning.import_export.contract``; this renders
it, so the published schema describes what an import reads: ``tests/test_import_record_schema.py``
fails when the committed file is out of date. ``GET …/imports/schema`` serves the same schema
narrowed to one data source's types and properties.

Usage::

    python -m backend.scripts.export_import_schema          # rewrite the committed file
    python -m backend.scripts.export_import_schema --check  # exit 1 if it is out of date
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from backend.app.services.versioning.import_export.contract import FORMAT_VERSION, json_schema

SCHEMA_PATH = (Path(__file__).resolve().parents[1] / "common" / "schema"
               / f"import-record.v{FORMAT_VERSION}.json")


def render() -> str:
    return json.dumps(json_schema(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if the committed schema is out of date")
    args = parser.parse_args(argv)
    fresh = render()
    if args.check:
        current = SCHEMA_PATH.read_text(encoding="utf-8") if SCHEMA_PATH.exists() else ""
        if current != fresh:
            print(f"{SCHEMA_PATH} is out of date: run python -m backend.scripts.export_import_schema",
                  file=sys.stderr)
            return 1
        return 0
    SCHEMA_PATH.write_text(fresh, encoding="utf-8")
    print(f"wrote {SCHEMA_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

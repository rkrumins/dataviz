"""Write the JSON Schema of the View Bundle file format (``*.view.json``).

The format's source of truth is the model the importer parses files with
(``backend.common.models.view_transfer.ViewBundle``). This renders that model, so the published
schema can't describe a file the importer would refuse, or the other way round:
``tests/test_view_bundle_schema.py`` fails when the committed file is out of date.

A view's ``definition`` stays an open object here on purpose. It is the view's own
configuration, carried verbatim (unknown keys included), and only its hash is checked; the
format spec (``docs/features/view-portability.md``) describes the keys the importer reads.

Usage::

    python -m backend.scripts.export_view_bundle_schema          # rewrite the committed file
    python -m backend.scripts.export_view_bundle_schema --check  # exit 1 if it is out of date
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from backend.common.models.view_transfer import BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, ViewBundle

SCHEMA_PATH = (Path(__file__).resolve().parents[2] / "docs" / "features"
               / f"view-bundle.v{BUNDLE_FORMAT_VERSION}.schema.json")


def build_schema() -> dict:
    schema = ViewBundle.model_json_schema()
    properties = dict(schema["properties"])
    # The model takes any value so the parser can say WHY a file isn't a bundle it reads; a file
    # of this version has exactly these.
    properties["format"] = {"const": BUNDLE_FORMAT, "title": "Format"}
    properties["formatVersion"] = {"const": BUNDLE_FORMAT_VERSION, "title": "Formatversion"}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **schema,
        "title": f"View Bundle v{BUNDLE_FORMAT_VERSION}",
        "description": (
            "One or more views exported from an environment, to import into another where the "
            "same data source is onboarded. Each view's definition is hashed (definitionHash); "
            "bundleHash covers the ordered (portableId, definitionHash) pairs. Keys this schema "
            "doesn't list are ignored by the importer. See docs/features/view-portability.md."
        ),
        "properties": properties,
    }


def render() -> str:
    return json.dumps(build_schema(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if the committed schema is out of date")
    args = parser.parse_args(argv)
    fresh = render()
    if args.check:
        current = SCHEMA_PATH.read_text(encoding="utf-8") if SCHEMA_PATH.exists() else ""
        if current != fresh:
            print(f"{SCHEMA_PATH} is out of date: run python -m backend.scripts.export_view_bundle_schema",
                  file=sys.stderr)
            return 1
        return 0
    SCHEMA_PATH.write_text(fresh, encoding="utf-8")
    print(f"wrote {SCHEMA_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Write the JSON Schema of the view library pack format (``*.library.json``).

A pack carries a view's display rules and saved queries to another view. Its source of truth is
the model the import endpoint parses it with (``backend.common.models.view_library.LibraryPack``)
and the models each item is then checked against (``DisplayRule``, ``SavedQueryInput`` and the
search ``Predicate``). This renders those models, so the published schema describes what an
import reads: ``tests/test_view_library_schema.py`` fails when the committed file is out of date.

Usage::

    python -m backend.scripts.export_view_library_schema          # rewrite the committed file
    python -m backend.scripts.export_view_library_schema --check  # exit 1 if it is out of date
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydantic import TypeAdapter

from backend.common.models.search import Predicate
from backend.common.models.view_library import (
    PACK_FORMAT,
    PACK_VERSION,
    DisplayRule,
    LibraryPack,
    SavedQueryInput,
)

SCHEMA_PATH = (Path(__file__).resolve().parents[1] / "common" / "schema"
               / f"view-library.v{PACK_VERSION}.json")


def build_schema() -> dict:
    schema = LibraryPack.model_json_schema()
    predicate = TypeAdapter(Predicate).json_schema()
    defs = {**schema.get("$defs", {}), **predicate.pop("$defs", {}), "Predicate": predicate}

    # The pack keeps its items as open objects so one bad item is refused on its own; these are
    # what each item is checked against. A rule's id is optional: every item imported gets a new one.
    rule = DisplayRule.model_json_schema()
    rule["properties"]["predicate"] = {"$ref": "#/$defs/Predicate"}
    rule["required"] = [key for key in rule["required"] if key != "id"]
    query = SavedQueryInput.model_json_schema()
    query["title"] = "SavedQuery"
    query["properties"] = {
        "id": {"type": "string", "title": "Id",
               "description": "Written by an export; an import gives the query a new id."},
        **query["properties"],
        "predicate": {"$ref": "#/$defs/Predicate"},
    }
    defs["DisplayRule"] = rule
    defs["SavedQuery"] = query

    properties = dict(schema["properties"])
    # The model defaults both; a file of this version names them.
    properties["format"] = {"const": PACK_FORMAT, "title": "Format"}
    properties["version"] = {"const": PACK_VERSION, "title": "Version"}
    properties["displayRules"] = {**properties["displayRules"], "items": {"$ref": "#/$defs/DisplayRule"}}
    properties["savedQueries"] = {**properties["savedQueries"], "items": {"$ref": "#/$defs/SavedQuery"}}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **schema,
        "$defs": defs,
        "title": f"View Library Pack v{PACK_VERSION}",
        "description": (
            "A view's display rules and saved queries, exported to be imported into another view "
            "(POST /api/v1/views/{view_id}/library/import). Each item is checked as it is when "
            "saved; one that fails is refused and the rest still import. Keys this schema doesn't "
            "list are ignored. See docs/features/search-and-rules-reference.md."
        ),
        "properties": properties,
        "required": ["format", "version"],
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
            print(f"{SCHEMA_PATH} is out of date: run python -m backend.scripts.export_view_library_schema",
                  file=sys.stderr)
            return 1
        return 0
    SCHEMA_PATH.write_text(fresh, encoding="utf-8")
    print(f"wrote {SCHEMA_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

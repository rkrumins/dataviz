"""The published record format is the import's own contract, rendered: the committed schema must
match it, every record an export writes must pass it, and a data source's schema narrows it to
that source's types and properties."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from backend.app.services.versioning.import_export import contract
from backend.app.services.versioning.import_export.rowmodel import denormalize_edge, denormalize_node
from backend.scripts.export_import_schema import SCHEMA_PATH, main, render

ONTOLOGY = {
    "node_types": ["Table", "Column"], "edge_types": ["CONTAINS", "FLOWS_TO"],
    "fields": {"Table": [{"id": "owner", "name": "Owner", "type": "text", "required": True},
                         {"id": "rows", "name": "Row count", "type": "number"}],
               "Column": [{"id": "pii", "name": "PII", "type": "boolean"}]},
    "edge_ends": {"CONTAINS": {"source": ["Table"], "target": ["Column"]}},
}


def test_the_committed_schema_is_current():
    assert SCHEMA_PATH.read_text(encoding="utf-8") == render(), \
        "run: python -m backend.scripts.export_import_schema"
    assert main(["--check"]) == 0


def test_the_schema_is_the_same_whatever_the_process_imported_first():
    """typing hands a union back in the member order of an equal one created earlier, in any
    module (a library's too). A process that wrote ``Optional[Union[str, List[str]]]`` first reads
    the contract's ``tags: Optional[Union[List[str], str]]`` the other way round, and the full
    suite did: the schema must not change with it."""
    code = ("from typing import List, Optional, Union\n"
            "Optional[Union[str, List[str]]]\n"
            "import sys\n"
            "from backend.scripts.export_import_schema import render\n"
            "sys.stdout.write(render())\n")
    out = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[2],
                         capture_output=True, text=True, check=True,
                         env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}).stdout
    assert out == SCHEMA_PATH.read_text(encoding="utf-8")


def test_every_record_an_export_writes_passes_the_contract():
    node = denormalize_node("urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f70", "h1", {
        "urn": "urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f70", "entityType": "Table",
        "displayName": "orders", "qualifiedName": "sales.orders", "tags": ["pii", "gold"],
        "properties": {"owner": "team", "rows": 12, "nested": {"a": 1}, "flags": [1, 2]}})
    edge = denormalize_edge("urn:uuid:0192f5a4-7b3c-7d2e-8f1a-2b3c4d5e6f71", "h2", {
        "edgeType": "FLOWS_TO", "sourceEntityId": "a", "targetEntityId": "b", "confidence": 0.9,
        "properties": {"via": "etl"}}, source_qname="a", target_qname="b", source_urn="urn:a",
        target_urn="urn:b")
    for record in ({**node, "kind": "node"}, {**edge, "kind": "edge"}):
        contract.validate_record(record)
    assert contract.unknown_columns([node, edge]) == []


def test_a_column_the_contract_doesnt_name_is_refused_and_reported():
    with pytest.raises(ValueError, match="prop_owner"):
        contract.validate_record({"kind": "node", "urn": "u", "prop_owner": "team"})
    with pytest.raises(ValueError, match="source.key"):
        contract.validate_record({"kind": "node", "source.key": "x"})       # an edge's only
    contract.validate_record({"kind": "edge", "edgeType": "E", "source.sap_id": "S-1"})
    assert contract.unknown_columns([{"kind": "node", "prop_owner": 1, "urn": "u"}]) == ["prop_owner"]


def test_a_data_sources_schema_names_its_types_and_types_its_properties():
    generic = contract.json_schema()
    assert generic["$id"].endswith("import-record.v1.json") and generic["x-format-version"] == 1
    assert generic["discriminator"]["propertyName"] == "kind"
    node = generic["$defs"]["ImportNodeRecord"]
    assert node["additionalProperties"] is False and "^prop\\.[^.].*$" in node["patternProperties"]

    narrowed = contract.json_schema(ONTOLOGY)
    node, edge = narrowed["$defs"]["ImportNodeRecord"], narrowed["$defs"]["ImportEdgeRecord"]
    assert {"enum": ["Column", "Table"]} in node["properties"]["entityType"]["anyOf"]
    assert edge["properties"]["edgeType"]["enum"] == ["CONTAINS", "FLOWS_TO"]
    rows = node["properties"]["prop.rows"]
    assert len(rows["anyOf"]) == 2 and {"type": "number"} in rows["anyOf"] \
        and {"const": "\\N"} in rows["anyOf"], "a number, or removed"
    assert "required for a new Table" in node["properties"]["prop.owner"]["description"]
    assert {"type": "boolean"} in node["properties"]["prop.pii"]["anyOf"]

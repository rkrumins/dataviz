"""The published JSON Schema of the view library pack is the import's own models, rendered: the
committed file must match them, and it must describe everything a real export writes."""
from __future__ import annotations

import json

from httpx import AsyncClient

from backend.scripts.export_view_library_schema import SCHEMA_PATH, main, render
from backend.tests.test_view_library import _query, _rule, _view


def test_the_committed_schema_is_current():
    assert SCHEMA_PATH.read_text(encoding="utf-8") == render(), \
        "run: python -m backend.scripts.export_view_library_schema"
    assert main(["--check"]) == 0


async def test_the_schema_describes_everything_an_export_writes(test_client: AsyncClient):
    """Every key an exported pack carries is one the schema knows, and every key the schema
    requires is there."""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    defs = schema["$defs"]
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library"
    assert (await test_client.put(f"{base}/rules/r1", json=_rule("r1", "PII", icon="Tag"))).status_code == 200
    assert (await test_client.put(f"{base}/queries/q1",
                                  json=_query("Tables", description="Every table"))).status_code == 200
    pack = (await test_client.get(f"{base}/export")).json()

    def check(value: dict, node: dict, where: str) -> None:
        assert set(value) <= set(node["properties"]), f"{where}: {set(value) - set(node['properties'])}"
        assert set(node.get("required", [])) <= set(value), f"{where} lacks {set(node['required']) - set(value)}"

    check(pack, schema, "pack")
    check(pack["source"], defs["LibraryPackSource"], "source")
    [rule] = pack["displayRules"]
    check(rule, defs["DisplayRule"], "rule")
    [query] = pack["savedQueries"]
    check(query, defs["SavedQuery"], "query")
    assert (pack["format"], pack["version"]) == \
        (schema["properties"]["format"]["const"], schema["properties"]["version"]["const"])

"""The published JSON Schema of the View Bundle format is the importer's own model, rendered: the
committed file must match it, and it must describe everything a real export writes."""
from __future__ import annotations

import json

from backend.scripts.export_view_bundle_schema import SCHEMA_PATH, main, render
from backend.tests.test_view_transfer_import import _export, _view, _workspace, graph  # noqa: F401 — graph is a fixture


def test_the_committed_schema_is_current():
    assert SCHEMA_PATH.read_text(encoding="utf-8") == render(), \
        "run: python -m backend.scripts.export_view_bundle_schema"
    assert main(["--check"]) == 0


async def test_the_schema_describes_everything_an_export_writes(test_client, graph):
    """Every key an exported file carries is one the schema (and so the importer) knows, and
    every key the schema requires is there: a key only the exporter knew would be dropped on
    import without a word."""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    defs = schema["$defs"]
    dev = await _workspace(test_client, "Dev")
    bundle = json.loads(await _export(test_client, await _view(test_client, dev)))

    def check(value: dict, node: dict, where: str) -> None:
        assert set(value) <= set(node["properties"]), f"{where}: {set(value) - set(node['properties'])}"
        assert set(node.get("required", [])) <= set(value), f"{where} lacks {set(node['required']) - set(value)}"

    check(bundle, schema, "bundle")
    [view] = bundle["views"]
    check(view, defs["BundleView"], "view")
    check(view["metadata"], defs["ViewMetadata"], "metadata")
    check(view["manifest"], defs["Manifest"], "manifest")
    for entry in view["history"]:
        check(entry, defs["HistoryEntry"], "history entry")
    for source in bundle["sources"].values():
        check(source, defs["SourceDescriptor"], "source")
        check(source["dataSource"], defs["DataSourceRef"], "source data source")
    assert (bundle["format"], bundle["formatVersion"]) == \
        (schema["properties"]["format"]["const"], schema["properties"]["formatVersion"]["const"])

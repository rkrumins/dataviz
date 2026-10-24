"""A native query's values, the same shape from either engine, and never
bigger than a fixed size however big the value.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone

from dateutil.relativedelta import relativedelta
from falkordb import Edge as FalkorEdge
from falkordb import Node as FalkorNode
from falkordb import Path as FalkorPath
from neo4j.graph import Graph, Node as Neo4jNode, Path as Neo4jPath
from neo4j.spatial import CartesianPoint
from neo4j.time import Date, DateTime, Duration

from backend.app.services.native_query.cells import MAX_DEPTH, MAX_ITEMS, MAX_STEPS, MAX_TEXT, to_cell


def neo4j_pair():
    graph = Graph()
    a = Neo4jNode(graph, "4:db:1", 1, ["Dataset"], {"urn": "urn:a", "displayName": "Orders"})
    b = Neo4jNode(graph, "4:db:2", 2, ["Table"], {"urn": "urn:b", "name": "orders_raw"})
    rel = graph.relationship_type("TRANSFORMS")(
        graph, "5:db:9", 9, {"properties": '{"logic": "direct"}', "confidence": 0.9})
    rel._start_node, rel._end_node = a, b
    return a, b, rel


def test_scalars_stay_themselves():
    for value in (None, True, False, 0, -12, 3.5, "orders", ""):
        assert to_cell(value) == value


def test_what_json_or_javascript_cannot_hold_becomes_text():
    assert to_cell(2 ** 60) == {"kind": "number", "text": str(2 ** 60)}
    assert to_cell(2 ** 53 - 1) == 2 ** 53 - 1
    assert to_cell(math.nan) == {"kind": "number", "text": "NaN"}
    assert to_cell(-math.inf) == {"kind": "number", "text": "-Infinity"}
    json.dumps(to_cell([math.inf, 2 ** 64]), allow_nan=False)


def test_long_text_is_cut_and_says_how_long_it_was():
    cell = to_cell("x" * (MAX_TEXT + 5))
    assert cell == {"kind": "string", "text": "x" * MAX_TEXT, "length": MAX_TEXT + 5, "truncated": True}


def test_a_node_reads_the_same_from_either_engine():
    falkor = to_cell(FalkorNode(node_id=1, labels=["Dataset"],
                                properties={"urn": "urn:a", "displayName": "Orders"}))
    neo4j = to_cell(neo4j_pair()[0])
    for cell, node_id in ((falkor, "1"), (neo4j, "4:db:1")):
        assert cell == {
            "kind": "node", "id": node_id, "labels": ["Dataset"], "urn": "urn:a",
            "displayName": "Orders", "properties": {"urn": "urn:a", "displayName": "Orders"},
        }


def test_a_node_without_a_display_name_falls_back_to_its_name():
    assert to_cell(neo4j_pair()[1])["displayName"] == "orders_raw"
    assert to_cell(FalkorNode(node_id=3, properties={}))["displayName"] is None


def test_an_edge_names_its_ends_and_reads_its_properties_blob():
    falkor = to_cell(FalkorEdge(1, "TRANSFORMS", 2, edge_id=9,
                                properties={"properties": '{"logic": "direct"}', "confidence": 0.9}))
    neo4j = to_cell(neo4j_pair()[2])
    for cell, ids in ((falkor, ("9", "1", "2")), (neo4j, ("5:db:9", "4:db:1", "4:db:2"))):
        assert cell == {
            "kind": "edge", "id": ids[0], "type": "TRANSFORMS", "start": ids[1], "end": ids[2],
            "properties": {
                "properties": {"kind": "map", "entries": {"logic": "direct"}},
                "confidence": 0.9,
            },
        }


def test_a_properties_value_that_is_not_json_stays_text():
    cell = to_cell(FalkorEdge(1, "R", 2, edge_id=1, properties={"properties": "{not json"}))
    assert cell["properties"] == {"properties": "{not json"}


def test_a_path_reads_the_same_from_either_engine():
    a, b, rel = neo4j_pair()
    neo4j = to_cell(Neo4jPath(a, rel))
    assert [n["id"] for n in neo4j["nodes"]] == ["4:db:1", "4:db:2"]
    assert [e["id"] for e in neo4j["edges"]] == ["5:db:9"]
    fa, fb = FalkorNode(node_id=1), FalkorNode(node_id=2)
    falkor = to_cell(FalkorPath([fa, fb], [FalkorEdge(fa, "R", fb, edge_id=7)]))
    assert falkor["kind"] == "path"
    assert [n["id"] for n in falkor["nodes"]] == ["1", "2"]
    assert falkor["edges"][0]["start"] == "1" and falkor["edges"][0]["end"] == "2"


def test_a_long_path_is_cut_at_its_step_limit():
    nodes = [FalkorNode(node_id=i) for i in range(MAX_STEPS + 6)]
    edges = [FalkorEdge(i, "R", i + 1, edge_id=i) for i in range(MAX_STEPS + 5)]
    cell = to_cell(FalkorPath(nodes, edges))
    assert len(cell["edges"]) == MAX_STEPS and len(cell["nodes"]) == MAX_STEPS + 1
    assert cell["truncated"] is True and cell["size"] == MAX_STEPS + 5


def test_lists_and_maps_are_cut_at_their_item_limit():
    big_list = to_cell(list(range(MAX_ITEMS + 3)))
    assert big_list["items"] == list(range(MAX_ITEMS))
    assert big_list["truncated"] is True and big_list["size"] == MAX_ITEMS + 3
    big_map = to_cell({f"k{i}": i for i in range(MAX_ITEMS + 1)})
    assert len(big_map["entries"]) == MAX_ITEMS and big_map["truncated"] is True
    node = to_cell(FalkorNode(node_id=1, properties={f"p{i}": i for i in range(MAX_ITEMS + 1)}))
    assert len(node["properties"]) == MAX_ITEMS and node["truncated"] is True
    assert to_cell([1, 2]) == {"kind": "list", "items": [1, 2]}


def test_nesting_stops_at_its_depth_limit():
    value = 1
    for _ in range(MAX_DEPTH + 2):
        value = [value]
    cell, depth = to_cell(value), 0
    while isinstance(cell, dict) and cell.get("kind") == "list":
        cell, depth = cell["items"][0], depth + 1
    assert depth == MAX_DEPTH and cell == {"kind": "truncated"}


def test_temporal_values_read_as_iso_text():
    assert to_cell(Date(2024, 1, 2)) == {"kind": "temporal", "type": "date", "text": "2024-01-02"}
    assert to_cell(Duration(days=1, hours=2)) == {"kind": "temporal", "type": "duration", "text": "P1DT2H"}
    assert to_cell(DateTime(2024, 1, 2, 3, 4, 5))["type"] == "datetime"
    # FalkorDB's client hands back Python's own, and dateutil for durations.
    assert to_cell(date(2024, 1, 2)) == {"kind": "temporal", "type": "date", "text": "2024-01-02"}
    moment = datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    assert to_cell(moment)["text"] == "2024-01-02T03:04:05+00:00"
    assert to_cell(relativedelta(days=2, hours=3))["text"] == "P2DT3H"
    assert to_cell(relativedelta())["text"] == "PT0S"


def test_points_and_bytes():
    assert to_cell(CartesianPoint((1.0, 2.0))) == {"kind": "point", "srid": 7203, "coordinates": [1.0, 2.0]}
    assert to_cell(b"\x00\x01\x02") == {"kind": "bytes", "length": 3}


def test_every_cell_is_json():
    a, _, rel = neo4j_pair()
    json.dumps([to_cell(a), to_cell(rel), to_cell(Neo4jPath(a, rel)), to_cell({"x": [1, "y"]})],
               allow_nan=False)

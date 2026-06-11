"""Node property hygiene: denormalised internal fields must never read back as user properties.

The FalkorDB projector and the live provider SET denormalised fields directly on a node
(`entityId`, `searchableText`, `displayName`, `childCount`, …). On read, `_node_from_props` treats
any attribute NOT in `_RESERVED_NODE_KEYS` as a user property — so an unreserved write-field leaks
into the canvas Properties panel. This regression hit every node a post-merge full re-seed rewrote
(`entityId` = raw urn, `searchableText` = "<displayName> <qualifiedName> …" — the doubled name).

These are pure-function tests (no infra): they round-trip a payload through the projector's
`_node_item` write → FalkorDB SET semantics → `_node_from_props` read, and assert the reserved set
covers every direct write-field.
"""
from backend.app.providers.falkordb_provider import _RESERVED_NODE_KEYS, _node_from_props
from backend.app.services.versioning.projection import _node_item


def _apply_node_set(item: dict) -> dict:
    """Reproduce `_node_merge_cypher`'s SET/REMOVE → the stored FalkorDB node attribute map."""
    props = {"urn": item["urn"]}                                  # MERGE key
    for k in ("entityId", "displayName", "qualifiedName", "description", "tags",
              "layerAssignment", "childCount", "sourceSystem", "lastSyncedAt",
              "propertiesRaw", "searchableText"):
        props[k] = item[k]
    props.update(item["nativeProps"])                             # n += item.nativeProps
    props.pop("properties", None)                                 # REMOVE n.properties
    return props


def test_projected_node_reads_back_clean_properties():
    # displayName == qualifiedName (common for datasets) makes searchableText a doubled string.
    payload = {
        "urn": "urn:li:dataset:int_clean_gl_postings_t2_7bf2d652",
        "entityType": "dataset",
        "displayName": "int_clean_gl_postings_t2",
        "qualifiedName": "int_clean_gl_postings_t2",
        "properties": {"owner": "team-finance", "rows": 42},
        "childCount": 13,
    }
    item = _node_item(payload["urn"], payload["urn"], payload)
    node = _node_from_props(_apply_node_set(item))

    assert node.display_name == "int_clean_gl_postings_t2"        # name intact
    assert node.properties == {"owner": "team-finance", "rows": 42}  # ONLY the real user props
    assert "searchableText" not in node.properties                # the doubled-name leak — gone
    assert "entityId" not in node.properties                      # the raw-urn leak — gone


def test_reserved_set_covers_every_denormalised_write_field():
    """Every field the projector SETs directly on a node (i.e. not the user-property carriers
    `nativeProps`/`propertiesRaw`) must be reserved, so a future denormalised field can't silently
    start leaking into the Properties panel."""
    item = _node_item("urn:x", "urn:x", {"displayName": "X", "entityType": "dataset",
                                          "properties": {"a": 1}})
    direct_write_fields = set(item.keys()) - {"nativeProps", "propertiesRaw"}
    unreserved = direct_write_fields - _RESERVED_NODE_KEYS
    assert not unreserved, f"projector writes unreserved node attrs (they will leak on read): {unreserved}"


if __name__ == "__main__":
    test_projected_node_reads_back_clean_properties()
    test_reserved_set_covers_every_denormalised_write_field()
    print("node property hygiene: OK")

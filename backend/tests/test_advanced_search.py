"""
Unit tests for the advanced-search v1 building blocks.

These tests are pure — no FalkorDB or Redis dependency. They verify
the contract surface (model construction + discriminated union),
the predicate-tree validator caps in :mod:`AdvancedSearchService`,
the Cypher visitor's WHERE fragments + parameter binding, the
DescendantOf hoisting + scope intersection, and the cursor codec.

Integration tests against a live FalkorDB live in a separate file and
are skipped where the graph module isn't loaded — see the same pattern
in test_falkordb_native_properties.py.
"""
import pytest

from backend.app.providers.falkordb_deep_search import (
    CANDIDATE_CAP,
    CompileError,
    _Compiler,
    _build_candidate_cypher,
    _effective_root_urns,
    decode_cursor,
    encode_cursor,
    query_hash,
)
from backend.app.services.advanced_search_service import (
    MAX_LEAF_COUNT,
    MAX_OR_BRANCH,
    MAX_TREE_DEPTH,
    ValidationError,
    _count_and_validate,
)
from backend.common.models.search import (
    AggregationSpec,
    DescendantOfPredicate,
    EntityTypePredicate,
    GroupPredicate,
    HasPropertyPredicate,
    LayerPredicate,
    PropertyPredicate,
    SearchOptions,
    SearchQuery,
    SearchScope,
    TagPredicate,
    TextPredicate,
    WithinHopsPredicate,
)


# ---------------------------------------------------------------------------
# Models — construction + JSON round-trip
# ---------------------------------------------------------------------------

class TestModelConstruction:
    def test_minimal_text_query(self):
        q = SearchQuery(predicate=TextPredicate(value="customer", target="name"))
        assert q.predicate.kind == "text"
        assert q.options.results == "aggregates"  # default

    def test_nested_group_with_mixed_predicates(self):
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TagPredicate(values=["PII"]),
                PropertyPredicate(key="logicalType", op="eq", value="STRING"),
                GroupPredicate(op="or", children=[
                    TextPredicate(value="customer", target="name"),
                    DescendantOfPredicate(urns=["urn:domain:Customers"]),
                ]),
            ]),
        )
        # discriminator should resolve every leaf
        assert q.predicate.children[0].kind == "tag"
        assert q.predicate.children[2].children[0].kind == "text"
        assert q.predicate.children[2].children[1].kind == "descendantOf"

    def test_json_round_trip(self):
        original = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TagPredicate(values=["PII", "GDPR"], op="hasAll"),
                HasPropertyPredicate(key="pii_class"),
            ]),
            scope=SearchScope(root_urns=["urn:domain:X"], entity_types=["dataset"]),
            options=SearchOptions(
                results="both",
                aggregations=[AggregationSpec(
                    by="ancestorType",
                    ancestor_entity_types=["domain"],
                )],
            ),
        )
        round_tripped = SearchQuery.model_validate_json(
            original.model_dump_json(by_alias=True)
        )
        assert round_tripped.predicate.kind == "group"
        assert round_tripped.predicate.children[0].values == ["PII", "GDPR"]
        assert round_tripped.options.aggregations[0].by == "ancestorType"


# ---------------------------------------------------------------------------
# Service validator — depth / leaf / OR-branch caps
# ---------------------------------------------------------------------------

class TestServiceValidator:
    def test_leaf_only_passes(self):
        q = SearchQuery(predicate=TextPredicate(value="x", target="name"))
        assert _count_and_validate(q) == 1

    def test_flat_and_passes(self):
        q = SearchQuery(predicate=GroupPredicate(op="and", children=[
            TagPredicate(values=["A"]),
            TagPredicate(values=["B"]),
            HasPropertyPredicate(key="k"),
        ]))
        assert _count_and_validate(q) == 3

    def test_depth_cap_enforced(self):
        # Build a chain of nested AND groups exceeding MAX_TREE_DEPTH
        leaf = TagPredicate(values=["x"])
        node = leaf
        # Each wrap adds 1 to depth. The leaf itself is depth N+1 where N
        # is the number of wraps. We need depth > MAX_TREE_DEPTH at a leaf.
        for _ in range(MAX_TREE_DEPTH + 1):
            node = GroupPredicate(op="and", children=[node])
        q = SearchQuery(predicate=node)
        with pytest.raises(ValidationError, match="max depth"):
            _count_and_validate(q)

    def test_leaf_count_cap_enforced(self):
        leaves = [TagPredicate(values=[f"t{i}"]) for i in range(MAX_LEAF_COUNT + 1)]
        # Split across two AND groups (each has 32 children); avoids the
        # OR-branch cap that would also fire.
        mid = MAX_LEAF_COUNT // 2 + 1
        q = SearchQuery(predicate=GroupPredicate(op="and", children=[
            GroupPredicate(op="and", children=leaves[:mid]),
            GroupPredicate(op="and", children=leaves[mid:]),
        ]))
        with pytest.raises(ValidationError, match="leaves"):
            _count_and_validate(q)

    def test_or_branch_cap_enforced(self):
        q = SearchQuery(predicate=GroupPredicate(op="or", children=[
            TagPredicate(values=[f"t{i}"]) for i in range(MAX_OR_BRANCH + 1)
        ]))
        with pytest.raises(ValidationError, match="OR group"):
            _count_and_validate(q)

    def test_not_arity_enforced(self):
        q = SearchQuery(predicate=GroupPredicate(op="not", children=[
            TagPredicate(values=["a"]),
            TagPredicate(values=["b"]),
        ]))
        with pytest.raises(ValidationError, match="NOT group"):
            _count_and_validate(q)


# ---------------------------------------------------------------------------
# Predicate compiler — WHERE fragment + parameter binding
# ---------------------------------------------------------------------------

class TestCompilerLeaves:
    def test_text_substring_case_insensitive(self):
        c = _Compiler()
        where = c.compile(TextPredicate(value="Customer", target="name"))
        assert where == "toLower(toString(n.displayName)) CONTAINS $p0"
        assert c.params == {"p0": "customer"}

    def test_text_exact_case_sensitive(self):
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="X", target="qualifiedName",
            match="exact", case_sensitive=True,
        ))
        assert where == "n.qualifiedName = $p0"
        assert c.params == {"p0": "X"}

    def test_text_property_target(self):
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="abc", target="property", property_key="logicalType",
            match="prefix",
        ))
        assert where == "toLower(toString(n.logicalType)) STARTS WITH $p0"

    def test_text_any_raises_deferred(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="target='any'"):
            c.compile(TextPredicate(value="x", target="any"))

    def test_text_fulltext_raises_deferred(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="fulltext"):
            c.compile(TextPredicate(value="x", target="name", match="fulltext"))

    def test_property_eq(self):
        # eq predicates carry a blob fallback so pre-W-1 nodes (where
        # the value is trapped in n.properties JSON) still match. The
        # native branch is the fast/precise path; the blob branch is
        # the slow/permissive backup.
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="logicalType", op="eq", value="STRING"))
        assert where == (
            "(n.logicalType = $p0 OR "
            "(n.properties IS NOT NULL AND "
            "(n.properties CONTAINS '\"logicalType\":\"STRING\"' OR "
            "n.properties CONTAINS '\"logicalType\": \"STRING\"')))"
        )
        assert c.params == {"p0": "STRING"}

    def test_property_eq_numeric_has_blob_fallback(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="rowCount", op="eq", value=1000))
        # Numeric values match without quotes in the blob
        assert "n.properties CONTAINS '\"rowCount\":1000'" in where
        assert "n.properties CONTAINS '\"rowCount\": 1000'" in where

    def test_property_eq_bool_has_blob_fallback(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="nullable", op="eq", value=True))
        assert "n.properties CONTAINS '\"nullable\":true'" in where

    def test_property_between(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="rowCount", op="between", value=[100, 200]))
        assert where == "(n.rowCount >= $p0 AND n.rowCount <= $p1)"
        assert c.params == {"p0": 100, "p1": 200}

    def test_property_between_bad_value(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="value="):
            c.compile(PropertyPredicate(key="x", op="between", value=[1]))

    def test_property_in(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="logicalType", op="in", value=["A", "B"]))
        assert where == "n.logicalType IN $p0"
        assert c.params == {"p0": ["A", "B"]}

    def test_property_not_in(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="logicalType", op="notIn", value=["A"]))
        assert where == "NOT (n.logicalType IN $p0)"

    def test_property_contains(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="dataType", op="contains", value="INT"))
        assert where == "toLower(toString(n.dataType)) CONTAINS $p0"
        assert c.params == {"p0": "int"}

    def test_property_injection_blocked(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="disallowed chars"):
            # Cypher injection attempt — semicolon, parens, etc. should be rejected
            c.compile(PropertyPredicate(key="x); DROP TABLE", op="eq", value="y"))

    def test_property_name_starting_with_digit_rejected(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="start with a digit"):
            c.compile(PropertyPredicate(key="9foo", op="eq", value="x"))

    def test_tag_has(self):
        c = _Compiler()
        where = c.compile(TagPredicate(values=["PII"]))  # default op='has'
        # Tag values are JSON-encoded so they match the `"PII"` form
        # inside the stringified array.
        assert where == "(n.tags CONTAINS $p0)"
        assert c.params == {"p0": '"PII"'}

    def test_tag_has_all_two_values(self):
        c = _Compiler()
        where = c.compile(TagPredicate(op="hasAll", values=["PII", "GDPR"]))
        assert where == "(n.tags CONTAINS $p0 AND n.tags CONTAINS $p1)"

    def test_tag_not_has(self):
        c = _Compiler()
        where = c.compile(TagPredicate(op="notHas", values=["public"]))
        assert where == "NOT (n.tags CONTAINS $p0)"

    def test_has_property(self):
        # hasProperty has a blob fallback so pre-W-1 nodes still match.
        c = _Compiler()
        where = c.compile(HasPropertyPredicate(key="pii_class"))
        assert where.startswith("(EXISTS(n.pii_class) OR ")
        assert "n.properties CONTAINS '\"pii_class\":'" in where

    def test_has_property_negate(self):
        c = _Compiler()
        where = c.compile(HasPropertyPredicate(key="pii_class", negate=True))
        assert where.startswith("NOT ((EXISTS(n.pii_class) OR ")

    def test_entity_type_in(self):
        c = _Compiler()
        where = c.compile(EntityTypePredicate(values=["dataset", "schemaField"]))
        assert where == "labels(n)[0] IN $p0"

    def test_entity_type_not_in(self):
        c = _Compiler()
        where = c.compile(EntityTypePredicate(op="notIn", values=["domain"]))
        assert where == "NOT (labels(n)[0] IN $p0)"

    def test_layer(self):
        c = _Compiler()
        where = c.compile(LayerPredicate(layer_assignment="Source"))
        assert where == "n.layerAssignment = $p0"
        assert c.params == {"p0": "Source"}

    def test_within_hops_raises_deferred(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="WithinHops"):
            c.compile(WithinHopsPredicate(urns=["urn:x"], hops=2))


class TestCompilerGroups:
    def test_and(self):
        # AND group: tag CONTAINS plus property eq (with blob fallback)
        c = _Compiler()
        where = c.compile(GroupPredicate(op="and", children=[
            TagPredicate(values=["PII"]),
            PropertyPredicate(key="logicalType", op="eq", value="STRING"),
        ]))
        assert where.startswith("((n.tags CONTAINS $p0) AND ")
        assert "n.logicalType = $p1" in where  # native branch
        assert "n.properties CONTAINS '\"logicalType\":\"STRING\"'" in where
        assert c.params == {"p0": '"PII"', "p1": "STRING"}

    def test_or(self):
        c = _Compiler()
        where = c.compile(GroupPredicate(op="or", children=[
            TextPredicate(value="x", target="name", match="exact"),
            HasPropertyPredicate(key="foo"),
        ]))
        assert where.startswith("(toLower(toString(n.displayName)) = $p0 OR ")
        assert "EXISTS(n.foo)" in where  # native branch
        assert "n.properties CONTAINS '\"foo\":'" in where  # blob branch

    def test_not(self):
        c = _Compiler()
        where = c.compile(GroupPredicate(op="not", children=[
            TagPredicate(values=["public"]),
        ]))
        assert where == "NOT ((n.tags CONTAINS $p0))"

    def test_descendant_of_top_level_hoisted(self):
        # DescendantOf at the top-level AND compiles to TRUE; the URNs
        # are stashed on the compiler for the caller to merge into scope.
        # The property eq predicate now carries a blob fallback (see
        # test_property_eq above), so the AND fragment includes both
        # the native branch and the OR-blob branch.
        c = _Compiler()
        where = c.compile(GroupPredicate(op="and", children=[
            DescendantOfPredicate(urns=["urn:domain:A", "urn:domain:B"]),
            PropertyPredicate(key="logicalType", op="eq", value="STRING"),
        ]))
        assert where.startswith("(true AND (n.logicalType = $p0 OR ")
        assert c.hoisted_root_urns == [["urn:domain:A", "urn:domain:B"]]

    def test_descendant_of_inside_or_rejected(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="top-level AND"):
            c.compile(GroupPredicate(op="or", children=[
                DescendantOfPredicate(urns=["urn:x"]),
                TagPredicate(values=["PII"]),
            ]))

    def test_descendant_of_inside_nested_not_rejected(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="top-level AND"):
            c.compile(GroupPredicate(op="not", children=[
                DescendantOfPredicate(urns=["urn:x"]),
            ]))


# ---------------------------------------------------------------------------
# Scope hoisting + intersection
# ---------------------------------------------------------------------------

class TestEffectiveRootUrns:
    def test_no_scope_no_hoist_returns_none(self):
        c = _Compiler()
        assert _effective_root_urns(c, None) is None

    def test_scope_only_returns_sorted(self):
        c = _Compiler()
        assert _effective_root_urns(c, ["urn:b", "urn:a"]) == ["urn:a", "urn:b"]

    def test_intersects_scope_with_hoisted(self):
        c = _Compiler()
        c.hoisted_root_urns = [["urn:a", "urn:b", "urn:c"]]
        # Scope further narrows to b+c. Intersection = [b, c]
        result = _effective_root_urns(c, ["urn:b", "urn:c", "urn:d"])
        assert result == ["urn:b", "urn:c"]

    def test_intersects_multiple_hoisted(self):
        c = _Compiler()
        c.hoisted_root_urns = [["urn:a", "urn:b"], ["urn:b", "urn:c"]]
        # Two DescendantOf predicates AND'd → intersection {b}
        assert _effective_root_urns(c, None) == ["urn:b"]

    def test_empty_intersection(self):
        c = _Compiler()
        c.hoisted_root_urns = [["urn:a"], ["urn:b"]]
        # AND-incompatible roots → empty list (caller short-circuits to no rows)
        assert _effective_root_urns(c, None) == []


# ---------------------------------------------------------------------------
# Candidate Cypher assembly
# ---------------------------------------------------------------------------

class TestCandidateCypher:
    def test_minimal(self):
        cypher = _build_candidate_cypher(
            where_fragment="n.logicalType = $p0",
            entity_types_param=False,
            scope_continuation="",
            candidate_cap=CANDIDATE_CAP,
        )
        assert cypher == (
            f"MATCH (n) WHERE n.logicalType = $p0 WITH n LIMIT {CANDIDATE_CAP}"
        )

    def test_with_entity_types(self):
        cypher = _build_candidate_cypher(
            where_fragment="true",  # collapsed empty predicate
            entity_types_param=True,
            scope_continuation="",
            candidate_cap=CANDIDATE_CAP,
        )
        # When fragment is the trivial "true", drop it to avoid noise.
        assert "WHERE labels(n)[0] IN $_scopeEntityTypes" in cypher
        assert " AND true" not in cypher

    def test_with_scope_continuation(self):
        cypher = _build_candidate_cypher(
            where_fragment="n.x = $p0",
            entity_types_param=False,
            scope_continuation=(
                "MATCH (root)-[:CONTAINS*1..12]->(n) "
                "WHERE root.urn IN $_rootUrns WITH DISTINCT n"
            ),
            candidate_cap=CANDIDATE_CAP,
        )
        assert cypher.endswith(
            f"WITH n LIMIT {CANDIDATE_CAP} "
            f"MATCH (root)-[:CONTAINS*1..12]->(n) "
            f"WHERE root.urn IN $_rootUrns WITH DISTINCT n"
        )


# ---------------------------------------------------------------------------
# Cursor codec + query hash
# ---------------------------------------------------------------------------

class TestCursor:
    def test_round_trip(self):
        state = {"sort": "displayName", "lastValue": "customers", "lastUrn": "urn:x"}
        encoded = encode_cursor(state)
        assert isinstance(encoded, str)
        decoded = decode_cursor(encoded)
        assert decoded == state

    def test_bad_cursor_raises(self):
        with pytest.raises(CompileError, match="invalid cursor"):
            decode_cursor("not-base64!!!")

    def test_query_hash_stable_across_runs(self):
        q1 = SearchQuery(predicate=TagPredicate(values=["PII"]))
        q2 = SearchQuery(predicate=TagPredicate(values=["PII"]))
        assert query_hash(q1) == query_hash(q2)

    def test_query_hash_changes_with_predicate(self):
        q1 = SearchQuery(predicate=TagPredicate(values=["PII"]))
        q2 = SearchQuery(predicate=TagPredicate(values=["GDPR"]))
        assert query_hash(q1) != query_hash(q2)


# ---------------------------------------------------------------------------
# Aggregation by arbitrary property + sort by arbitrary property
# (the "show me layout by layer" + "biggest first" gap closure)
# ---------------------------------------------------------------------------

class TestAggregationByProperty:
    def test_spec_accepts_property_kind(self):
        spec = AggregationSpec(by="property", propertyKey="layer")
        assert spec.by == "property"
        assert spec.property_key == "layer"

    def test_round_trip_through_query(self):
        q = SearchQuery(
            predicate=TagPredicate(values=["PII"]),
            options={  # type: ignore[arg-type]
                "aggregations": [
                    {"by": "property", "propertyKey": "layer", "maxBuckets": 10},
                ],
            },
        )
        j = q.model_dump_json(by_alias=True)
        round_tripped = SearchQuery.model_validate_json(j)
        assert round_tripped.options.aggregations[0].by == "property"
        assert round_tripped.options.aggregations[0].property_key == "layer"

    @pytest.mark.asyncio
    async def test_emits_property_pivot_cypher(self):
        # Stub provider that records the Cypher it would run instead of
        # talking to FalkorDB. Lets us verify the visitor output without
        # a live graph.
        import asyncio

        class _CapturingProvider:
            def __init__(self):
                self.calls = []

            async def _ro_query(self, cypher, *, params=None, timeout=None):
                self.calls.append((cypher, params, timeout))
                class R:
                    result_set = []
                return R()

            def _get_containment_edge_types(self):
                return ["CONTAINS"]

            def _extract_node_from_result(self, _row):
                return None

        prov = _CapturingProvider()
        from backend.app.providers.falkordb_deep_search import (
            _run_aggregation_property,
        )
        spec = AggregationSpec(
            by="property", propertyKey="layer",
            maxBuckets=20, sampleHitsPerBucket=3,
        )
        cand_cypher = "MATCH (n) WHERE n.tags CONTAINS $p0 WITH n LIMIT 5000"
        await _run_aggregation_property(
            prov, cand_cypher, {"p0": '"PII"'}, spec, timeout_s=3.0,
        )
        assert len(prov.calls) == 1
        cypher = prov.calls[0][0]
        # Critical assertions: pivots on n.layer, filters out nulls, uses GROUP BY
        assert "WHERE EXISTS(n.layer)" in cypher
        assert "WITH n.layer AS pkey, n" in cypher
        assert "count(DISTINCT n) AS mc" in cypher
        assert "ORDER BY mc DESC LIMIT 20" in cypher
        assert "collect(DISTINCT n)[..3]" in cypher

    @pytest.mark.asyncio
    async def test_missing_property_key_raises(self):
        from backend.app.providers.falkordb_deep_search import (
            _run_aggregation_property,
        )
        with pytest.raises(CompileError, match="propertyKey"):
            await _run_aggregation_property(
                None, "x", {},
                AggregationSpec(by="property"),  # no propertyKey
                timeout_s=3.0,
            )

    def test_property_name_injection_blocked(self):
        # The property name is interpolated into the Cypher (it can't
        # be parameterised), so the same alnum+_ guard from the predicate
        # compiler must apply here too.
        import asyncio
        from backend.app.providers.falkordb_deep_search import (
            _run_aggregation_property,
        )

        async def go():
            await _run_aggregation_property(
                None, "x", {},
                AggregationSpec(by="property", propertyKey="x); DROP"),
                timeout_s=3.0,
            )
        with pytest.raises(CompileError, match="disallowed chars"):
            asyncio.run(go())


class TestSortByProperty:
    def test_options_accept_sort_property(self):
        from backend.common.models.search import SearchOptions
        opts = SearchOptions(sortProperty="rowCount", sortDir="desc")
        assert opts.sort_property == "rowCount"
        assert opts.sort_dir == "desc"

    def test_hits_sorted_by_native_property_descending(self):
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        from backend.common.models.graph import GraphNode

        class _MockProv:
            def _extract_node_from_result(self, n):
                return n  # rows ARE GraphNodes for the test

        rows = [
            GraphNode(urn="urn:a", entityType="dataset", displayName="a",
                      properties={"rowCount": 100}),
            GraphNode(urn="urn:b", entityType="dataset", displayName="b",
                      properties={"rowCount": 9000}),
            GraphNode(urn="urn:c", entityType="dataset", displayName="c",
                      properties={"rowCount": 500}),
        ]
        q = SearchQuery(
            predicate=TagPredicate(values=["x"]),
            options={  # type: ignore[arg-type]
                "sortProperty": "rowCount", "sortDir": "desc",
                "pageSize": 10,
            },
        )
        hits = _build_hits_from_rows(_MockProv(), rows, q)
        assert [h.node.urn for h in hits] == ["urn:b", "urn:c", "urn:a"]

    def test_hits_sorted_by_native_property_ascending(self):
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        from backend.common.models.graph import GraphNode

        class _MockProv:
            def _extract_node_from_result(self, n):
                return n

        rows = [
            GraphNode(urn="urn:a", entityType="dataset", displayName="a",
                      properties={"rowCount": 100}),
            GraphNode(urn="urn:b", entityType="dataset", displayName="b",
                      properties={"rowCount": 9000}),
            GraphNode(urn="urn:c", entityType="dataset", displayName="c",
                      properties={"rowCount": 500}),
        ]
        q = SearchQuery(
            predicate=TagPredicate(values=["x"]),
            options={  # type: ignore[arg-type]
                "sortProperty": "rowCount", "sortDir": "asc",
                "pageSize": 10,
            },
        )
        hits = _build_hits_from_rows(_MockProv(), rows, q)
        assert [h.node.urn for h in hits] == ["urn:a", "urn:c", "urn:b"]

    def test_missing_property_clumps_consistently(self):
        # Nodes without the sort property end up grouped at one end —
        # neither randomly interleaved nor dropped from the result.
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        from backend.common.models.graph import GraphNode

        class _MockProv:
            def _extract_node_from_result(self, n):
                return n

        rows = [
            GraphNode(urn="urn:a", entityType="dataset", displayName="a",
                      properties={"rowCount": 100}),
            GraphNode(urn="urn:b", entityType="dataset", displayName="b",
                      properties={}),  # no rowCount
            GraphNode(urn="urn:c", entityType="dataset", displayName="c",
                      properties={"rowCount": 500}),
        ]
        q = SearchQuery(
            predicate=TagPredicate(values=["x"]),
            options={  # type: ignore[arg-type]
                "sortProperty": "rowCount", "sortDir": "desc",
                "pageSize": 10,
            },
        )
        hits = _build_hits_from_rows(_MockProv(), rows, q)
        # All three returned; missing-rowCount node grouped consistently
        assert len(hits) == 3
        urns_with_value = [h.node.urn for h in hits if h.node.properties.get("rowCount") is not None]
        assert urns_with_value == ["urn:c", "urn:a"]  # 500, 100 desc

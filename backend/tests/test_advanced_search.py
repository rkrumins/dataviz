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
import asyncio
import json
import logging

import pytest

from backend.app.providers.falkordb_deep_search import (
    CANDIDATE_CAP,
    CompileError,
    _Compiler,
    _build_candidate_cypher,
    _effective_root_urns,
    _resolve_entity_types_scope,
    decode_cursor,
    encode_cursor,
    match_hash,
    query_hash,
)
from backend.app.services.advanced_search_service import (
    MAX_LEAF_COUNT,
    MAX_OR_BRANCH,
    MAX_TREE_DEPTH,
    ValidationError,
    _count_and_validate,
    _reject_unbounded_text_any,
)
from backend.common.models.search import (
    AggregationSpec,
    DegreePredicate,
    DescendantOfPredicate,
    EntityTypePredicate,
    GroupPredicate,
    HasIncomingPredicate,
    HasOutgoingPredicate,
    HasPropertyPredicate,
    IsLeafPredicate,
    IsOrphanPredicate,
    IsRootPredicate,
    LayerPredicate,
    PathPredicate,
    PropertyPredicate,
    SearchOptions,
    SearchQuery,
    SearchScope,
    TagPredicate,
    TextPredicate,
    WithinHopsPredicate,
)


# Compiler fixture for degree-family tests: inject a realistic lineage
# edge-type set so _visit_degree has something to alternate over.
_LINEAGE_EDGE_TYPES = {"LINEAGE", "PRODUCES", "CONSUMES"}
_CONTAINMENT_EDGE_TYPES = {"CONTAINS"}


def _degree_compiler() -> _Compiler:
    return _Compiler(
        lineage_edge_types=_LINEAGE_EDGE_TYPES,
        containment_edge_types=_CONTAINMENT_EDGE_TYPES,
    )


# Every SearchQuery is bound to a view via scope.viewId — there is no
# global/cross-view search. The unit tests don't need a real view; they
# just need a syntactically valid scope so SearchQuery validation
# accepts the constructor.
_TEST_SCOPE = SearchScope(view_id="view_test")


# ---------------------------------------------------------------------------
# Models — construction + JSON round-trip
# ---------------------------------------------------------------------------

class TestModelConstruction:
    def test_minimal_text_query(self):
        q = SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=_TEST_SCOPE,
        )
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
            scope=_TEST_SCOPE,
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
            scope=SearchScope(
                view_id="view_test",
                root_urns=["urn:domain:X"],
                entity_types=["dataset"],
            ),
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
# _safe_property_name — direct unit tests for the Cypher backtick helper
# ---------------------------------------------------------------------------
#
# The helper is module-private but its correctness underpins every property
# filter in the search panel. Six compile-time call sites interpolate its
# return value directly into Cypher (PropertyPredicate, HasPropertyPredicate,
# TextPredicate's ``target=property`` branch, EdgePropertyPredicate,
# EdgeHasPropertyPredicate, and the aggregation pivot). A regression in the
# escape logic would silently slip through happy-path compiler tests but
# would either crash FalkorDB with a syntax error OR — worse — expose a
# Cypher-injection vector. These tests pin the contract:
#
#   1. Always returns a backtick-wrapped string (never a bare identifier).
#   2. Doubles any internal backticks per OpenCypher / FalkorDB grammar.
#   3. Tolerates spaces / hyphens / dots / leading digits / unicode.
#   4. Rejects only the genuinely-invalid cases (empty, non-string).
# ---------------------------------------------------------------------------

class TestSafePropertyName:
    """Direct exercises of ``_safe_property_name`` (no compiler involved).

    Imported via the canonical underscore-prefix path because Python
    treats it as module-private. The function is short but load-bearing
    — testing in isolation guards against accidental regressions when
    callers refactor (e.g. someone replaces ``_safe_property_name(k)``
    with a raw ``f"`{k}`"`` and forgets the backtick-doubling escape).
    """

    @staticmethod
    def _safe_property_name(key):
        from backend.app.providers.falkordb_deep_search import (
            _safe_property_name,
        )
        return _safe_property_name(key)

    # ── Happy path: always wraps in backticks ──────────────────────────
    def test_returns_plain_name_wrapped_in_backticks(self):
        """The "always quote" contract — even a perfectly safe
        identifier comes back backtick-wrapped. This keeps the
        compilation path branch-free and gives consistent output."""
        assert self._safe_property_name("foo") == "`foo`"

    def test_wraps_name_with_spaces(self):
        """The original bug report: property keys like ``Asset Owner``
        (with spaces) used to return HTTP 400; now they backtick-wrap."""
        assert self._safe_property_name("Asset Owner") == "`Asset Owner`"

    def test_wraps_name_with_hyphen(self):
        """Hyphens are common in real-world property keys
        (``pii-class``, ``data-source-id``)."""
        assert self._safe_property_name("pii-class") == "`pii-class`"

    def test_wraps_name_with_dot(self):
        """Dots also appear in property keys (``user.id``,
        ``audit.timestamp``) when source systems flatten nested
        objects into dotted keys."""
        assert self._safe_property_name("user.id") == "`user.id`"

    def test_wraps_name_starting_with_digit(self):
        """Backticked identifiers may begin with a digit — common in
        year-prefixed property names (``2024_revenue``)."""
        assert self._safe_property_name("2024_revenue") == "`2024_revenue`"

    def test_wraps_unicode_name(self):
        """FalkorDB stores UTF-8 property keys; the helper must
        round-trip non-ASCII characters as-is inside the backticks."""
        assert self._safe_property_name("属性名") == "`属性名`"

    def test_whitespace_only_name_is_wrapped(self):
        """A single space is a legal Cypher identifier when quoted —
        weird but legal. The helper doesn't second-guess the caller."""
        assert self._safe_property_name(" ") == "` `"

    # ── Backtick escaping: the only character that needs special handling ─
    def test_doubles_internal_backtick(self):
        """The Cypher / OpenCypher / FalkorDB grammar escapes an
        internal backtick by doubling it. Without this escape, the
        first internal backtick would terminate the outer pair early
        and the rest would be syntax garbage."""
        assert self._safe_property_name("a`b") == "`a``b`"

    def test_doubles_multiple_internal_backticks(self):
        """Each internal backtick is doubled independently."""
        assert self._safe_property_name("a`b`c") == "`a``b``c`"

    def test_doubles_consecutive_backticks(self):
        """Two consecutive internal backticks become four (each
        doubled). Without this the parser would close the outer pair
        on the first internal ``\\``` and re-open with the second."""
        assert self._safe_property_name("a``b") == "`a````b`"

    def test_backtick_only_name(self):
        """Degenerate case: the name is JUST a backtick. Doubled →
        two backticks. Wrapped → four backticks total: the outer
        opening backtick + two doubled inner + the outer closing
        backtick = ``\\`\\`\\`\\```."""
        assert self._safe_property_name("`") == "````"

    # ── Injection neutralisation: the SECURITY contract ──────────────────
    def test_wraps_injection_attempt_safely(self):
        """A Cypher-injection attempt that escaped the old
        ``alphanumeric + underscore`` allowlist now compiles to a
        single, harmless backtick-quoted identifier. The semicolon,
        parentheses, and comment markers never reach the Cypher
        parser as syntax — they're literal characters inside one
        identifier."""
        hostile = "x); DROP TABLE //"
        assert self._safe_property_name(hostile) == f"`{hostile}`"

    # ── Error paths: only invalid inputs raise ────────────────────────────
    def test_empty_string_raises(self):
        from backend.app.providers.falkordb_deep_search import (
            CompileError,
        )
        with pytest.raises(CompileError, match="empty property name"):
            self._safe_property_name("")

    def test_non_string_int_raises(self):
        from backend.app.providers.falkordb_deep_search import (
            CompileError,
        )
        with pytest.raises(CompileError, match="must be a string"):
            self._safe_property_name(42)

    def test_non_string_none_raises(self):
        """``None`` is rejected by the upfront ``if not key`` guard
        (Python truthiness) — it raises ``empty property name``
        rather than the type-check message, but it never escapes as
        an unhandled exception or returns garbage Cypher."""
        from backend.app.providers.falkordb_deep_search import (
            CompileError,
        )
        with pytest.raises(CompileError):
            self._safe_property_name(None)


# ---------------------------------------------------------------------------
# Service validator — depth / leaf / OR-branch caps
# ---------------------------------------------------------------------------

class TestServiceValidator:
    def test_leaf_only_passes(self):
        q = SearchQuery(
            predicate=TextPredicate(value="x", target="name"),
            scope=_TEST_SCOPE,
        )
        assert _count_and_validate(q) == 1

    def test_flat_and_passes(self):
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TagPredicate(values=["A"]),
                TagPredicate(values=["B"]),
                HasPropertyPredicate(key="k"),
            ]),
            scope=_TEST_SCOPE,
        )
        assert _count_and_validate(q) == 3

    def test_depth_cap_enforced(self):
        # Build a chain of nested AND groups exceeding MAX_TREE_DEPTH
        leaf = TagPredicate(values=["x"])
        node = leaf
        # Each wrap adds 1 to depth. The leaf itself is depth N+1 where N
        # is the number of wraps. We need depth > MAX_TREE_DEPTH at a leaf.
        for _ in range(MAX_TREE_DEPTH + 1):
            node = GroupPredicate(op="and", children=[node])
        q = SearchQuery(predicate=node, scope=_TEST_SCOPE)
        with pytest.raises(ValidationError, match="max depth"):
            _count_and_validate(q)

    def test_leaf_count_cap_enforced(self):
        leaves = [TagPredicate(values=[f"t{i}"]) for i in range(MAX_LEAF_COUNT + 1)]
        # Split across two AND groups (each has 32 children); avoids the
        # OR-branch cap that would also fire.
        mid = MAX_LEAF_COUNT // 2 + 1
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                GroupPredicate(op="and", children=leaves[:mid]),
                GroupPredicate(op="and", children=leaves[mid:]),
            ]),
            scope=_TEST_SCOPE,
        )
        with pytest.raises(ValidationError, match="leaves"):
            _count_and_validate(q)

    def test_or_branch_cap_enforced(self):
        q = SearchQuery(
            predicate=GroupPredicate(op="or", children=[
                TagPredicate(values=[f"t{i}"]) for i in range(MAX_OR_BRANCH + 1)
            ]),
            scope=_TEST_SCOPE,
        )
        with pytest.raises(ValidationError, match="OR group"):
            _count_and_validate(q)

    def test_not_arity_enforced(self):
        q = SearchQuery(
            predicate=GroupPredicate(op="not", children=[
                TagPredicate(values=["a"]),
                TagPredicate(values=["b"]),
            ]),
            scope=_TEST_SCOPE,
        )
        with pytest.raises(ValidationError, match="NOT group"):
            _count_and_validate(q)

    def test_bare_text_any_without_scope_rejected(self):
        """A standalone ``text(target='any')`` with no scope clamp
        triggers a full-graph CONTAINS scan. Service rejects it so
        the user gets a clear remediation message instead of a
        candidate-cap timeout.

        The guard runs on the RESOLVED scope (after the view's own
        roots have been stamped in), so these unit tests call it
        directly rather than through ``_count_and_validate``."""
        q = SearchQuery(
            predicate=TextPredicate(value="snowflake", target="any"),
            scope=_TEST_SCOPE,  # view_id only, no root_urns / entity_types
        )
        with pytest.raises(ValidationError, match="no boundaries yet"):
            _reject_unbounded_text_any(q)

    def test_text_any_or_text_any_without_scope_rejected(self):
        """An OR group of two text-any predicates is also unbounded."""
        q = SearchQuery(
            predicate=GroupPredicate(op="or", children=[
                TextPredicate(value="a", target="any"),
                TextPredicate(value="b", target="any"),
            ]),
            scope=_TEST_SCOPE,
        )
        with pytest.raises(ValidationError, match="no boundaries yet"):
            _reject_unbounded_text_any(q)

    def test_text_any_with_entity_type_filter_allowed(self):
        """A text-any predicate combined with a bounding leaf is
        allowed — the entityType filter narrows the candidate scan
        before the CONTAINS runs."""
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TextPredicate(value="snowflake", target="any"),
                EntityTypePredicate(op="in", values=["dataset"]),
            ]),
            scope=_TEST_SCOPE,
        )
        # No exception expected.
        _reject_unbounded_text_any(q)

    def test_text_any_with_scope_root_urns_allowed(self):
        """Resolved root URNs bound the scan; predicate guard
        bypassed even if the predicate is purely text-any."""
        scope_with_roots = _TEST_SCOPE.model_copy(
            update={"root_urns": ["urn:dataset:orders"]},
        )
        q = SearchQuery(
            predicate=TextPredicate(value="snowflake", target="any"),
            scope=scope_with_roots,
        )
        _reject_unbounded_text_any(q)

    def test_text_any_with_scope_entity_types_allowed(self):
        """Resolved entity_types clamp the candidate scan; bare
        text-any is acceptable in that case."""
        scope_with_types = _TEST_SCOPE.model_copy(
            update={"entity_types": ["dataset"]},
        )
        q = SearchQuery(
            predicate=TextPredicate(value="snowflake", target="any"),
            scope=scope_with_types,
        )
        _reject_unbounded_text_any(q)

    def test_text_specific_field_without_scope_allowed(self):
        """``text(target='qualifiedName')`` hits an indexed column —
        not subject to the unbounded-CONTAINS-scan guard."""
        q = SearchQuery(
            predicate=TextPredicate(
                value="orders", target="qualifiedName",
            ),
            scope=_TEST_SCOPE,
        )
        _reject_unbounded_text_any(q)

    def test_visible_mode_with_urns_allowed(self):
        """``scope_mode='visible'`` with a non-empty ``visible_urns``
        list is its own clamp — the candidate scan is filtered to the
        URNs the canvas just rendered, so bare text-any is bounded."""
        visible_scope = _TEST_SCOPE.model_copy(
            update={"scope_mode": "visible", "visible_urns": ["urn:a"]},
        )
        q = SearchQuery(
            predicate=TextPredicate(value="snowflake", target="any"),
            scope=visible_scope,
        )
        _reject_unbounded_text_any(q)

    def test_visible_mode_without_urns_rejected(self):
        """``scope_mode='visible'`` with an empty URN list is NOT a
        clamp — the compiler falls back to view semantics, so the
        guard must still fire."""
        visible_scope = _TEST_SCOPE.model_copy(
            update={"scope_mode": "visible"},
        )
        q = SearchQuery(
            predicate=TextPredicate(value="snowflake", target="any"),
            scope=visible_scope,
        )
        with pytest.raises(ValidationError, match="no boundaries yet"):
            _reject_unbounded_text_any(q)

    def test_sub_aggregation_rejected_until_executor_lands(self):
        """W1.2: sub_aggregation is accepted by the contract but the
        executor does not yet populate ``sub_buckets``. Rather than
        silently drop the sub-spec, the service rejects so callers
        get a clear "drill via re-issue" remediation."""
        spec = AggregationSpec(
            by="ancestorType",
            ancestor_entity_types=["domain"],
            sub_aggregation=AggregationSpec(by="entityType"),
        )
        q = SearchQuery(
            predicate=EntityTypePredicate(op="in", values=["dataset"]),
            scope=_TEST_SCOPE,
            options=SearchOptions(aggregations=[spec]),
        )
        with pytest.raises(ValidationError, match="sub_aggregation is not yet"):
            _count_and_validate(q)

    def test_three_level_sub_aggregation_cascade_rejected(self):
        """Three-level cascade is permanently rejected by contract.
        Even when the executor lands the two-level batched path,
        three levels stay out of scope (drill via re-issue)."""
        spec = AggregationSpec(
            by="ancestorType",
            ancestor_entity_types=["domain"],
            sub_aggregation=AggregationSpec(
                by="entityType",
                sub_aggregation=AggregationSpec(by="property", property_key="logicalType"),
            ),
        )
        q = SearchQuery(
            predicate=EntityTypePredicate(op="in", values=["dataset"]),
            scope=_TEST_SCOPE,
            options=SearchOptions(aggregations=[spec]),
        )
        with pytest.raises(ValidationError, match="three-level cascade"):
            _count_and_validate(q)


# ---------------------------------------------------------------------------
# Predicate compiler — WHERE fragment + parameter binding
# ---------------------------------------------------------------------------

class TestCompilerLeaves:
    def test_text_substring_case_insensitive(self):
        # ``target='name'`` widens to OR across the canonical name-like
        # fields the storage layer commits to (displayName,
        # qualifiedName) — NOT searchableText, which is a different,
        # broader target (``any``). A null field on a given node reads
        # as an empty null — Cypher's three-valued logic returns null
        # for that CONTAINS, and the OR over the other term decides
        # the result.
        c = _Compiler()
        where = c.compile(TextPredicate(value="Customer", target="name"))
        assert where == (
            "(toLower(toString(n.displayName)) CONTAINS $p0"
            " OR toLower(toString(n.qualifiedName)) CONTAINS $p0)"
        )
        assert c.params == {"p0": "customer"}

    def test_text_name_prefix_ors_with_starts_with(self):
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="Cust", target="name", match="prefix",
        ))
        assert where == (
            "(toLower(toString(n.displayName)) STARTS WITH $p0"
            " OR toLower(toString(n.qualifiedName)) STARTS WITH $p0)"
        )
        assert c.params == {"p0": "cust"}

    def test_text_name_exact_ors_with_eq(self):
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="Customer", target="name", match="exact",
        ))
        assert where == (
            "(toLower(toString(n.displayName)) = $p0"
            " OR toLower(toString(n.qualifiedName)) = $p0)"
        )
        assert c.params == {"p0": "customer"}

    def test_text_name_suffix_ors_with_ends_with(self):
        # ``match='suffix'`` is the symmetric of 'prefix' — compiles to
        # Cypher ``ENDS WITH``, applies to the same multi-field OR over
        # the canonical name-like columns.
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="_v2", target="name", match="suffix",
        ))
        assert where == (
            "(toLower(toString(n.displayName)) ENDS WITH $p0"
            " OR toLower(toString(n.qualifiedName)) ENDS WITH $p0)"
        )
        assert c.params == {"p0": "_v2"}

    def test_name_exact_does_not_touch_searchable_text(self):
        # Regression guard: ``target='name'`` must never widen into
        # ``n.searchableText`` for ANY match mode — that's what makes
        # "name is exactly X" / "name ends with X" honest instead of
        # silently matching a property value denormalised into the
        # blob (or never matching, for exact).
        for match in ("substring", "prefix", "suffix", "exact"):
            c = _Compiler()
            where = c.compile(TextPredicate(
                value="Customer", target="name", match=match,
            ))
            assert "searchableText" not in where

    def test_text_description_suffix(self):
        # Suffix on a single-field target (description) — no OR wrap.
        c = _Compiler()
        where = c.compile(TextPredicate(
            value=".", target="description", match="suffix",
        ))
        assert where == "toLower(toString(n.description)) ENDS WITH $p0"
        assert c.params == {"p0": "."}

    def test_text_qualifiedName_is_pure(self):
        # ``target='qualifiedName'`` is a pure single-column match — it
        # no longer widens into searchableText, so "qualifiedName is
        # exactly X" / "ends with X" are honest instead of
        # false-positiving on a property value folded into the blob.
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="abc", target="qualifiedName",
        ))
        assert where == "toLower(toString(n.qualifiedName)) CONTAINS $p0"
        assert c.params == {"p0": "abc"}

    def test_text_exact_case_sensitive(self):
        # Case-sensitive paths skip the toLower() wrap — the column read
        # is raw. ``qualifiedName`` is single-column (no OR) since it no
        # longer widens into searchableText.
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
        # Backtick-wrapped per the new ``_safe_property_name`` — any
        # user-supplied property key is quoted to allow spaces /
        # punctuation safely.
        assert where == "toLower(toString(n.`logicalType`)) STARTS WITH $p0"

    def test_text_predicate_property_target_with_spaces(self):
        """Per-call-site coverage for the property-name backtick fix:
        TextPredicate's ``target='property'`` branch (compile site at
        falkordb_deep_search.py line ~301) must also accept property
        keys with spaces. Without this guarantee the ``LIKE`` /
        ``CONTAINS`` text search would fail for any "Asset Owner"-
        style key even though the equality / IN paths now work."""
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="ops", target="property", property_key="Asset Owner",
            match="prefix",
        ))
        assert where == "toLower(toString(n.`Asset Owner`)) STARTS WITH $p0"
        assert c.params == {"p0": "ops"}

    def test_text_target_any_matches_display_name(self):
        # A node with displayName='Orders Pipeline' has its lowercased
        # displayName denormalised into n.searchableText at write time, so
        # the compiled CONTAINS predicate against n.searchableText with
        # parameter 'orders' matches it. ``any`` also ORs displayName and
        # qualifiedName directly, so a node whose searchableText hasn't
        # been backfilled yet is still found by its name.
        c = _Compiler()
        where = c.compile(TextPredicate(value="orders", target="any"))
        assert where == (
            "(toLower(toString(n.searchableText)) CONTAINS $p0"
            " OR toLower(toString(n.displayName)) CONTAINS $p0"
            " OR toLower(toString(n.qualifiedName)) CONTAINS $p0)"
        )
        assert c.params == {"p0": "orders"}

    def test_any_ors_display_and_qualified_name(self):
        # Regression guard for the ``any`` OR-widening, exercised
        # case-sensitive so the raw (non-toLower) column list is visible
        # directly rather than folded through the same wrap as the
        # substring test above.
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="Orders", target="any", case_sensitive=True,
        ))
        assert where == (
            "(n.searchableText CONTAINS $p0"
            " OR n.displayName CONTAINS $p0"
            " OR n.qualifiedName CONTAINS $p0)"
        )
        assert c.params == {"p0": "Orders"}

    def test_text_target_any_matches_property_value(self):
        # A node with sourceSystem='snowflake' and no 'snowflake' in the
        # displayName still matches because every string-valued user
        # property is folded into n.searchableText at write time. The
        # compiled fragment ORs in displayName/qualifiedName too, but the
        # match here only happens via the denormalised searchableText
        # field.
        c = _Compiler()
        where = c.compile(TextPredicate(value="Snowflake", target="any"))
        assert where == (
            "(toLower(toString(n.searchableText)) CONTAINS $p0"
            " OR toLower(toString(n.displayName)) CONTAINS $p0"
            " OR toLower(toString(n.qualifiedName)) CONTAINS $p0)"
        )
        assert c.params == {"p0": "snowflake"}

    def test_text_target_any_prefix(self):
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="orders", target="any", match="prefix",
        ))
        assert where == (
            "(toLower(toString(n.searchableText)) STARTS WITH $p0"
            " OR toLower(toString(n.displayName)) STARTS WITH $p0"
            " OR toLower(toString(n.qualifiedName)) STARTS WITH $p0)"
        )
        assert c.params == {"p0": "orders"}

    def test_text_target_any_exact(self):
        c = _Compiler()
        where = c.compile(TextPredicate(
            value="orders pipeline", target="any", match="exact",
        ))
        assert where == (
            "(toLower(toString(n.searchableText)) = $p0"
            " OR toLower(toString(n.displayName)) = $p0"
            " OR toLower(toString(n.qualifiedName)) = $p0)"
        )
        assert c.params == {"p0": "orders pipeline"}

    def test_text_target_any_with_fulltext_match_raises(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="fulltext"):
            c.compile(TextPredicate(
                value="x", target="any", match="fulltext",
            ))

    def test_text_fulltext_raises_deferred(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="fulltext"):
            c.compile(TextPredicate(value="x", target="name", match="fulltext"))

    def test_property_eq(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="logicalType", op="eq", value="STRING"))
        # All user-supplied property keys are backtick-quoted by
        # ``_safe_property_name`` so spaces / punctuation work safely.
        # ``eq`` case-folds by default, same as contains/startsWith/endsWith.
        assert where == "toLower(toString(n.`logicalType`)) = $p0"
        assert c.params == {"p0": "string"}

    def test_property_eq_case_sensitive_bypasses_fold(self):
        # ``case_sensitive=True`` skips the toLower/toString wrap — the
        # same bypass the contains/startsWith/endsWith branch already has.
        c = _Compiler()
        where = c.compile(PropertyPredicate(
            key="logicalType", op="eq", value="STRING", case_sensitive=True,
        ))
        assert where == "n.`logicalType` = $p0"
        assert c.params == {"p0": "STRING"}

    def test_property_neq_case_folds_by_default(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="logicalType", op="neq", value="STRING"))
        assert where == "toLower(toString(n.`logicalType`)) <> $p0"
        assert c.params == {"p0": "string"}

    def test_property_between(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="rowCount", op="between", value=[100, 200]))
        assert where == "(n.`rowCount` >= $p0 AND n.`rowCount` <= $p1)"
        assert c.params == {"p0": 100, "p1": 200}

    def test_property_between_bad_value(self):
        c = _Compiler()
        with pytest.raises(CompileError, match="value="):
            c.compile(PropertyPredicate(key="x", op="between", value=[1]))

    def test_property_in(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="logicalType", op="in", value=["A", "B"]))
        assert where == "n.`logicalType` IN $p0"
        assert c.params == {"p0": ["A", "B"]}

    def test_property_not_in(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="logicalType", op="notIn", value=["A"]))
        assert where == "NOT (n.`logicalType` IN $p0)"

    def test_property_contains(self):
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="dataType", op="contains", value="INT"))
        assert where == "toLower(toString(n.`dataType`)) CONTAINS $p0"
        assert c.params == {"p0": "int"}

    def test_property_with_spaces_compiles_safely(self):
        """Real-world property names like ``Asset Owner`` (with spaces)
        must compile via Cypher's backtick-quoting syntax. Used to
        return HTTP 400 ``disallowed chars`` — now permitted because
        the backticked identifier is unambiguous Cypher."""
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="Asset Owner", op="eq", value="ops"))
        assert where == "toLower(toString(n.`Asset Owner`)) = $p0"
        assert c.params == {"p0": "ops"}

    def test_property_with_hyphens_and_dots_compiles_safely(self):
        """Same rationale — hyphens and dots are common in
        real-world property names (``pii-class``, ``user.id``)."""
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="pii-class", op="eq", value="high"))
        assert where == "toLower(toString(n.`pii-class`)) = $p0"

    def test_property_injection_neutralised_by_backticks(self):
        """Cypher injection attempts now compile to safe Cypher
        instead of raising. The backtick wrapping makes the entire
        string a single identifier; the semicolon/parens never
        reach the Cypher parser as syntax."""
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="x); DROP TABLE", op="eq", value="y"))
        assert where == "toLower(toString(n.`x); DROP TABLE`)) = $p0"
        assert c.params == {"p0": "y"}

    def test_property_internal_backtick_escaped(self):
        """A property name containing a literal backtick must double
        the backtick (Cypher's standard escape) so the wrapping
        backticks aren't terminated early."""
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="a`b", op="eq", value="z"))
        assert where == "toLower(toString(n.`a``b`)) = $p0"

    def test_property_with_leading_digit_compiles_safely(self):
        """Backticked identifiers may begin with a digit; common in
        year-prefixed property names (``2024_revenue``). ``value=100``
        is an int, so ``eq`` does NOT case-fold — raw indexed compare."""
        c = _Compiler()
        where = c.compile(PropertyPredicate(key="2024_revenue", op="eq", value=100))
        assert where == "n.`2024_revenue` = $p0"
        assert c.params == {"p0": 100}

    def test_property_eq_neq_non_string_values_stay_raw(self):
        """Only string values case-fold for eq/neq (see
        ``test_property_eq`` / ``test_property_neq_case_folds_by_default``).
        Typed values — int, float, None, list — must compile to the
        original raw ``col <op> $p`` with the value passed through
        untouched, so they stay index-eligible and keep their type's
        own equality semantics instead of being silently stringified."""
        for op, symbol in (("eq", "="), ("neq", "<>")):
            for value in (100, 1.5, None, ["a"]):
                c = _Compiler()
                where = c.compile(PropertyPredicate(key="k", op=op, value=value))
                assert where == f"n.`k` {symbol} $p0"
                assert c.params == {"p0": value}

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
        c = _Compiler()
        where = c.compile(HasPropertyPredicate(key="pii_class"))
        # Backtick-wrapped by ``_safe_property_name``.
        assert where == "EXISTS(n.`pii_class`)"

    def test_has_property_negate(self):
        c = _Compiler()
        where = c.compile(HasPropertyPredicate(key="pii_class", negate=True))
        assert where == "NOT (EXISTS(n.`pii_class`))"

    def test_has_property_predicate_with_spaces(self):
        """Per-call-site coverage: HasPropertyPredicate (compile site
        at falkordb_deep_search.py line ~407) accepts property keys
        with spaces. Common real-world use case: "has Asset Owner"
        filter to surface entities missing an ownership tag."""
        c = _Compiler()
        where = c.compile(HasPropertyPredicate(key="Asset Owner"))
        assert where == "EXISTS(n.`Asset Owner`)"

    def test_entity_type_in(self):
        c = _Compiler()
        where = c.compile(EntityTypePredicate(values=["dataset", "schemaField"]))
        # Case-insensitive comparison guards against label-casing drift
        # between the ontology config and ingested data.
        assert where == "toLower(labels(n)[0]) IN $p0"
        assert c.params == {"p0": ["dataset", "schemafield"]}

    def test_entity_type_not_in(self):
        c = _Compiler()
        where = c.compile(EntityTypePredicate(op="notIn", values=["domain"]))
        assert where == "NOT (toLower(labels(n)[0]) IN $p0)"
        assert c.params == {"p0": ["domain"]}

    def test_layer(self):
        c = _Compiler()
        where = c.compile(LayerPredicate(layer_assignment="Source"))
        assert where == "n.layerAssignment = $p0"
        assert c.params == {"p0": "Source"}

    def test_within_hops_requires_ontology_injection(self):
        # WithinHopsPredicate uses ``edge_class`` to resolve the
        # traversed edge set; without the provider's ontology injection
        # (the bare ``_Compiler()`` fixture) the compiler must reject
        # the predicate rather than silently match against zero edges.
        c = _Compiler()
        with pytest.raises(CompileError, match="edgeClass='lineage'"):
            c.compile(WithinHopsPredicate(urns=["urn:x"], hops=2))

    def test_within_hops_with_explicit_edge_types(self):
        # Explicit ``edge_types`` bypasses ontology resolution, so the
        # predicate compiles cleanly even without ontology injection.
        c = _Compiler()
        where = c.compile(WithinHopsPredicate(
            urns=["urn:x"], hops=2, edge_types=["LINEAGE"],
        ))
        assert where == "true"  # hoisted to post-candidate MATCH
        assert len(c.hoisted_within_hops) == 1
        assert c.hoisted_within_hops[0]["edge_types"] == ["LINEAGE"]


class TestCompilerDegree:
    """Degree-family predicates must compile to FalkorDB-supported
    fragments. Specifically, threshold-around-zero ops collapse to
    pattern-existence (or NOT pattern-existence) — never to
    `size((pattern)) <op> 0`, because FalkorDB rejects size() over a
    relationship-type-alternation pattern when NOT-wrapped (the
    "Unable to resolve filtered alias" error).
    """

    # -- absence ('NOT pattern' idiom) ---------------------------------

    def test_orphan_lineage(self):
        c = _degree_compiler()
        where = c.compile(IsOrphanPredicate(edgeClass="lineage"))
        # Both directions absent ⇒ (NOT in AND NOT out)
        assert "NOT (n)<-[:" in where
        assert "NOT (n)-[:" in where
        assert "size(" not in where

    def test_is_root_lineage_absence(self):
        c = _degree_compiler()
        where = c.compile(IsRootPredicate(edgeClass="lineage"))
        assert where.startswith("NOT (n)<-[:")
        assert "size(" not in where

    def test_is_leaf_lineage_absence(self):
        c = _degree_compiler()
        where = c.compile(IsLeafPredicate(edgeClass="lineage"))
        assert where.startswith("NOT (n)-[:")
        assert "->()" in where
        assert "size(" not in where

    def test_degree_in_eq_zero(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="in", op="eq", value=0,
                                          edgeClass="lineage"))
        assert where.startswith("NOT (n)<-[:")
        assert "size(" not in where

    def test_degree_in_lte_zero_collapses_to_absence(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="in", op="lte", value=0,
                                          edgeClass="lineage"))
        assert where.startswith("NOT (n)<-[:")
        assert "size(" not in where

    def test_degree_in_lt_one_collapses_to_absence(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="in", op="lt", value=1,
                                          edgeClass="lineage"))
        assert where.startswith("NOT (n)<-[:")
        assert "size(" not in where

    # -- existence (bare pattern) --------------------------------------

    def test_has_incoming_lineage_existence(self):
        c = _degree_compiler()
        where = c.compile(HasIncomingPredicate(edgeClass="lineage"))
        # Bare pattern existence — no size(), no NOT.
        assert where.startswith("(n)<-[:")
        assert "size(" not in where
        assert "NOT" not in where

    def test_has_outgoing_lineage_existence(self):
        c = _degree_compiler()
        where = c.compile(HasOutgoingPredicate(edgeClass="lineage"))
        assert where.startswith("(n)-[:")
        assert "->()" in where
        assert "size(" not in where
        assert "NOT" not in where

    def test_degree_in_gt_zero_collapses_to_existence(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="in", op="gt", value=0,
                                          edgeClass="lineage"))
        assert where.startswith("(n)<-[:")
        assert "size(" not in where

    def test_degree_in_gte_one_collapses_to_existence(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="in", op="gte", value=1,
                                          edgeClass="lineage"))
        assert where.startswith("(n)<-[:")
        assert "size(" not in where

    def test_degree_in_neq_zero_collapses_to_existence(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="in", op="neq", value=0,
                                          edgeClass="lineage"))
        assert where.startswith("(n)<-[:")
        assert "size(" not in where

    def test_degree_both_eq_zero(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="both", op="eq", value=0,
                                          edgeClass="lineage"))
        # Both absent ⇒ (NOT in AND NOT out)
        assert "NOT (n)<-[:" in where
        assert "NOT (n)-[:" in where
        assert "size(" not in where

    def test_degree_both_gt_zero_existence_either_side(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="both", op="gt", value=0,
                                          edgeClass="lineage"))
        # Either incoming OR outgoing edge exists ⇒ (in OR out)
        assert "(n)<-[:" in where
        assert "(n)-[:" in where
        assert " OR " in where
        assert "size(" not in where

    # -- NOT-wrapped (the user's reported 503 case) --------------------

    def test_not_has_incoming_compiles_without_size(self):
        """The user's specific 503 case. Before the fix this emitted
        `NOT (size((n)<-[:...]-()) > 0)`, which FalkorDB rejects with
        'Unable to resolve filtered alias'."""
        c = _degree_compiler()
        where = c.compile(GroupPredicate(op="not", children=[
            HasIncomingPredicate(edgeClass="lineage"),
        ]))
        assert "size(" not in where
        # The NOT wraps a bare pattern, not a size() call.
        assert "NOT" in where and "(n)<-[:" in where

    def test_not_has_outgoing_compiles_without_size(self):
        c = _degree_compiler()
        where = c.compile(GroupPredicate(op="not", children=[
            HasOutgoingPredicate(edgeClass="lineage"),
        ]))
        assert "size(" not in where
        assert "NOT" in where and "(n)-[:" in where

    # -- non-trivial counts (size() still used) ------------------------

    def test_degree_in_gt_five_uses_size(self):
        """Counts > 1 still go through size(). FalkorDB may reject this
        if NOT-wrapped, but it's the only correct compilation for
        non-threshold counts; users hitting this need a backend fix that
        rewrites to a list-comprehension. Documented in the compiler."""
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="in", op="gt", value=5,
                                          edgeClass="lineage"))
        assert "size(" in where
        assert "> $p0" in where

    def test_degree_in_eq_three_uses_size(self):
        c = _degree_compiler()
        where = c.compile(DegreePredicate(direction="in", op="eq", value=3,
                                          edgeClass="lineage"))
        assert "size(" in where
        assert "= $p0" in where

    # -- empty edge-type set short-circuits ----------------------------

    def test_orphan_with_no_lineage_types_is_true(self):
        c = _Compiler(lineage_edge_types=set(), containment_edge_types={"CONTAINS"})
        where = c.compile(IsOrphanPredicate(edgeClass="lineage"))
        assert where == "true"

    def test_has_incoming_with_no_lineage_types_is_false(self):
        c = _Compiler(lineage_edge_types=set(), containment_edge_types={"CONTAINS"})
        where = c.compile(HasIncomingPredicate(edgeClass="lineage"))
        assert where == "false"


class TestCompilerPath:
    """PathPredicate hoists out of the WHERE fragment and stashes its
    parameters on the compiler — the executor then runs a separate
    path-matching Cypher instead of the standard candidate scan.
    """

    def test_top_level_hoists_and_returns_true(self):
        c = _degree_compiler()
        where = c.compile(PathPredicate(
            source_urns=["urn:a"],
            target_urns=["urn:b"],
            edgeClass="lineage",
        ))
        assert where == "true"
        assert c.hoisted_path is not None
        assert c.hoisted_path["source_urns"] == ["urn:a"]
        assert c.hoisted_path["target_urns"] == ["urn:b"]
        assert c.hoisted_path["direction"] == "outgoing"
        assert set(c.hoisted_path["edge_types"]) == _LINEAGE_EDGE_TYPES
        assert c.hoisted_path["max_hops"] == 4
        assert c.hoisted_path["max_paths"] == 32

    def test_inside_or_raises(self):
        c = _degree_compiler()
        with pytest.raises(CompileError, match="top-level AND"):
            c.compile(GroupPredicate(op="or", children=[
                PathPredicate(source_urns=["urn:a"], target_urns=["urn:b"]),
                TagPredicate(values=["PII"]),
            ]))

    def test_inside_not_raises(self):
        c = _degree_compiler()
        with pytest.raises(CompileError, match="top-level AND"):
            c.compile(GroupPredicate(op="not", children=[
                PathPredicate(source_urns=["urn:a"], target_urns=["urn:b"]),
            ]))

    def test_multiple_paths_raise(self):
        c = _degree_compiler()
        with pytest.raises(CompileError, match="Only one Path"):
            c.compile(GroupPredicate(op="and", children=[
                PathPredicate(source_urns=["urn:a"], target_urns=["urn:b"]),
                PathPredicate(source_urns=["urn:c"], target_urns=["urn:d"]),
            ]))

    def test_explicit_edge_types_override_class(self):
        c = _degree_compiler()
        c.compile(PathPredicate(
            source_urns=["urn:a"],
            target_urns=["urn:b"],
            edgeClass="lineage",
            edgeTypes=["TRANSFORMS"],
        ))
        # Explicit list wins over the resolved class set
        assert c.hoisted_path["edge_types"] == ["TRANSFORMS"]

    def test_incoming_direction_stored(self):
        c = _degree_compiler()
        c.compile(PathPredicate(
            source_urns=["urn:a"],
            target_urns=["urn:b"],
            direction="incoming",
        ))
        assert c.hoisted_path["direction"] == "incoming"

    def test_path_cypher_outgoing(self):
        from backend.app.providers.falkordb_deep_search import _build_path_cypher
        cy = _build_path_cypher(direction="outgoing", max_hops=4)
        # Direction-aware pattern, edge filter is in WHERE not in the
        # pattern (avoids the "filtered alias" FalkorDB issue).
        assert "(s)-[*1..4]->(t)" in cy
        assert "type(rel) IN $_pathEdgeTypes" in cy

    def test_path_cypher_incoming(self):
        from backend.app.providers.falkordb_deep_search import _build_path_cypher
        cy = _build_path_cypher(direction="incoming", max_hops=3)
        assert "(s)<-[*1..3]-(t)" in cy

    def test_path_cypher_any(self):
        from backend.app.providers.falkordb_deep_search import _build_path_cypher
        cy = _build_path_cypher(direction="any", max_hops=2)
        # Undirected variable-length pattern
        assert "(s)-[*1..2]-(t)" in cy


class TestCompilerGroups:
    def test_and(self):
        c = _Compiler()
        where = c.compile(GroupPredicate(op="and", children=[
            TagPredicate(values=["PII"]),
            PropertyPredicate(key="logicalType", op="eq", value="STRING"),
        ]))
        assert where == (
            "((n.tags CONTAINS $p0) AND toLower(toString(n.`logicalType`)) = $p1)"
        )
        assert c.params == {"p0": '"PII"', "p1": "string"}

    def test_or(self):
        # ``target='name'`` now expands to a two-field OR (see
        # ``test_text_substring_case_insensitive``), so an OR group
        # containing it has the expanded shape nested inside the
        # outer OR.
        c = _Compiler()
        where = c.compile(GroupPredicate(op="or", children=[
            TextPredicate(value="x", target="name", match="exact"),
            HasPropertyPredicate(key="foo"),
        ]))
        assert where == (
            "((toLower(toString(n.displayName)) = $p0"
            " OR toLower(toString(n.qualifiedName)) = $p0)"
            " OR EXISTS(n.`foo`))"
        )

    def test_not(self):
        c = _Compiler()
        where = c.compile(GroupPredicate(op="not", children=[
            TagPredicate(values=["public"]),
        ]))
        assert where == "NOT ((n.tags CONTAINS $p0))"

    def test_descendant_of_top_level_hoisted(self):
        # DescendantOf at the top-level AND compiles to TRUE; the URNs
        # are stashed on the compiler for the caller to merge into scope.
        c = _Compiler()
        where = c.compile(GroupPredicate(op="and", children=[
            DescendantOfPredicate(urns=["urn:domain:A", "urn:domain:B"]),
            PropertyPredicate(key="logicalType", op="eq", value="STRING"),
        ]))
        assert where == "(true AND toLower(toString(n.`logicalType`)) = $p0)"
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
# Visible-mode + DescendantOf compose (regression for the bug where the
# scope-continuation was silently dropped when visible_urns was supplied,
# making "Visible nodes" + Root-in-view return the full visible set
# instead of the visible∩subtree intersection)
# ---------------------------------------------------------------------------

class _StubScopeProvider:
    """Minimal provider stub for explain_deep_search shape tests.

    The explain pipeline reads three things off the provider:
      * ``_get_lineage_edge_types()`` — used by _Compiler for degree
        predicates; unused here but required by _build_compiler_for_provider.
      * ``_get_containment_edge_types()`` — drives the scope-continuation
        edge type.
      * ``_entity_type_levels`` — drives _resolve_entity_types_scope's
        default-to-live behaviour.
    """
    _entity_type_levels = {"dataset": 0, "container": 0}

    def _get_lineage_edge_types(self):
        return {"PRODUCES"}

    def _get_containment_edge_types(self):
        return {"CONTAINS"}


class TestVisibleModeWithDescendantOf:
    def test_visible_with_descendantof_emits_both_clauses(self):
        """The fix: when both visible_urns AND a top-level descendantOf
        are present, the executor must AND the visible clause and the
        scope continuation. Previously the continuation was silently
        skipped because of a guard that read 'not visible_clause_added'."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TagPredicate(values=["PII"]),
                DescendantOfPredicate(urns=["urn:reporting"]),
            ]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="visible",
                visible_urns=["urn:reporting", "urn:reporting.child"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        # Visible clause is in the candidate WHERE.
        assert "n.urn IN $_visibleUrns" in cypher
        # One scope continuation per hoisted URN set, indexed.
        assert "MATCH (root0)-[:CONTAINS*0..12]->(n)" in cypher
        assert "root0.urn IN $_scopeRootUrns0" in cypher
        assert result["params"]["_scopeRootUrns0"] == ["urn:reporting"]
        assert "urn:reporting" in result["params"]["_visibleUrns"]

    def test_visible_without_descendantof_emits_no_continuation(self):
        """Guard against over-applying the fix: visible-only queries
        keep their current shape (no scope continuation)."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=TagPredicate(values=["PII"]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="visible",
                visible_urns=["urn:a", "urn:b"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        assert "n.urn IN $_visibleUrns" in cypher
        assert "MATCH (root" not in cypher
        assert "_scopeRootUrns0" not in result["params"]

    def test_visible_empty_urns_with_descendantof_still_emits_continuation(self):
        """The pre-existing fallback path: visible mode + empty
        visible_urns + a descendantOf hoist → emit the scope
        continuation. This test guards the fallback from regressing
        as a side effect of dropping the 'not visible_clause_added'
        guard."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TagPredicate(values=["PII"]),
                DescendantOfPredicate(urns=["urn:reporting"]),
            ]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="visible",
                visible_urns=[],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        assert "n.urn IN $_visibleUrns" not in cypher
        assert "MATCH (root0)-[:CONTAINS*0..12]->(n)" in cypher
        assert "root0.urn IN $_scopeRootUrns0" in cypher
        assert result["params"]["_scopeRootUrns0"] == ["urn:reporting"]


class TestScopeChainSemantics:
    """The new scope-continuation chain: one MATCH per non-empty URN
    set (scope.root_urns + each hoisted DescendantOf set), AND'd via
    chained ``WITH DISTINCT n``. Replaces the old URN-set intersection
    in ``_effective_root_urns`` which produced empty results whenever
    the scope and the user's descendantOf anchor were nested (e.g. View
    root LayerA AND descendantOf=[ObjectInsideLayerA] → ∅).
    """

    def test_view_mode_nested_anchor_emits_two_matches(self):
        """View mode + scope.root_urns=[LayerA] + descendantOf=[ObjectX]
        previously produced an empty result (URN-set intersection ∅).
        Now: two MATCH continuations narrow n to descend from both."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TagPredicate(values=["PII"]),
                DescendantOfPredicate(urns=["urn:objectX"]),
            ]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="view",
                root_urns=["urn:layerA"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        assert cypher.count("MATCH (root") == 2
        assert "$_scopeRootUrns0" in cypher
        assert "$_scopeRootUrns1" in cypher
        assert result["params"]["_scopeRootUrns0"] == ["urn:layerA"]
        assert result["params"]["_scopeRootUrns1"] == ["urn:objectX"]

    def test_multiple_anded_descendant_of_each_gets_match(self):
        """Two top-level descendantOf predicates AND'd → two distinct
        MATCH continuations, AND'd via chained WITH DISTINCT n."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                DescendantOfPredicate(urns=["urn:a"]),
                DescendantOfPredicate(urns=["urn:b"]),
                TagPredicate(values=["PII"]),
            ]),
            scope=SearchScope(view_id="view_test", scope_mode="data_source"),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        # data_source mode contributes no scope.root_urns MATCH; two
        # hoisted descendantOf sets give two MATCHes.
        assert cypher.count("MATCH (root") == 2
        assert result["params"]["_scopeRootUrns0"] == ["urn:a"]
        assert result["params"]["_scopeRootUrns1"] == ["urn:b"]

    def test_data_source_mode_honours_descendant_of(self):
        """Pre-fix: data_source mode dropped scope.root_urns AND
        silently dropped hoisted descendantOf. Post-fix: the user's
        explicit anchor still applies — data_source only suppresses
        the view's authorised root URNs."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TagPredicate(values=["PII"]),
                DescendantOfPredicate(urns=["urn:anchor"]),
            ]),
            scope=SearchScope(view_id="view_test", scope_mode="data_source"),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        assert "MATCH (root0)" in cypher
        assert result["params"]["_scopeRootUrns0"] == ["urn:anchor"]

    def test_view_mode_without_descendant_of_still_emits_scope_match(self):
        """View mode + scope.root_urns + no hoisted descendantOf →
        exactly one MATCH continuation for scope.root_urns. Guards
        against regression where the chain builder skipped the
        scope-only case."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=TagPredicate(values=["PII"]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="view",
                root_urns=["urn:layerA"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        assert cypher.count("MATCH (root") == 1
        assert result["params"]["_scopeRootUrns0"] == ["urn:layerA"]

    def test_scope_match_precedes_candidate_limit(self):
        """Correctness: the scope MATCH must PRECEDE ``WITH n LIMIT``, so
        the candidate cap bounds the IN-SCOPE set — not a graph-wide
        prefix. The old post-filter shape appended the scope MATCH AFTER
        the cap, which silently dropped in-scope matches whenever a broad
        predicate filled the cap graph-wide before the scope clamp ran.

        This is the structural proof of the layer-search scale fix: a
        layer search whose predicate matches thousands of nodes graph-wide
        but only a handful inside the layer must return all of the handful.
        """
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=TagPredicate(values=["PII"]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="view",
                root_urns=["urn:layerA"],
            ),
        )
        cypher = explain_deep_search(_StubScopeProvider(), q)["cypher"]
        scope_pos = cypher.index("MATCH (root0)")
        limit_pos = cypher.index("WITH n LIMIT")
        assert scope_pos < limit_pos, (
            "scope MATCH must precede the candidate LIMIT so the cap "
            f"applies to in-scope nodes; got: {cypher}"
        )
        # No post-filter scope MATCH survives after the cap.
        assert "MATCH (root" not in cypher[limit_pos:]


# ---------------------------------------------------------------------------
# Entity types must not gate the candidate scan when a containment
# traversal already bounds it (the curated-view case: the layers declare
# only container types, and the node the user is looking for is a
# descendant three levels down with a different type)
# ---------------------------------------------------------------------------

class TestTypesDoNotGateDescendants:
    def test_roots_present_omits_label_filter(self):
        """A view whose layers declare ``Table`` stamps that into
        ``scope.entity_types``. Emitting it as a label filter on the
        candidate scan makes every descendant of another type (a
        ``Column``) unfindable. The traversal from the roots is already
        the boundary, so the type filter is dropped."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=TagPredicate(values=["PII"]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="view",
                root_urns=["urn:layerA"],
                entity_types=["dataset"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        assert "MATCH (root0)" in cypher
        assert "$_scopeEntityTypes" not in cypher
        assert "_scopeEntityTypes" not in result["params"]
        assert any(
            "entity-type filter not applied" in n for n in result["notes"]
        ), result["notes"]

    def test_no_roots_keeps_label_filter(self):
        """No traversal boundary → the label filter is the only thing
        bounding the candidate scan, so it stays."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=TagPredicate(values=["PII"]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="view",
                entity_types=["dataset"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        assert "MATCH (root" not in result["cypher"]
        assert "$_scopeEntityTypes" in result["cypher"]
        assert result["params"]["_scopeEntityTypes"] == ["dataset"]

    def test_hoisted_descendant_of_also_suppresses_types(self):
        """``data_source`` mode drops the view-root clamp, but an explicit
        ``descendantOf`` anchor is still a containment boundary — the
        types must not gate the scan under it either."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=GroupPredicate(op="and", children=[
                TagPredicate(values=["PII"]),
                DescendantOfPredicate(urns=["urn:reporting"]),
            ]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="data_source",
                entity_types=["dataset"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        assert "MATCH (root0)" in result["cypher"]
        assert "$_scopeEntityTypes" not in result["cypher"]
        assert "_scopeEntityTypes" not in result["params"]

    def test_visible_urns_omit_label_filter(self):
        """An explicit URN allow-list is a boundary just like a traversal:
        the FE has already resolved exactly which nodes are in play, so a
        label filter on top can only subtract from a set the user can see.
        (``_maybe_add_visible_urns_clause``'s own docstring says the
        visible filter replaces the entity-type label scan — this is the
        code catching up with it.)"""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=TagPredicate(values=["PII"]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="visible",
                visible_urns=["urn:a"],
                entity_types=["dataset"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        cypher = result["cypher"]
        assert "n.urn IN $_visibleUrns" in cypher
        assert "$_scopeEntityTypes" not in cypher
        assert "_scopeEntityTypes" not in result["params"]
        assert any(
            "the visible-URN list is the search boundary" in n
            for n in result["notes"]
        ), result["notes"]

    def test_visible_mode_without_urns_keeps_label_filter(self):
        """Empty ``visible_urns`` injects no clause — the mode falls back
        to view semantics, so there is no boundary and the types stay."""
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        q = SearchQuery(
            predicate=TagPredicate(values=["PII"]),
            scope=SearchScope(
                view_id="view_test",
                scope_mode="visible",
                visible_urns=[],
                entity_types=["dataset"],
            ),
        )
        result = explain_deep_search(_StubScopeProvider(), q)
        assert "$_visibleUrns" not in result["cypher"]
        assert "$_scopeEntityTypes" in result["cypher"]
        assert result["params"]["_scopeEntityTypes"] == ["dataset"]


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
        # Multi-label-safe + case-insensitive shape — catches every
        # label whatever its case (label drift between ontology IDs and
        # ingested data is silently corrected).
        assert "WHERE ANY(l IN labels(n) WHERE toLower(l) IN $_scopeEntityTypes)" in cypher
        assert " AND true" not in cypher

    def test_with_scope_continuation(self):
        # ``*0..D`` (not ``*1..D``) — the root URNs themselves count
        # as in-scope matches. Previously ``*1..D`` silently excluded
        # any node that IS a root, which made "View" scope mode
        # strictly more restrictive than "Visible" mode for top-level
        # containers the user can see on the canvas.
        cypher = _build_candidate_cypher(
            where_fragment="n.x = $p0",
            entity_types_param=False,
            scope_continuation=(
                "MATCH (root)-[:CONTAINS*0..12]->(n) "
                "WHERE root.urn IN $_rootUrns WITH DISTINCT n"
            ),
            candidate_cap=CANDIDATE_CAP,
        )
        assert cypher.endswith(
            f"WITH n LIMIT {CANDIDATE_CAP} "
            f"MATCH (root)-[:CONTAINS*0..12]->(n) "
            f"WHERE root.urn IN $_rootUrns WITH DISTINCT n"
        )

    def test_with_scope_pre_filter_replaces_match_n(self):
        """W1.1b: when ``scope_pre_filter`` is provided, the candidate
        prefix is the root-anchored MATCH instead of ``MATCH (n)``.
        ``scope_continuation`` must be empty in this shape (pre-filter
        already enforces the scope clamp)."""
        cypher = _build_candidate_cypher(
            where_fragment="n.tags CONTAINS '\"PII\"'",
            entity_types_param=False,
            scope_continuation="",
            candidate_cap=CANDIDATE_CAP,
            scope_pre_filter=(
                "MATCH (root)-[:CONTAINS*0..12]->(n) "
                "WHERE root.urn IN $_rootUrns WITH DISTINCT n"
            ),
        )
        assert cypher.startswith("MATCH (root)-[:CONTAINS*0..12]->(n)")
        # No bare ``MATCH (n)`` prefix in this shape.
        assert "MATCH (n) WHERE" not in cypher
        assert "n.tags CONTAINS" in cypher
        assert f"WITH n LIMIT {CANDIDATE_CAP}" in cypher


# ---------------------------------------------------------------------------
# Entity-type scope resolution against live ontology
# ---------------------------------------------------------------------------

class _StubProvider:
    """Minimal stand-in for the provider in ``_resolve_entity_types_scope``.
    The function only reads ``_entity_type_levels`` so a duck-typed shim
    is enough."""

    def __init__(self, levels: dict):
        self._entity_type_levels = levels


class TestEntityTypesScopeResolution:
    """``_resolve_entity_types_scope`` reconciles the view's stale
    entity-type list against what the data source's resolved ontology
    actually contains. This is the fix for the production bug where a
    view was created against a default 17-type ontology snapshot but
    the live data source only has e.g. ``object`` nodes — the original
    code blackholed every search by AND-ing two disjoint label sets."""

    def test_empty_request_defaults_to_live_ontology(self):
        """W1.1b: empty entity_types defaults to the live ontology so the
        candidate scan is bounded by all known labels rather than
        running ``MATCH (n)`` unfiltered."""
        provider = _StubProvider({"dataset": 0, "schemaField": 1})
        effective, note = _resolve_entity_types_scope(provider, [])
        assert effective == ["dataset", "schemaField"]
        assert note is not None
        assert "defaulted" in note

    def test_empty_request_skips_filter_when_no_live_ontology(self):
        """Edge case: provider hasn't introspected its ontology yet.
        No fallback set is available, so we return None (caller logs a
        'no scope clamp' diagnostic)."""
        provider = _StubProvider({})
        effective, note = _resolve_entity_types_scope(provider, [])
        assert effective is None
        assert note is None

    def test_full_overlap_passes_through(self):
        provider = _StubProvider({"dataset": 0, "schemaField": 1})
        effective, note = _resolve_entity_types_scope(
            provider, ["dataset", "schemaField"],
        )
        assert effective == ["dataset", "schemaField"]
        assert note is None

    def test_partial_overlap_narrows_and_notes(self):
        # View asks for [dataset, schemaField, nonexistent]; data source
        # only has [dataset, schemaField]. The filter narrows to the
        # overlap and a diagnostic note flags the dropped type(s).
        provider = _StubProvider({"dataset": 0, "schemaField": 1})
        effective, note = _resolve_entity_types_scope(
            provider, ["dataset", "schemaField", "nonexistent"],
        )
        assert effective == ["dataset", "schemaField"]
        assert note is not None
        assert "nonexistent" in note

    def test_zero_overlap_silently_substitutes_live_ontology(self):
        # The production bug: view scope says ["dataset", "schemaField",
        # …17 defaults] but the actual data source has only ["object"].
        # The intersection is empty. We SILENTLY substitute the live
        # ontology (so the search stays type-scoped per the view's
        # intent) and emit NO diagnostic — this is normal operation
        # for views auto-created against a default ontology snapshot.
        provider = _StubProvider({
            "attribute": 0, "group": 1, "layer": 2, "object": 3,
        })
        effective, note = _resolve_entity_types_scope(
            provider,
            [
                "app", "chart", "column", "container", "dashboard",
                "dataFlow", "dataJob", "dataPlatform", "dataset",
                "domain", "glossaryTerm", "pipeline", "report",
                "schema", "schemaField", "system", "tag",
            ],
        )
        # Substituted to the live ontology, sorted for determinism.
        assert effective == ["attribute", "group", "layer", "object"]
        # No diagnostic note — silent corrective behaviour.
        assert note is None

    def test_provider_without_resolved_ontology_trusts_request(self):
        # Provider hasn't introspected yet (empty _entity_type_levels).
        # Trust the request as the only signal we have.
        provider = _StubProvider({})
        effective, note = _resolve_entity_types_scope(
            provider, ["dataset", "schemaField"],
        )
        assert effective == ["dataset", "schemaField"]
        assert note is None

    def test_provider_missing_attribute_trusts_request(self):
        # Defensively handle providers that never set _entity_type_levels
        # (older code paths / stub providers in tests).
        class _NoAttrProvider:
            pass

        effective, note = _resolve_entity_types_scope(
            _NoAttrProvider(), ["dataset"],
        )
        assert effective == ["dataset"]
        assert note is None


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
        q1 = SearchQuery(predicate=TagPredicate(values=["PII"]), scope=_TEST_SCOPE)
        q2 = SearchQuery(predicate=TagPredicate(values=["PII"]), scope=_TEST_SCOPE)
        assert query_hash(q1) == query_hash(q2)

    def test_query_hash_changes_with_predicate(self):
        q1 = SearchQuery(predicate=TagPredicate(values=["PII"]), scope=_TEST_SCOPE)
        q2 = SearchQuery(predicate=TagPredicate(values=["GDPR"]), scope=_TEST_SCOPE)
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
            scope=_TEST_SCOPE,
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
        # Critical assertions: pivots on n.`layer`, filters out nulls, uses GROUP BY.
        # Property keys are backtick-quoted by ``_safe_property_name``.
        assert "WHERE EXISTS(n.`layer`)" in cypher
        assert "WITH n.`layer` AS pkey, n" in cypher
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

    def test_property_name_injection_neutralised_by_backticks(self):
        # Property names are interpolated into the Cypher (they can't
        # be parameterised). Injection is prevented by Cypher's
        # backtick-quoting (see ``_safe_property_name``): the whole
        # supplied string becomes one identifier inside backticks,
        # so semicolons/parens never reach the Cypher parser as
        # syntax. The aggregation path uses the same helper as the
        # predicate compiler, so calling it with a hostile name no
        # longer raises CompileError — instead it would issue a
        # safely-quoted query (which the test's stub backend
        # accepts without doing anything destructive).
        import asyncio
        from backend.app.providers.falkordb_deep_search import (
            _run_aggregation_property,
        )

        async def go():
            # Pass None for the provider — the function will fail at
            # the first ``await provider.run_query`` (not at compile
            # time), proving compilation succeeded.
            await _run_aggregation_property(
                None, "x", {},
                AggregationSpec(by="property", propertyKey="x); DROP"),
                timeout_s=3.0,
            )

        # No longer raises CompileError on compilation; failure (if
        # any) comes later from the None provider. The whole point
        # of this assertion is: compilation MUST succeed for hostile
        # property names because backticks neutralise the threat.
        try:
            asyncio.run(go())
        except CompileError as e:
            raise AssertionError(
                f"compile should succeed for backtick-quoted names: {e}"
            )
        except Exception:
            # Any non-CompileError exception is fine — it confirms
            # we got past compilation. The None provider can't
            # actually execute the query.
            pass

    @pytest.mark.asyncio
    async def test_aggregation_property_with_spaces(self):
        """Per-call-site coverage: the aggregation pivot (compile
        site at falkordb_deep_search.py line ~2147) accepts a
        property key with spaces. Uses the same capturing-provider
        pattern as the layer-aggregation happy-path test so we can
        assert on the EXACT compiled Cypher and verify both
        ``EXISTS(n.\`Asset Owner\`)`` and ``n.\`Asset Owner\` AS pkey``
        appear correctly. Without backtick quoting the raw
        ``n.Asset Owner`` would be a Cypher syntax error."""
        import asyncio  # noqa: F401  (kept for parity with the sibling test)

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
            by="property", propertyKey="Asset Owner",
            maxBuckets=20, sampleHitsPerBucket=3,
        )
        cand_cypher = "MATCH (n) WHERE n.tags CONTAINS $p0 WITH n LIMIT 5000"
        await _run_aggregation_property(
            prov, cand_cypher, {"p0": '"PII"'}, spec, timeout_s=3.0,
        )
        assert len(prov.calls) == 1
        cypher = prov.calls[0][0]
        # Both the EXISTS guard AND the WITH pivot must use the
        # backtick-quoted form. If either site bypassed
        # ``_safe_property_name``, FalkorDB would reject the query
        # with a syntax error on the bare space.
        assert "WHERE EXISTS(n.`Asset Owner`)" in cypher
        assert "WITH n.`Asset Owner` AS pkey, n" in cypher


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
            scope=_TEST_SCOPE,
            options={  # type: ignore[arg-type]
                "sortProperty": "rowCount", "sortDir": "desc",
                "pageSize": 10,
            },
        )
        hits, _, _, _ = _build_hits_from_rows(_MockProv(), rows, q)
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
            scope=_TEST_SCOPE,
            options={  # type: ignore[arg-type]
                "sortProperty": "rowCount", "sortDir": "asc",
                "pageSize": 10,
            },
        )
        hits, _, _, _ = _build_hits_from_rows(_MockProv(), rows, q)
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
            scope=_TEST_SCOPE,
            options={  # type: ignore[arg-type]
                "sortProperty": "rowCount", "sortDir": "desc",
                "pageSize": 10,
            },
        )
        hits, _, _, _ = _build_hits_from_rows(_MockProv(), rows, q)
        # All three returned; missing-rowCount node grouped consistently
        assert len(hits) == 3
        urns_with_value = [h.node.urn for h in hits if h.node.properties.get("rowCount") is not None]
        assert urns_with_value == ["urn:c", "urn:a"]  # 500, 100 desc


# ---------------------------------------------------------------------------
# Cursor pagination — backend-driven paging for the panel's single-shot
# matchUrnSet round-trip + AI-agent iteration. The codec itself is
# round-tripped in TestCursor above; these tests pin the slice/offset
# semantics inside ``_build_hits_from_rows``.
# ---------------------------------------------------------------------------

class TestCursorPagination:
    @staticmethod
    def _mock_rows(n: int):
        from backend.common.models.graph import GraphNode
        return [
            GraphNode(urn=f"urn:{i:03d}", entityType="dataset",
                      displayName=f"node-{i:03d}")
            for i in range(n)
        ]

    @staticmethod
    def _mock_prov():
        class _MockProv:
            def _extract_node_from_result(self, n):
                return n
        return _MockProv()

    @staticmethod
    def _query(page_size: int, cursor=None):
        opts = {"sort": "displayName", "sortDir": "asc",
                "pageSize": page_size}
        if cursor is not None:
            opts["cursor"] = cursor
        return SearchQuery(
            predicate=TagPredicate(values=["x"]),
            scope=_TEST_SCOPE,
            options=opts,  # type: ignore[arg-type]
        )

    def test_first_page_no_cursor_starts_at_zero(self):
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = self._mock_rows(30)
        hits, offset_after, total, _ = _build_hits_from_rows(
            self._mock_prov(), rows, self._query(page_size=10),
        )
        assert [h.node.urn for h in hits] == [f"urn:{i:03d}" for i in range(10)]
        assert offset_after == 10
        assert total == 30

    def test_cursor_round_trip_advances_offset(self):
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = self._mock_rows(30)
        # Page 1
        page1, off1, _, _ = _build_hits_from_rows(
            self._mock_prov(), rows, self._query(page_size=10),
        )
        # Encode the next-cursor the way execute_deep_search does
        cursor = encode_cursor({"offset": off1, "q": "irrelevant"})
        # Page 2
        page2, off2, _, _ = _build_hits_from_rows(
            self._mock_prov(), rows,
            self._query(page_size=10, cursor=cursor),
        )
        assert [h.node.urn for h in page2] == [f"urn:{i:03d}" for i in range(10, 20)]
        assert off2 == 20
        # No overlap between page 1 and page 2 URNs
        assert not (set(h.node.urn for h in page1)
                    & set(h.node.urn for h in page2))

    def test_final_page_exhausts_candidate_set(self):
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = self._mock_rows(30)
        cursor = encode_cursor({"offset": 20})
        page, off, total, _ = _build_hits_from_rows(
            self._mock_prov(), rows,
            self._query(page_size=10, cursor=cursor),
        )
        # Last page is full but exhausts the set: caller will see
        # offset_after == total_sorted and emit cursor=None.
        assert len(page) == 10
        assert off == 30
        assert total == 30
        assert off == total  # the caller's "stop" signal

    def test_cursor_beyond_end_returns_empty_page(self):
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = self._mock_rows(30)
        cursor = encode_cursor({"offset": 30})
        page, off, total, _ = _build_hits_from_rows(
            self._mock_prov(), rows,
            self._query(page_size=10, cursor=cursor),
        )
        assert page == []
        assert off == 30
        assert total == 30

    def test_changed_pagesize_mid_iteration_uses_offset_only(self):
        # The cursor stores ``offset`` only — page size is read from the
        # current request, so a caller can re-tune mid-iteration without
        # the cursor going stale.
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = self._mock_rows(30)
        # Page 1 with size 5
        _, off1, _, _ = _build_hits_from_rows(
            self._mock_prov(), rows, self._query(page_size=5),
        )
        assert off1 == 5
        # Page 2 with bumped-up size 15 — should slice [5:20]
        cursor = encode_cursor({"offset": off1})
        page2, off2, _, _ = _build_hits_from_rows(
            self._mock_prov(), rows,
            self._query(page_size=15, cursor=cursor),
        )
        assert [h.node.urn for h in page2] == [f"urn:{i:03d}" for i in range(5, 20)]
        assert off2 == 20

    def test_negative_offset_clamped_to_zero(self):
        # Defensive: a hand-crafted cursor with a negative offset
        # shouldn't slice from the end of the list (Python's [-n:] would).
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = self._mock_rows(10)
        cursor = encode_cursor({"offset": -5})
        page, off, total, _ = _build_hits_from_rows(
            self._mock_prov(), rows,
            self._query(page_size=10, cursor=cursor),
        )
        assert [h.node.urn for h in page] == [f"urn:{i:03d}" for i in range(10)]
        assert off == 10
        assert total == 10

    def test_pagesize_5000_accepted(self):
        # The strategic-fix's central knob: callers can ask for the full
        # candidate cap in one round-trip so canvas highlighting covers
        # every match.
        opts = SearchOptions(pageSize=5000)  # type: ignore[call-arg]
        assert opts.page_size == 5000

    def test_pagesize_above_ceiling_rejected(self):
        from pydantic import ValidationError as PydValidationError
        with pytest.raises(PydValidationError):
            SearchOptions(pageSize=5001)  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Edge predicates inside Path / WithinHops
# ---------------------------------------------------------------------------

class TestEdgePredicateModel:
    """Model construction + JSON round-trip for the new edge-predicate
    types and their hosting inside Path / WithinHops."""

    def test_path_carries_edge_property(self):
        from backend.common.models.search import EdgePropertyPredicate
        pp = PathPredicate(
            source_urns=["urn:a"], target_urns=["urn:b"],
            edge_predicate=EdgePropertyPredicate(
                key="confidence", op="gt", value=0.9,
            ),
        )
        assert pp.edge_predicate.kind == "edgeProperty"
        assert pp.edge_predicate.op == "gt"
        # JSON round-trip preserves the subtree
        rt = PathPredicate.model_validate_json(pp.model_dump_json(by_alias=True))
        assert rt.edge_predicate.value == 0.9

    def test_path_carries_nested_edge_group(self):
        pp = PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {
                "kind": "edgeGroup", "op": "and",
                "children": [
                    {"kind": "edgeProperty", "key": "weight",
                     "op": "between", "value": [0.1, 0.9]},
                    {"kind": "edgeHasProperty", "key": "verified"},
                ],
            },
        })
        assert pp.edge_predicate.kind == "edgeGroup"
        assert len(pp.edge_predicate.children) == 2

    def test_withinhops_default_edge_class_is_lineage(self):
        wh = WithinHopsPredicate(urns=["urn:a"], hops=2)
        # Newly added field — defaults to "lineage" to make `edge_types`
        # optional in the same way DegreePredicate / PathPredicate do.
        assert wh.edge_class == "lineage"

    def test_withinhops_carries_edge_predicate(self):
        wh = WithinHopsPredicate.model_validate({
            "urns": ["urn:a"], "hops": 3,
            "edgePredicate": {"kind": "edgeProperty",
                              "key": "weight", "op": "gte", "value": 0.5},
        })
        assert wh.edge_predicate.key == "weight"


class TestEdgePredicateCompile:
    """The compiler emits Cypher fragments evaluated against ``rel`` for
    each edge predicate kind, and the path / hops query builders inject
    them into ALL(rel IN relationships(p) WHERE …) blocks."""

    def test_edge_property_eq(self):
        c = _degree_compiler()
        # Compose via PathPredicate so the compiler is fully exercised.
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {"kind": "edgeProperty",
                              "key": "confidence", "op": "eq", "value": 0.5},
        }))
        # Edge property keys are backtick-quoted by ``_safe_property_name``
        # exactly like node property keys — same safety story.
        assert c.hoisted_path["edge_where"] == "rel.`confidence` = $p0"
        assert c.params == {"p0": 0.5}

    def test_edge_property_predicate_with_spaces(self):
        """Per-call-site coverage: EdgePropertyPredicate (compile
        site at falkordb_deep_search.py line ~650). Edge properties
        with spaces — e.g. ``Edge Weight`` from a Looker / Tableau
        export — must work the same as node properties."""
        c = _degree_compiler()
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {"kind": "edgeProperty",
                              "key": "Edge Weight", "op": "eq",
                              "value": 0.5},
        }))
        assert c.hoisted_path["edge_where"] == "rel.`Edge Weight` = $p0"
        assert c.params == {"p0": 0.5}

    def test_edge_property_between(self):
        c = _degree_compiler()
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {"kind": "edgeProperty",
                              "key": "weight", "op": "between",
                              "value": [0.1, 0.9]},
        }))
        assert c.hoisted_path["edge_where"] == \
            "(rel.`weight` >= $p0 AND rel.`weight` <= $p1)"

    def test_edge_property_between_invalid_raises(self):
        from backend.common.models.search import EdgePropertyPredicate
        c = _degree_compiler()
        with pytest.raises(CompileError, match="value=\\[lo, hi\\]"):
            c.compile(PathPredicate(
                source_urns=["urn:a"], target_urns=["urn:b"],
                edge_predicate=EdgePropertyPredicate(
                    key="w", op="between", value=0.5,  # scalar, not list
                ),
            ))

    def test_edge_has_property(self):
        c = _degree_compiler()
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {"kind": "edgeHasProperty",
                              "key": "verified"},
        }))
        assert c.hoisted_path["edge_where"] == "EXISTS(rel.`verified`)"

    def test_edge_has_property_negate(self):
        c = _degree_compiler()
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {"kind": "edgeHasProperty",
                              "key": "verified", "negate": True},
        }))
        assert c.hoisted_path["edge_where"] == "NOT (EXISTS(rel.`verified`))"

    def test_edge_has_property_predicate_with_spaces(self):
        """Per-call-site coverage: EdgeHasPropertyPredicate (compile
        site at falkordb_deep_search.py line ~683). Edge attributes
        like ``Last Verified`` (timestamp) need the same backtick
        treatment as node properties — common in lineage edges
        annotated with audit timestamps."""
        c = _degree_compiler()
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {"kind": "edgeHasProperty",
                              "key": "Last Verified"},
        }))
        assert c.hoisted_path["edge_where"] == "EXISTS(rel.`Last Verified`)"

    def test_edge_group_and(self):
        c = _degree_compiler()
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {
                "kind": "edgeGroup", "op": "and",
                "children": [
                    {"kind": "edgeProperty", "key": "confidence",
                     "op": "gt", "value": 0.9},
                    {"kind": "edgeHasProperty", "key": "producedBy"},
                ],
            },
        }))
        assert c.hoisted_path["edge_where"] == \
            "(rel.`confidence` > $p0 AND EXISTS(rel.`producedBy`))"

    def test_edge_group_or(self):
        c = _degree_compiler()
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {
                "kind": "edgeGroup", "op": "or",
                "children": [
                    {"kind": "edgeProperty", "key": "k1", "op": "eq", "value": 1},
                    {"kind": "edgeProperty", "key": "k2", "op": "eq", "value": 2},
                ],
            },
        }))
        assert "OR" in c.hoisted_path["edge_where"]

    def test_edge_group_not(self):
        c = _degree_compiler()
        c.compile(PathPredicate.model_validate({
            "sourceUrns": ["urn:a"], "targetUrns": ["urn:b"],
            "edgePredicate": {
                "kind": "edgeGroup", "op": "not",
                "children": [{"kind": "edgeHasProperty", "key": "stale"}],
            },
        }))
        assert c.hoisted_path["edge_where"] == "NOT (EXISTS(rel.`stale`))"

    def test_path_cypher_injects_edge_predicate(self):
        from backend.app.providers.falkordb_deep_search import _build_path_cypher
        cy = _build_path_cypher(
            direction="outgoing", max_hops=3,
            edge_where="rel.confidence > $p0",
        )
        # The edge predicate is AND-joined with the type filter inside
        # the single ALL(rel IN relationships(p) WHERE …) clause — keeps
        # us to one pass over the path's edges.
        assert (
            "ALL(rel IN relationships(p) WHERE type(rel) IN "
            "$_pathEdgeTypes AND (rel.confidence > $p0))"
        ) in cy

    def test_path_cypher_without_edge_predicate(self):
        # Regression: an empty edge_where leaves the existing Cypher
        # unchanged so callers that don't pass it see no behaviour shift.
        from backend.app.providers.falkordb_deep_search import _build_path_cypher
        cy = _build_path_cypher(direction="outgoing", max_hops=3, edge_where="")
        assert (
            "ALL(rel IN relationships(p) WHERE type(rel) IN "
            "$_pathEdgeTypes)"
        ) in cy
        assert " AND (" not in cy.split("ALL(rel IN")[1].split(")")[0]

    def test_within_hops_continuation_named_path(self):
        # When edge_predicate is present, the variable-length pattern
        # gets a path alias so per-edge filters can be applied.
        from backend.app.providers.falkordb_deep_search import (
            _build_within_hops_continuation,
        )
        c = _degree_compiler()
        c.compile(WithinHopsPredicate.model_validate({
            "urns": ["urn:a"], "hops": 2, "direction": "out",
            "edgePredicate": {"kind": "edgeProperty",
                              "key": "weight", "op": "gte", "value": 0.5},
        }))
        cont, _, _ = _build_within_hops_continuation(
            c.hoisted_within_hops, c._param_counter,
        )
        assert "_whP0 = (anchor)" in cont
        assert "ALL(rel IN relationships(_whP0) WHERE rel.`weight` >= $p0)" in cont

    def test_within_hops_continuation_no_edge_predicate(self):
        # Regression: legacy shape still produces no per-edge filter
        # block (the planner sees the same pattern as before).
        from backend.app.providers.falkordb_deep_search import (
            _build_within_hops_continuation,
        )
        c = _degree_compiler()
        c.compile(WithinHopsPredicate.model_validate({
            "urns": ["urn:a"], "hops": 2, "direction": "out",
            "edgeTypes": ["LINEAGE"],
        }))
        cont, _, _ = _build_within_hops_continuation(
            c.hoisted_within_hops, c._param_counter,
        )
        assert "ALL(rel IN" not in cont


# ---------------------------------------------------------------------------
# Batched ancestor hydration (W1.1c)
# ---------------------------------------------------------------------------

class TestHydrateAncestorsBatched:
    """``_hydrate_ancestors`` must batch the ancestor-summary fetch
    so a 1000-hit result with 50 unique ancestors doesn't fire 50
    sequential ``get_node`` calls. The provider exposes
    ``get_nodes_batch`` — this test asserts the hydration uses it."""

    @pytest.mark.asyncio
    async def test_uses_batched_node_fetch(self):
        from backend.app.providers.falkordb_deep_search import (
            _hydrate_ancestors,
        )
        from backend.common.models.search import SearchHit

        get_nodes_batch_call_count = 0
        get_node_call_count = 0

        # Six hits sharing two ancestors → ``needed_urns`` = 2 URNs.
        chains = {
            "urn:hit:1": ["urn:anc:a", "urn:anc:b"],
            "urn:hit:2": ["urn:anc:a", "urn:anc:b"],
            "urn:hit:3": ["urn:anc:a"],
            "urn:hit:4": ["urn:anc:b"],
            "urn:hit:5": [],
            "urn:hit:6": ["urn:anc:a"],
        }

        class _FakeAnc:
            def __init__(self, urn, display_name, entity_type):
                self.urn = urn
                self.display_name = display_name
                self.entity_type = entity_type

        class _StubProvider:
            async def _get_ancestor_chain(self, urn):
                return chains.get(urn, [])

            async def get_nodes_batch(self, urns):
                nonlocal get_nodes_batch_call_count
                get_nodes_batch_call_count += 1
                summaries = {
                    "urn:anc:a": _FakeAnc("urn:anc:a", "Ancestor A", "domain"),
                    "urn:anc:b": _FakeAnc("urn:anc:b", "Ancestor B", "container"),
                }
                return [summaries[u] for u in urns if u in summaries]

            async def get_node(self, urn):
                nonlocal get_node_call_count
                get_node_call_count += 1
                return None

        hits = [
            SearchHit(node={
                "urn": urn, "entityType": "dataset", "displayName": urn,
            }, score=1.0, matched_predicates=[], highlights=[],
                ancestor_path=[])
            for urn in chains
        ]

        await _hydrate_ancestors(_StubProvider(), hits)

        assert get_nodes_batch_call_count == 1, (
            f"expected exactly 1 batched ancestor-summary fetch; got "
            f"{get_nodes_batch_call_count}"
        )
        assert get_node_call_count == 0, (
            "per-URN get_node fallback must not run when batch path is wired"
        )
        # Every hit with a non-empty chain should have its ancestor_path
        # populated. chain ordering is parent→root in the input; the
        # hydrator reverses to root→parent.
        h1 = next(h for h in hits if h.node.urn == "urn:hit:1")
        assert [a.urn for a in h1.ancestor_path] == [
            "urn:anc:b", "urn:anc:a",
        ]
        h5 = next(h for h in hits if h.node.urn == "urn:hit:5")
        assert h5.ancestor_path == []

    @pytest.mark.asyncio
    async def test_no_op_on_empty_hit_list(self):
        from backend.app.providers.falkordb_deep_search import (
            _hydrate_ancestors,
        )

        class _UnusedProvider:
            async def _get_ancestor_chain(self, urn):  # pragma: no cover
                raise AssertionError("should not be called for empty hits")

            async def get_nodes_batch(self, urns):  # pragma: no cover
                raise AssertionError("should not be called for empty hits")

        # Should return cleanly without touching the provider.
        await _hydrate_ancestors(_UnusedProvider(), [])


class TestScopeRootUrnsCap:
    """Verify the env-tunable cap on ``SearchScope.root_urns``.

    Default is 5000 (raised from 256 for layer-scoped search — a large
    layer routinely has 1000+ top-level entities, and the FE now passes
    the layer's exact URN set as the authoritative scope). The cap is
    enforced by a Pydantic ``model_validator`` that reads
    ``DeepSearchSettings.scope_root_urns_cap`` at validation time.
    """

    def _clear_settings_cache(self):
        from backend.app.services.deep_search.settings import (
            get_deep_search_settings,
        )
        get_deep_search_settings.cache_clear()

    def test_default_cap_is_5000(self, monkeypatch):
        """At the default 5000, exactly 5000 URNs validates."""
        monkeypatch.delenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", raising=False)
        self._clear_settings_cache()
        from backend.common.models.search import SearchScope
        urns = [f"urn:c{i}" for i in range(5000)]
        scope = SearchScope(viewId="v1", rootUrns=urns)
        assert len(scope.root_urns) == 5000

    def test_default_cap_rejects_5001(self, monkeypatch):
        """One over the default cap raises with the cap value in the msg."""
        monkeypatch.delenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", raising=False)
        self._clear_settings_cache()
        from backend.common.models.search import SearchScope
        from pydantic import ValidationError as PydanticValidationError
        urns = [f"urn:c{i}" for i in range(5001)]
        with pytest.raises(PydanticValidationError, match="5000"):
            SearchScope(viewId="v1", rootUrns=urns)

    def test_env_override_raises_cap(self, monkeypatch):
        """DEEP_SEARCH_SCOPE_ROOT_URNS_CAP=500 lets 500 URNs through."""
        monkeypatch.setenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", "500")
        self._clear_settings_cache()
        from backend.common.models.search import SearchScope
        urns = [f"urn:c{i}" for i in range(500)]
        scope = SearchScope(viewId="v1", rootUrns=urns)
        assert len(scope.root_urns) == 500

    def test_env_override_lowers_cap(self, monkeypatch):
        """A view with a lower deploy-time cap rejects above-cap requests."""
        monkeypatch.setenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", "10")
        self._clear_settings_cache()
        from backend.common.models.search import SearchScope
        from pydantic import ValidationError as PydanticValidationError
        # 10 still passes.
        SearchScope(viewId="v1", rootUrns=[f"urn:{i}" for i in range(10)])
        # 11 fails with the lower cap in the message.
        with pytest.raises(PydanticValidationError, match="10"):
            SearchScope(viewId="v1", rootUrns=[f"urn:{i}" for i in range(11)])

    def test_twenty_roots_works(self, monkeypatch):
        """The user-reported scale (20 layers / containers) validates."""
        monkeypatch.delenv("DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", raising=False)
        self._clear_settings_cache()
        from backend.common.models.search import SearchScope
        urns = [f"urn:layer{i}" for i in range(20)]
        scope = SearchScope(viewId="v1", rootUrns=urns)
        assert len(scope.root_urns) == 20

    def test_empty_root_urns_accepted(self, monkeypatch):
        """Empty / None root URNs are not subject to the cap (no narrowing)."""
        self._clear_settings_cache()
        from backend.common.models.search import SearchScope
        SearchScope(viewId="v1")  # None
        SearchScope(viewId="v1", rootUrns=[])  # empty list


# ---------------------------------------------------------------------------
# Exact totalCount + per-request remaining budget
# ---------------------------------------------------------------------------

from backend.app.providers.falkordb_deep_search import (  # noqa: E402
    _MATCH_SET_CACHE_MAX_URNS,
    execute_deep_search,
)
from backend.common.models.graph import GraphNode  # noqa: E402


class _Rows:
    """Minimal stand-in for a FalkorDB result object."""

    def __init__(self, result_set):
        self.result_set = result_set


class _CountingProvider:
    """Scripted provider for ``execute_deep_search``.

    Answers the ``RETURN n`` candidate query with ``hit_rows`` node rows
    and the ``RETURN count(n) AS c`` query with ``total`` (or raises
    ``count_error``). Every call is recorded as
    ``(cypher, params, timeout)`` so a test can assert on the follow-up
    query's Cypher and on its share of the deadline budget.
    """

    _entity_type_levels: dict = {}

    def __init__(self, *, hit_rows=0, total=0, count_error=None):
        self.calls = []
        self._hit_rows = hit_rows
        self._total = total
        self._count_error = count_error

    async def _ro_query(self, cypher, *, params=None, timeout=None):
        self.calls.append((cypher, params, timeout))
        # Let the monotonic clock advance by a real interval so the
        # "each follow-up gets LESS than the last" assertions below are
        # about the budget, not about float noise.
        await asyncio.sleep(0.001)
        if cypher.endswith("RETURN count(n) AS c"):
            if self._count_error is not None:
                raise self._count_error
            return _Rows([[self._total]])
        if cypher.endswith("RETURN n"):
            return _Rows([[i] for i in range(self._hit_rows)])
        return _Rows([])  # aggregation pivot — buckets aren't under test

    async def _get_ancestor_chain(self, urn):
        return []

    async def get_nodes_batch(self, urns):
        return []

    def _get_lineage_edge_types(self):
        return ["LINEAGE"]

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    def _extract_node_from_result(self, row):
        return GraphNode(
            urn=f"urn:n{row[0]}",
            entityType="dataset",
            displayName=f"node {row[0]:05d}",
        )


def _hits_query(**opts) -> SearchQuery:
    return SearchQuery(
        predicate=TextPredicate(value="customer", target="name"),
        scope=_TEST_SCOPE,
        options=SearchOptions(results="hits", candidateCap=100, **opts),
    )


class TestExactTotalCount:
    """``totalCount`` is the exact number of matches in scope, so the
    header can say "1,284 matches" instead of a capped lower bound.

    The candidate scan keeps its ``LIMIT`` — only the count is allowed
    to run uncapped, and only when the cap actually fired.
    """

    def test_candidate_cypher_omits_limit_when_cap_is_none(self):
        cypher = _build_candidate_cypher(
            where_fragment="n.displayName CONTAINS $p0",
            entity_types_param=False,
            candidate_cap=None,
        )
        assert "LIMIT" not in cypher
        assert cypher.endswith("WITH n")

    @pytest.mark.asyncio
    async def test_not_truncated_needs_no_second_query(self):
        """The scan already returned every match, so the count is free."""
        prov = _CountingProvider(hit_rows=3)
        page = await execute_deep_search(prov, _hits_query())
        assert len(prov.calls) == 1, "an exact count must cost zero extra queries"
        assert page.candidate_count == 3
        assert page.total_count == 3
        assert page.truncated is False

    @pytest.mark.asyncio
    async def test_truncated_counts_on_the_uncapped_cypher(self):
        prov = _CountingProvider(hit_rows=100, total=1284)
        page = await execute_deep_search(prov, _hits_query())
        assert len(prov.calls) == 2
        count_cypher, _, count_timeout = prov.calls[1]
        assert count_cypher.endswith("RETURN count(n) AS c")
        assert "LIMIT" not in count_cypher
        # The follow-up runs on what is LEFT of the request's deadline,
        # not on a fresh copy of it. Strictly less: the candidate query
        # gets ``timeout_s`` verbatim, so an un-budgeted follow-up would
        # tie here rather than undercut.
        assert count_timeout < prov.calls[0][2]
        assert page.total_count == 1284
        assert page.candidate_count == 100
        assert page.truncated is True

    @pytest.mark.asyncio
    async def test_count_timeout_keeps_the_hits(self):
        prov = _CountingProvider(hit_rows=100, count_error=asyncio.TimeoutError())
        page = await execute_deep_search(prov, _hits_query())
        assert page.hits is not None and len(page.hits) == 50
        assert page.total_count is None
        assert page.deadline_exceeded is True
        assert page.truncated is True

    @pytest.mark.asyncio
    async def test_count_failure_keeps_the_hits(self, caplog):
        """The hits page is already built and correct. NOTHING the count
        raises may cost the caller that page — and FalkorDB's own
        deadline arrives as a provider error, not a TimeoutError, so
        this is the ordinary path rather than the exotic one."""
        prov = _CountingProvider(hit_rows=100, count_error=RuntimeError("boom"))
        with caplog.at_level(logging.WARNING):
            page = await execute_deep_search(prov, _hits_query())
        assert page.hits is not None and len(page.hits) == 50
        assert page.total_count is None
        assert page.truncated is True
        # A fast failure is not a blown deadline — the elapsed check
        # decides that, and 3ms of a 30s budget is not it.
        assert page.deadline_exceeded is False
        # Degraded, never silent.
        assert any(
            r.levelno == logging.WARNING and "boom" in r.getMessage()
            for r in caplog.records
        ), [r.getMessage() for r in caplog.records]

    @pytest.mark.asyncio
    async def test_exact_count_disproves_the_cap_heuristic(self):
        """``candidateCount == cap`` only ever meant "the cap fired". Once
        the exact total says the set is that size, the page is NOT
        truncated — the UI would otherwise render a complete result as
        "100+"."""
        prov = _CountingProvider(hit_rows=100, total=100)
        page = await execute_deep_search(prov, _hits_query())
        assert page.total_count == 100
        assert page.candidate_count == 100
        assert page.truncated is False

    @pytest.mark.asyncio
    async def test_every_follow_up_shares_one_budget(self, monkeypatch):
        """The candidate query gets the whole deadline; the count, the
        aggregation and the ancestor hydration each get what is left of
        it. Asserted as a strictly descending chain, so restoring
        ``timeout_s`` at any one of the three sites fails this test."""
        waits = []
        real_wait_for = asyncio.wait_for

        async def _spy(awaitable, timeout=None):
            waits.append(timeout)
            return await real_wait_for(awaitable, timeout)

        monkeypatch.setattr(asyncio, "wait_for", _spy)
        q = SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=_TEST_SCOPE,
            options=SearchOptions(
                results="both",
                aggregations=[AggregationSpec(by="entityType")],
                candidateCap=100,
                includeAncestorPath=True,
            ),
        )
        prov = _CountingProvider(hit_rows=100, total=1284)
        page = await execute_deep_search(prov, q)
        candidate_t, count_t, agg_t = (c[2] for c in prov.calls)
        assert candidate_t == 30.0, "the candidate scan gets the full deadline"
        assert len(waits) == 1, "ancestor hydration must run under wait_for"
        assert candidate_t > count_t > agg_t > waits[0] > 0
        assert page.total_count == 1284

    @pytest.mark.asyncio
    async def test_aggregates_only_counts_uncapped(self):
        q = SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=_TEST_SCOPE,
            options=SearchOptions(
                results="aggregates",
                aggregations=[AggregationSpec(by="entityType")],
                candidateCap=100,
            ),
        )
        prov = _CountingProvider(total=1284)
        page = await execute_deep_search(prov, q)
        # The aggregation still pivots on the CAPPED candidate set.
        agg_cypher, _, agg_timeout = prov.calls[0]
        assert "WITH n LIMIT 100" in agg_cypher
        count_cypher, _, count_timeout = prov.calls[1]
        assert count_cypher.endswith("RETURN count(n) AS c")
        assert "LIMIT" not in count_cypher
        assert count_timeout < agg_timeout
        assert page.total_count == 1284
        # ``candidateCount`` keeps its meaning in every shape: the size
        # of the CAPPED set the aggregations ran over.
        assert page.candidate_count == 100
        assert page.truncated is True

    @pytest.mark.asyncio
    async def test_aggregates_only_below_cap_counts_the_same_set_twice(self):
        """Under the cap the aggregations saw every match, so the capped
        and the exact number are the same number."""
        q = SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=_TEST_SCOPE,
            options=SearchOptions(
                results="aggregates",
                aggregations=[AggregationSpec(by="entityType")],
                candidateCap=100,
            ),
        )
        page = await execute_deep_search(_CountingProvider(total=40), q)
        assert page.candidate_count == 40
        assert page.total_count == 40
        assert page.truncated is False

    @pytest.mark.asyncio
    async def test_aggregates_only_total_equal_to_cap_is_not_truncated(self):
        """An uncapped count of exactly the cap means the aggregation saw
        every match — ``>=`` would report a phantom truncation."""
        q = SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=_TEST_SCOPE,
            options=SearchOptions(
                results="aggregates",
                aggregations=[AggregationSpec(by="entityType")],
                candidateCap=100,
            ),
        )
        page = await execute_deep_search(_CountingProvider(total=100), q)
        assert page.candidate_count == 100
        assert page.total_count == 100
        assert page.truncated is False

    @pytest.mark.asyncio
    async def test_explain_exposes_the_uncapped_cypher(self):
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        explained = explain_deep_search(_CountingProvider(), _hits_query())
        assert "LIMIT 100" in explained["cypher"]
        assert "LIMIT" not in explained["uncapped_cypher"]


# ---------------------------------------------------------------------------
# AggregationKind 'ancestor' — exact per-ancestor counts, uncapped
# ---------------------------------------------------------------------------

class _AncestorAggProvider:
    """Capturing provider for the ``ancestor`` aggregation.

    Records every query and answers it with ``rows``. ``containment=()``
    reproduces a graph whose ontology declares no containment edges.
    Deliberately has no ``_extract_node_from_result``: this kind returns
    no samples column, so reaching for one is a bug.
    """

    def __init__(self, rows=None, containment=("CONTAINS",)):
        self.calls = []
        self._rows = list(rows or [])
        self._containment = list(containment)

    async def _ro_query(self, cypher, *, params=None, timeout=None):
        self.calls.append((cypher, params, timeout))
        return _Rows(self._rows)

    def _get_containment_edge_types(self):
        return self._containment


class _TwoFacetProvider(_CountingProvider):
    """Answers the ``entityType`` and ``ancestor`` pivots with rows that
    can be told apart, so the response's facet order is observable."""

    async def _ro_query(self, cypher, *, params=None, timeout=None):
        self.calls.append((cypher, params, timeout))
        if "collect([et, c]) AS breakdown" in cypher:
            return _Rows([["urn:d1", "Domain 1", "Domain", 7, [["Column", 7]]]])
        if "labels(n)[0] AS etype" in cypher:
            return _Rows([["", "Column", "Column", 5, []]])
        return _Rows([])


def _ancestor_spec(**kwargs) -> AggregationSpec:
    return AggregationSpec(
        by="ancestor", maxBuckets=20000, sampleHitsPerBucket=0, **kwargs,
    )


class TestAggregationAncestor:
    """A collapsed container says "N matches inside". That N has to
    credit the container for EVERY match below it, at any depth, and it
    has to be the real number rather than what fit under the candidate
    cap — so this kind alone pivots on the uncapped candidate prefix.
    """

    UNCAPPED = "MATCH (n) WHERE n.displayName CONTAINS $p0 WITH n"

    def _query(self) -> SearchQuery:
        return SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=_TEST_SCOPE,
        )

    def test_spec_accepts_the_kind_and_the_wider_bucket_bound(self):
        spec = _ancestor_spec()
        assert spec.by == "ancestor"
        assert spec.max_buckets == 20000

    def test_bucket_serialises_type_counts_as_typeCounts(self):
        from backend.common.models.search import SearchAggregateBucket
        bucket = SearchAggregateBucket(
            ancestorUrn="urn:t1", ancestorDisplayName="T1",
            ancestorEntityType="Table", ancestorDepthFromScopeRoot=0,
            matchCount=3, typeCounts={"Column": 2, "View": 1},
        )
        assert bucket.model_dump(by_alias=True)["typeCounts"] == {
            "Column": 2, "View": 1,
        }

    @pytest.mark.asyncio
    async def test_pivots_on_the_uncapped_cypher_in_two_stages(self):
        from backend.app.providers.falkordb_deep_search import (
            _run_aggregation_ancestor,
        )
        prov = _AncestorAggProvider()
        await _run_aggregation_ancestor(
            prov, self.UNCAPPED, {"p0": "customer"}, _ancestor_spec(),
            query=self._query(), timeout_s=3.0,
        )
        assert len(prov.calls) == 1
        cypher, params, timeout = prov.calls[0]
        assert cypher.startswith(self.UNCAPPED)
        assert "MATCH (anc)-[:CONTAINS*1..12]->(n)" in cypher
        # Two stages: per-(ancestor, type) counts first, then the
        # per-ancestor roll-up — so the bucket LIMIT bounds ANCESTORS
        # rather than (ancestor, type) rows.
        assert "labels(n)[0] AS et, count(DISTINCT n) AS c" in cypher
        assert "sum(c) AS mc" in cypher
        assert "collect([et, c]) AS breakdown" in cypher
        assert "ORDER BY mc DESC LIMIT 20000" in cypher
        # ...and it must ride the WITH, BEFORE the RETURN. An ORDER BY
        # hung off a RETURN that follows an aggregation is silently
        # discarded on this stack (it has already broken keyset
        # pagination here once) — which for an uncapped pivot means an
        # ARBITRARY 20000 containers instead of the fullest ones, with
        # nothing in the response to say so.
        assert cypher.index("ORDER BY") < cypher.index("RETURN anc.urn")
        # The candidate cap would silently undercount "N matches
        # inside" — the ONLY LIMIT here is the bucket one.
        assert cypher.count("LIMIT") == 1
        assert params == {"p0": "customer"}
        assert timeout == 3.0

    @pytest.mark.asyncio
    async def test_scope_max_depth_bounds_the_ancestor_walk(self):
        """The walk depth is the scope's, not a constant. Every other
        case here rides the default 12, so a hardcoded 12 would pass
        them all."""
        from backend.app.providers.falkordb_deep_search import (
            _run_aggregation_ancestor,
        )
        prov = _AncestorAggProvider()
        shallow = SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=SearchScope(view_id="view_test", maxDepth=4),
        )
        await _run_aggregation_ancestor(
            prov, self.UNCAPPED, {}, _ancestor_spec(),
            query=shallow, timeout_s=3.0,
        )
        assert "MATCH (anc)-[:CONTAINS*1..4]->(n)" in prov.calls[0][0]

    @pytest.mark.asyncio
    async def test_rows_map_to_match_count_and_type_counts(self):
        from backend.app.providers.falkordb_deep_search import (
            _run_aggregation_ancestor,
        )
        prov = _AncestorAggProvider(rows=[
            ["urn:t1", "T1", "Table", 3, [["Column", 2], ["View", 1]]],
            # A node carrying no label makes ``labels(n)[0]`` null. A
            # null dict key fails Dict[str, int] validation, which would
            # cost the WHOLE page -- every other bucket included -- over
            # one unlabelled node. It costs its own type name instead.
            ["urn:t2", "T2", "Table", 1, [[None, 1]]],
        ])
        buckets = await _run_aggregation_ancestor(
            prov, self.UNCAPPED, {}, _ancestor_spec(),
            query=self._query(), timeout_s=3.0,
        )
        assert len(buckets) == 2
        bucket = buckets[0]
        assert bucket.ancestor_urn == "urn:t1"
        assert bucket.ancestor_display_name == "T1"
        assert bucket.ancestor_entity_type == "Table"
        assert bucket.ancestor_depth_from_scope_root == 0
        assert bucket.match_count == 3
        assert bucket.type_counts == {"Column": 2, "View": 1}
        # No samples column — sampleHitsPerBucket is ignored by this kind.
        assert bucket.sample_hits == []
        assert buckets[1].type_counts == {"": 1}
        assert buckets[1].match_count == 1

    @pytest.mark.asyncio
    async def test_no_containment_edge_types_returns_no_buckets(self):
        from backend.app.providers.falkordb_deep_search import (
            _run_aggregation_ancestor,
        )
        prov = _AncestorAggProvider(containment=())
        buckets = await _run_aggregation_ancestor(
            prov, self.UNCAPPED, {}, _ancestor_spec(),
            query=self._query(), timeout_s=3.0,
        )
        assert buckets == []
        assert prov.calls == [], "a flat graph must cost zero queries"

    @pytest.mark.asyncio
    async def test_execute_aggregates_uncapped_while_hits_stay_capped(self):
        q = SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=_TEST_SCOPE,
            options=SearchOptions(
                results="both",
                aggregations=[_ancestor_spec()],
                candidateCap=100,
            ),
        )
        prov = _CountingProvider(hit_rows=3)
        await execute_deep_search(prov, q)
        assert len(prov.calls) == 2
        hits_cypher = prov.calls[0][0]
        assert "WITH n LIMIT 100 RETURN n" in hits_cypher
        agg_cypher = prov.calls[1][0]
        assert "MATCH (anc)-[:CONTAINS*1..12]->(n)" in agg_cypher
        assert "LIMIT 100" not in agg_cypher

    @pytest.mark.asyncio
    async def test_facet_order_follows_the_request_spec_order(self):
        """``result.aggregates[i]`` is ``options.aggregations[i]`` — the
        FE indexes into it positionally, so a kind that reorders its
        facet hands every bucket to the wrong reader."""
        q = SearchQuery(
            predicate=TextPredicate(value="customer", target="name"),
            scope=_TEST_SCOPE,
            options=SearchOptions(
                results="both",
                aggregations=[AggregationSpec(by="entityType"), _ancestor_spec()],
                candidateCap=100,
            ),
        )
        page = await execute_deep_search(_TwoFacetProvider(), q)
        assert page.aggregates is not None and len(page.aggregates) == 2
        assert page.aggregates[0][0].ancestor_entity_type == "Column"
        assert page.aggregates[0][0].type_counts is None
        assert page.aggregates[1][0].ancestor_urn == "urn:d1"
        assert page.aggregates[1][0].type_counts == {"Column": 7}


# ---------------------------------------------------------------------------
# Hit provenance — score / matchedPredicates / highlights
# ---------------------------------------------------------------------------

class TestHitProvenance:
    @staticmethod
    def _node(**kw):
        from backend.common.models.graph import GraphNode
        kw.setdefault("urn", "urn:n")
        kw.setdefault("entityType", "dataset")
        kw.setdefault("displayName", "node")
        return GraphNode(**kw)

    @staticmethod
    def _mock_prov():
        class _MockProv:
            def _extract_node_from_result(self, n):
                return n
        return _MockProv()

    def test_dfs_indices_count_every_leaf_kind(self):
        """``matched_predicates`` indices are a DFS over ALL leaves — a
        non-textual leaf still consumes its index, or the FE maps the
        badge onto the wrong branch of the tree it sent."""
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
        )
        pred = GroupPredicate(op="and", children=[
            TagPredicate(values=["pii"]),
            GroupPredicate(op="or", children=[
                TextPredicate(value="alpha", target="name"),
                TextPredicate(value="beta", target="description"),
            ]),
        ])
        leaves = _collect_text_leaves(pred)
        assert [i for i, _ in leaves] == [1, 2]
        assert [p.value for _, p in leaves] == ["alpha", "beta"]

    def test_exact_name_outranks_substring_description(self):
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(displayName="Customer",
                          description="the customer ledger")

        exact_name = _collect_text_leaves(
            TextPredicate(value="customer", target="name", match="exact"),
        )
        score, matched, _ = _score_hit(node, exact_name, want_highlights=False)
        assert score == pytest.approx(100.0)  # tier 100 x displayName 1.0
        assert matched == [0]

        # "ustomer" sits mid-word inside the description: substring floor.
        loose_desc = _collect_text_leaves(
            TextPredicate(value="ustomer", target="description"),
        )
        weak, matched_weak, _ = _score_hit(
            node, loose_desc, want_highlights=False,
        )
        assert weak == pytest.approx(8.0)  # tier 20 x description 0.4
        assert matched_weak == [0]
        assert score > weak

    def test_property_target_reports_its_field_and_ranges(self):
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(
            displayName="orders",
            properties={"owner": "The CUST team owns this table"},
        )
        leaves = _collect_text_leaves(
            TextPredicate(value="cust", target="property", propertyKey="owner"),
        )
        score, matched, highlights = _score_hit(
            node, leaves, want_highlights=True,
        )
        assert matched == [0]
        assert score == pytest.approx(20.0)  # word boundary 40 x property 0.5
        assert len(highlights) == 1
        hl = highlights[0]
        assert hl.field == "property:owner"
        assert hl.score == pytest.approx(20.0)
        start, end = hl.ranges[0]
        assert hl.snippet.lower()[start:end] == "cust"

    def test_ranges_stay_snippet_relative_when_the_snippet_is_cut(self):
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(
            description=("lorem ipsum " * 20) + "customer ledger",
        )
        leaves = _collect_text_leaves(
            TextPredicate(value="customer", target="description"),
        )
        _, _, highlights = _score_hit(node, leaves, want_highlights=True)
        hl = highlights[0]
        assert hl.snippet.startswith("…")  # leading context was cut
        start, end = hl.ranges[0]
        assert hl.snippet.lower()[start:end] == "customer"

    def test_tag_hit_scores_at_the_tag_weight(self):
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(displayName="orders", tags=["pii sensitive"])
        leaves = _collect_text_leaves(
            TextPredicate(value="sensitive", target="tags"),
        )
        score, matched, highlights = _score_hit(
            node, leaves, want_highlights=True,
        )
        assert score == pytest.approx(24.0)  # word boundary 40 x tags 0.6
        assert matched == [0]
        assert highlights[0].field == "tags"

    def test_relevance_sort_orders_by_score(self):
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = [
            self._node(urn="urn:a", displayName="zeta",
                       description="a customer note"),
            self._node(urn="urn:b", displayName="customer"),
            self._node(urn="urn:c", displayName="customer_events"),
        ]
        query = SearchQuery(
            predicate=TextPredicate(value="customer", target="any"),
            scope=_TEST_SCOPE,
            options=SearchOptions(sort="relevance", pageSize=10),
        )
        hits, _, _, _ = _build_hits_from_rows(self._mock_prov(), rows, query)
        assert [h.node.urn for h in hits] == ["urn:b", "urn:c", "urn:a"]
        assert hits[0].score == pytest.approx(100.0)  # exact displayName
        assert hits[1].score == pytest.approx(60.0)   # prefix displayName
        assert hits[2].score == pytest.approx(16.0)   # word bdy x desc 0.4

    def test_highlights_are_built_for_a_cursor_page_too(self):
        """Highlights are filled for the page slice, not for the first
        page — page 2 of a cursor walk must carry its own snippets."""
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = [self._node(urn=f"urn:{i:02d}", displayName=f"customer-{i:02d}")
                for i in range(30)]
        query = SearchQuery(
            predicate=TextPredicate(value="customer", target="name",
                                    match="prefix"),
            scope=_TEST_SCOPE,
            options=SearchOptions(
                sort="displayName", sortDir="asc", pageSize=10,
                cursor=encode_cursor({"offset": 20}),
            ),
        )
        hits, offset_after, total, _ = _build_hits_from_rows(
            self._mock_prov(), rows, query,
        )
        assert offset_after == 30 and total == 30
        assert [h.node.urn for h in hits] == [
            f"urn:{i:02d}" for i in range(20, 30)
        ]
        assert all(len(h.highlights) == 1 for h in hits)
        assert hits[0].highlights[0].field == "displayName"
        assert all(h.score == pytest.approx(60.0) for h in hits)

    def test_highlights_disabled_still_scores_and_attributes(self):
        from backend.app.providers.falkordb_deep_search import (
            _build_hits_from_rows,
        )
        rows = [self._node(urn=f"urn:{i:02d}", displayName=f"customer-{i:02d}")
                for i in range(5)]
        query = SearchQuery(
            predicate=TextPredicate(value="customer", target="name",
                                    match="prefix"),
            scope=_TEST_SCOPE,
            options=SearchOptions(sort="relevance", pageSize=10,
                                  highlights=False),
        )
        hits, _, _, _ = _build_hits_from_rows(self._mock_prov(), rows, query)
        assert len(hits) == 5
        assert all(h.highlights == [] for h in hits)
        assert all(h.score == pytest.approx(60.0) for h in hits)
        assert all(h.matched_predicates == [0] for h in hits)

    def test_property_predicate_scores_only_textual_ops(self):
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(properties={"owner": "Data Platform",
                                      "rowCount": 42})
        textual = _collect_text_leaves(
            PropertyPredicate(key="owner", op="contains", value="platform"),
        )
        score, matched, highlights = _score_hit(
            node, textual, want_highlights=True,
        )
        assert score == pytest.approx(20.0)  # word bdy 40 x property 0.5
        assert matched == [0]
        assert highlights[0].field == "property:owner"

        # A numeric comparison has no text to attribute the hit to.
        numeric = _collect_text_leaves(
            PropertyPredicate(key="rowCount", op="gt", value=10),
        )
        assert _score_hit(node, numeric, want_highlights=True) == (0.0, [], [])

    def test_empty_needle_earns_no_provenance(self):
        """``col CONTAINS ''`` is true for every non-null column — scoring
        it would rank the whole result set at the prefix tier."""
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(properties={"owner": "Data Platform"})
        leaves = _collect_text_leaves(
            PropertyPredicate(key="owner", op="contains", value=""),
        )
        assert _score_hit(node, leaves, want_highlights=True) == (0.0, [], [])

    def test_property_predicate_matches_a_non_string_node_value(self):
        """``toLower(toString(n.rowCount)) = $v`` matches ``rowCount:
        100`` against '100' — the row comes back from Cypher, so it has
        to arrive carrying the provenance that says why."""
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(properties={"rowCount": 100})
        leaves = _collect_text_leaves(
            PropertyPredicate(key="rowCount", op="eq", value="100"),
        )
        score, matched, highlights = _score_hit(
            node, leaves, want_highlights=True,
        )
        assert matched == [0]
        assert score == pytest.approx(50.0)  # exact 100 x property 0.5
        assert highlights[0].field == "property:rowCount"

    def test_exact_mode_never_earns_the_substring_tier(self):
        """An `exact` predicate asked about the whole field. A haystack
        that merely contains the needle did not answer that question."""
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(displayName="customer orders")
        leaves = _collect_text_leaves(
            TextPredicate(value="customer", target="name", match="exact"),
        )
        assert _score_hit(node, leaves, want_highlights=True) == (0.0, [], [])

    def test_suffix_mode_floors_to_the_substring_tier(self):
        """A needle that is also a prefix must not collect the prefix
        tier — the query asked about the tail."""
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(displayName="orders_orders")
        leaves = _collect_text_leaves(
            TextPredicate(value="orders", target="name", match="suffix"),
        )
        score, matched, _ = _score_hit(node, leaves, want_highlights=False)
        assert score == pytest.approx(20.0)  # substring floor x name 1.0
        assert matched == [0]

    def test_case_sensitive_predicate_needs_the_case_to_match(self):
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        node = self._node(displayName="Customer")
        sensitive = _collect_text_leaves(
            TextPredicate(value="customer", target="name", match="exact",
                          caseSensitive=True),
        )
        assert _score_hit(node, sensitive, want_highlights=False)[0] == 0.0
        insensitive = _collect_text_leaves(
            TextPredicate(value="customer", target="name", match="exact"),
        )
        assert _score_hit(
            node, insensitive, want_highlights=False,
        )[0] == pytest.approx(100.0)

    def test_blob_targets_cannot_claim_a_direct_comparison(self):
        """``any`` compares searchableText/displayName/qualifiedName and
        ``tags`` compares a JSON-stringified array. A description or tag
        hit under those targets rode in on a different column, so it may
        not report itself as an exact match on its own."""
        from backend.app.providers.falkordb_deep_search import (
            _collect_text_leaves,
            _score_hit,
        )
        any_exact = _collect_text_leaves(
            TextPredicate(value="ledger", target="any", match="exact"),
        )
        # The description equals the value, but `any` never compared
        # n.description — floor, not 100 x 0.4.
        desc_node = self._node(displayName="orders", description="ledger")
        score, matched, _ = _score_hit(
            desc_node, any_exact, want_highlights=False,
        )
        assert score == pytest.approx(8.0)  # floor 20 x description 0.4
        assert matched == [0]

        tag_node = self._node(displayName="orders", tags=["pii"])
        tags_exact = _collect_text_leaves(
            TextPredicate(value="pii", target="tags", match="exact"),
        )
        assert _score_hit(
            tag_node, tags_exact, want_highlights=False,
        )[0] == pytest.approx(12.0)  # floor 20 x tags 0.6

        # displayName IS one of the columns `any` compares — full tier.
        name_node = self._node(displayName="ledger")
        assert _score_hit(
            name_node, any_exact, want_highlights=False,
        )[0] == pytest.approx(100.0)


# ---------------------------------------------------------------------------
# Cursor validation — a cursor belongs to the query that minted it
# ---------------------------------------------------------------------------

class TestCursorValidation:
    """``match_hash`` is the query's identity for pagination purposes.

    Paging controls are deliberately outside it: the same walk may
    re-tune its page size mid-iteration (``TestCursorPagination``
    pins that), so only the parts that decide *which* nodes match are
    hashed.
    """

    def test_match_hash_ignores_cursor_and_page_size(self):
        base = _hits_query(pageSize=10)
        paged = _hits_query(
            pageSize=200, cursor=encode_cursor({"offset": 10, "q": "x"}),
        )
        assert match_hash(base) == match_hash(paged)

    def test_match_hash_changes_with_the_predicate(self):
        a = _hits_query()
        b = SearchQuery(
            predicate=TextPredicate(value="orders", target="name"),
            scope=_TEST_SCOPE,
            options=SearchOptions(results="hits", candidateCap=100),
        )
        assert match_hash(a) != match_hash(b)

    @pytest.mark.asyncio
    async def test_cursor_from_another_query_is_rejected_up_front(self):
        """The offset means nothing against a different match set, so
        the rejection has to happen before the scan is even sent."""
        prov = _CountingProvider(hit_rows=30, total=30)
        stale = encode_cursor({"offset": 10, "q": match_hash(_hits_query())})
        q = SearchQuery(
            predicate=TextPredicate(value="orders", target="name"),
            scope=_TEST_SCOPE,
            options=SearchOptions(results="hits", candidateCap=100,
                                  pageSize=10, cursor=stale),
        )
        with pytest.raises(CompileError, match="different query"):
            await execute_deep_search(prov, q)
        assert prov.calls == []

    @pytest.mark.asyncio
    async def test_next_cursor_carries_the_match_hash(self):
        prov = _CountingProvider(hit_rows=30, total=30)
        q = _hits_query(pageSize=10)
        page = await execute_deep_search(prov, q)
        assert decode_cursor(page.cursor) == {
            "offset": 10, "q": match_hash(q),
        }

    @pytest.mark.asyncio
    async def test_cursor_minted_by_this_query_is_accepted(self):
        prov = _CountingProvider(hit_rows=30, total=30)
        page1 = await execute_deep_search(prov, _hits_query(pageSize=10))
        page2 = await execute_deep_search(
            prov, _hits_query(pageSize=10, cursor=page1.cursor),
        )
        assert len(page2.hits) == 10
        assert not (set(h.node.urn for h in page1.hits)
                    & set(h.node.urn for h in page2.hits))


# ---------------------------------------------------------------------------
# Redis match-set cache — a cursor page is a slice, not a second scan
# ---------------------------------------------------------------------------

class _FakeRedis:
    """Dict-backed stand-in for the provider's ``TimeoutRedis`` proxy.

    Only the two calls the match-set cache makes are implemented; the
    ``ex`` argument is recorded so a test can pin the TTL.
    """

    def __init__(self):
        self.store = {}
        self.set_calls = []

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value
        self.set_calls.append((key, value, ex))


def _cached_node(i: int) -> GraphNode:
    return GraphNode(urn=f"urn:n{i:05d}", entityType="dataset",
                     displayName=f"customer-{i:05d}")


class _CachingProvider(_CountingProvider):
    """``_CountingProvider`` with a Redis and a real ``get_nodes_batch``.

    Nodes are named ``customer-000NN`` so the request's TextPredicate
    actually matches them — a cached page has to carry the same scores
    and highlights a scanned one would. ``vanished`` deletes nodes
    between pages.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._redis = _FakeRedis()
        self._cache_ns = "h:1:g"
        self.batch_calls = []
        self.vanished = set()

    def _extract_node_from_result(self, row):
        return _cached_node(row[0])

    async def get_nodes_batch(self, urns):
        self.batch_calls.append(list(urns))
        known = {n.urn: n
                 for n in (_cached_node(i) for i in range(self._hit_rows))}
        # Reversed on purpose: the real one answers per label bucket, so
        # its caller may never rely on the order it comes back in.
        return [known[u] for u in reversed(list(urns))
                if u in known and u not in self.vanished]


def _cache_query(**opts) -> SearchQuery:
    opts.setdefault("results", "hits")
    opts.setdefault("sort", "displayName")
    opts.setdefault("sortDir", "asc")
    opts.setdefault("pageSize", 10)
    opts.setdefault("candidateCap", 100)
    return SearchQuery(
        predicate=TextPredicate(value="customer", target="name",
                                match="prefix"),
        scope=_TEST_SCOPE,
        options=SearchOptions(**opts),
    )


class TestMatchSetCache:
    """Page 1 remembers the sorted match set; every later page slices it.

    Without this each "Load more" re-runs the whole candidate scan and
    re-sorts up to the candidate cap in Python.
    """

    @pytest.mark.asyncio
    async def test_first_page_writes_the_sorted_match_set(self):
        from backend.app.services.deep_search import get_deep_search_settings

        prov = _CachingProvider(hit_rows=30)
        q = _cache_query(sortDir="desc")
        page = await execute_deep_search(prov, q)

        assert page.cache_hit is False
        assert len(prov._redis.set_calls) == 1
        key, raw, ex = prov._redis.set_calls[0]
        assert key == f"h:1:g:dsearch:{match_hash(q)}"
        assert ex == get_deep_search_settings().cache_ttl_seconds
        envelope = json.loads(raw)
        # The SORTED set, not the scan order the rows arrived in.
        assert envelope["urns"] == [
            f"urn:n{i:05d}" for i in reversed(range(30))
        ]
        assert envelope["candidate_count"] == 30
        assert envelope["truncated"] is False
        assert envelope["total_count"] == 30

    @pytest.mark.asyncio
    async def test_a_single_page_result_is_not_cached(self):
        """No page follows, so no cursor is minted — an entry for it
        could only ever be dead weight."""
        prov = _CachingProvider(hit_rows=5)
        page = await execute_deep_search(prov, _cache_query())

        assert page.cursor is None
        assert prov._redis.set_calls == []

    @pytest.mark.asyncio
    async def test_cursor_page_slices_the_cache_without_rescanning(self):
        prov = _CachingProvider(hit_rows=30)
        first = await execute_deep_search(prov, _cache_query())
        assert first.cursor is not None
        prov.calls.clear()

        q2 = _cache_query(cursor=first.cursor)
        page = await execute_deep_search(prov, q2)

        assert prov.calls == []  # no re-scan
        assert prov.batch_calls == [
            [f"urn:n{i:05d}" for i in range(10, 20)]
        ]
        assert [h.node.urn for h in page.hits] == [
            f"urn:n{i:05d}" for i in range(10, 20)
        ]
        assert page.cache_hit is True
        assert page.candidate_count == 30
        assert page.truncated is False
        assert page.total_count == 30
        assert all(h.score == pytest.approx(60.0) for h in page.hits)
        assert all(h.highlights[0].field == "displayName"
                   for h in page.hits)
        assert decode_cursor(page.cursor) == {
            "offset": 20, "q": match_hash(q2),
        }

    @pytest.mark.asyncio
    async def test_cache_miss_falls_back_to_the_scan(self):
        prov = _CachingProvider(hit_rows=30)
        cursor = encode_cursor(
            {"offset": 10, "q": match_hash(_cache_query())},
        )
        page = await execute_deep_search(prov, _cache_query(cursor=cursor))

        assert len(prov.calls) == 1
        assert prov.batch_calls == []
        assert page.cache_hit is False
        assert [h.node.urn for h in page.hits] == [
            f"urn:n{i:05d}" for i in range(10, 20)
        ]

    @pytest.mark.asyncio
    async def test_provider_without_redis_still_pages(self):
        prov = _CountingProvider(hit_rows=30, total=30)
        cursor = encode_cursor(
            {"offset": 10, "q": match_hash(_cache_query())},
        )
        page = await execute_deep_search(prov, _cache_query(cursor=cursor))

        assert len(prov.calls) == 1
        assert page.cache_hit is False
        assert len(page.hits) == 10

    @pytest.mark.asyncio
    async def test_deadline_exceeded_page_is_not_cached(self):
        prov = _CachingProvider(hit_rows=100,
                                count_error=asyncio.TimeoutError())
        page = await execute_deep_search(prov, _cache_query())

        assert page.deadline_exceeded is True
        assert prov._redis.set_calls == []

    @pytest.mark.asyncio
    async def test_urns_that_vanished_since_the_scan_are_dropped(self):
        prov = _CachingProvider(hit_rows=30)
        first = await execute_deep_search(prov, _cache_query())
        prov.vanished = {"urn:n00012", "urn:n00015"}
        prov.calls.clear()

        page = await execute_deep_search(
            prov, _cache_query(cursor=first.cursor),
        )
        assert [h.node.urn for h in page.hits] == [
            f"urn:n{i:05d}" for i in range(10, 20) if i not in (12, 15)
        ]
        # The walk still advances by the full slice — a deleted node
        # must not make the next page repeat this one.
        assert decode_cursor(page.cursor)["offset"] == 20

    @pytest.mark.asyncio
    async def test_the_node_fetch_runs_inside_the_request_budget(self):
        """``get_nodes_batch`` carries its own 15s children-query
        timeout, so a cached page that awaited it unwrapped would hand
        a client who asked for 200ms a page ~15s later."""
        prov = _CachingProvider(hit_rows=30)
        first = await execute_deep_search(
            prov, _cache_query(softDeadlineMs=200),
        )

        async def _slow(urns):
            await asyncio.sleep(5)
            return []

        prov.get_nodes_batch = _slow
        prov.calls.clear()

        page = await execute_deep_search(
            prov, _cache_query(softDeadlineMs=200, cursor=first.cursor),
        )
        # The same shape a timed-out candidate scan yields today.
        assert page.deadline_exceeded is True
        assert page.truncated is True
        assert page.hits is None
        assert page.cursor is None
        assert page.elapsed_ms < 2000

    @pytest.mark.asyncio
    async def test_a_match_set_at_the_ceiling_is_cached(self):
        prov = _CachingProvider(hit_rows=_MATCH_SET_CACHE_MAX_URNS)
        await execute_deep_search(prov, _cache_query(candidateCap=100000))

        assert len(prov._redis.set_calls) == 1
        envelope = json.loads(prov._redis.set_calls[0][1])
        assert len(envelope["urns"]) == _MATCH_SET_CACHE_MAX_URNS

    @pytest.mark.asyncio
    async def test_a_match_set_above_the_ceiling_is_not_cached(self):
        """~3.5 MB of JSON per entry on a cache Redis shared with every
        other provider cache is worth more than the re-scan it saves."""
        prov = _CachingProvider(hit_rows=_MATCH_SET_CACHE_MAX_URNS + 1)
        page = await execute_deep_search(
            prov, _cache_query(candidateCap=100000),
        )
        assert prov._redis.set_calls == []
        # It still pages — by re-scanning, exactly as it did before.
        assert page.cursor is not None

    @pytest.mark.asyncio
    async def test_a_cache_read_that_raises_falls_through_to_the_scan(self):
        class _BrokenRedis(_FakeRedis):
            async def get(self, key):
                raise ConnectionError("cache down")

        prov = _CachingProvider(hit_rows=30)
        prov._redis = _BrokenRedis()
        cursor = encode_cursor(
            {"offset": 10, "q": match_hash(_cache_query())},
        )
        page = await execute_deep_search(prov, _cache_query(cursor=cursor))

        assert len(prov.calls) == 1
        assert page.cache_hit is False
        assert [h.node.urn for h in page.hits] == [
            f"urn:n{i:05d}" for i in range(10, 20)
        ]

    @pytest.mark.parametrize("stored", [
        '{"urns": []}',  # an older build's envelope: no counters
        '{"urns": {}, "candidate_count": 0, "truncated": false, '
        '"total_count": 0}',  # every name present, wrong type
        'not json at all',
    ])
    @pytest.mark.asyncio
    async def test_an_unrecognised_envelope_is_a_miss(self, stored):
        prov = _CachingProvider(hit_rows=30)
        q = _cache_query(cursor=encode_cursor(
            {"offset": 10, "q": match_hash(_cache_query())},
        ))
        prov._redis.store[f"h:1:g:dsearch:{match_hash(q)}"] = stored
        page = await execute_deep_search(prov, q)

        assert page.cache_hit is False
        assert len(prov.calls) == 1
        assert len(page.hits) == 10

    @pytest.mark.asyncio
    async def test_both_shape_still_aggregates_on_a_cached_page(self):
        """The cache answers for hits only; the facets a ``both`` page
        asks for are still computed against the live graph."""
        prov = _CachingProvider(hit_rows=30)
        aggs = [AggregationSpec(by="entityType")]
        first = await execute_deep_search(
            prov, _cache_query(results="both", aggregations=aggs),
        )
        assert len(prov.calls) == 2  # scan + facet
        prov.calls.clear()

        page = await execute_deep_search(
            prov, _cache_query(results="both", aggregations=aggs,
                               cursor=first.cursor),
        )
        assert page.cache_hit is True
        assert page.aggregates is not None
        assert len(prov.calls) == 1
        assert not prov.calls[0][0].endswith("RETURN n")


# ---------------------------------------------------------------------------
# missingSearchableText — the "search everything found nothing" diagnostic
# ---------------------------------------------------------------------------

from backend.app.providers.falkordb_deep_search import (  # noqa: E402
    discover_native_property_keys,
)


class _SampledNode:
    """A FalkorDB node row carries its props under ``.properties``."""

    def __init__(self, properties: dict):
        self.properties = properties


class _DiscoverProvider:
    """Scripted provider for ``discover_native_property_keys``.

    Answers ``CALL db.labels()`` with the fixture's labels and each
    per-label sample query with that label's nodes. The tests switch
    edge discovery off, so no edge scan reaches ``_ro_query``.
    """

    def __init__(self, nodes_by_label: dict):
        self._nodes_by_label = nodes_by_label

    async def _ro_query(self, cypher, *, params=None, timeout=None):
        if cypher.startswith("CALL db.labels()"):
            return _Rows([[label] for label in self._nodes_by_label])
        for label, props in self._nodes_by_label.items():
            if f"(n:`{label}`)" in cypher:
                return _Rows([[_SampledNode(p)] for p in props])
        return _Rows([])

    def _get_containment_edge_types(self):
        return ["CONTAINS"]


class TestDiscoverMissingSearchableText:
    """``text(target='any')`` reads ``n.searchableText`` and nothing
    else, so on a graph the backfill never touched a "search everything"
    query returns nothing at all — silently, with no error to read.
    Discover counts the sampled nodes that carry no blob, which is what
    lets the zero-results panel name the backfill command instead of
    shrugging."""

    @pytest.mark.asyncio
    async def test_counts_sampled_nodes_with_no_searchable_text(self):
        prov = _DiscoverProvider({"dataset": [
            {"urn": "urn:a", "displayName": "A", "searchableText": "a orders"},
            {"urn": "urn:b", "displayName": "B"},
            # An empty blob matches nothing, so it is missing too.
            {"urn": "urn:c", "displayName": "C", "searchableText": ""},
        ]})
        result = await discover_native_property_keys(prov, include_edges=False)
        assert result["missingSearchableText"] == 2

    @pytest.mark.asyncio
    async def test_zero_when_every_sampled_node_carries_one(self):
        prov = _DiscoverProvider({"dataset": [
            {"urn": "urn:a", "searchableText": "a"},
            {"urn": "urn:b", "searchableText": "b"},
        ]})
        result = await discover_native_property_keys(prov, include_edges=False)
        assert result["missingSearchableText"] == 0

    @pytest.mark.asyncio
    async def test_counts_across_every_sampled_label(self):
        """The backfill is per-graph, not per-label — the count is the
        whole sample's, so one migrated label can't hide the rest."""
        prov = _DiscoverProvider({
            "dataset": [{"urn": "urn:a", "searchableText": "a"}],
            "column": [{"urn": "urn:b"}, {"urn": "urn:c"}],
        })
        result = await discover_native_property_keys(prov, include_edges=False)
        assert result["missingSearchableText"] == 2

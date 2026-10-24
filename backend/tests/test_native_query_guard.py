"""The guard in front of every native query: reads run, nothing else does.

Read-only is the engines' to enforce too (``GRAPH.RO_QUERY``, Neo4j READ
transactions); the guard is what refuses the reads that must never run for
a person here — files and URLs, other databases, plugin procedures and
functions — and says why, at the place in the query it means. It reads
tokens, so the same letters in a string, a comment, a backtick name, a
property, a label or a map key are never taken for a keyword.
"""
from __future__ import annotations

import random

import pytest

from backend.app.services.native_query.guard import FALKORDB, NEO4J, check, normalized
from backend.common.interfaces.native_query import (
    NativeQueryError,
    NativeQueryRefused,
    NativeQuerySyntaxError,
)


def refusal(query, engine=NEO4J):
    with pytest.raises(NativeQueryError) as caught:
        check(query, engine=engine)
    return caught.value


@pytest.mark.parametrize("engine", [FALKORDB, NEO4J])
@pytest.mark.parametrize("query", [
    "MATCH (n) RETURN n",
    "MATCH (n:Dataset)-[r:TRANSFORMS*1..3]->(m) WHERE n.name STARTS WITH 'cust' RETURN m LIMIT 10",
    "OPTIONAL MATCH (n) WITH n, count(*) AS c ORDER BY c DESC RETURN n.urn, c",
    "UNWIND [1, 2, 3] AS x RETURN x * 2",
    "MATCH (a) RETURN a.x AS x UNION ALL MATCH (b) RETURN b.x AS x",
    "CALL { MATCH (n) RETURN n } RETURN n",
    "MATCH p = shortestPath((a)-[*..5]-(b)) WHERE a.urn = 'x' RETURN p",
    "RETURN [x IN range(1, 5) WHERE x % 2 = 0 | x] AS evens",
    "MATCH (n) WHERE EXISTS { MATCH (n)-->() } RETURN count(n)",
    "CALL db.labels()",
    "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType",
    "MATCH (n) RETURN n;",
])
def test_reads_run(query, engine):
    assert check(query, engine=engine)


@pytest.mark.parametrize("query", [
    # Properties, labels, types and map keys spelled like keywords.
    "MATCH (n) RETURN n.set, n.create, n.delete, n.load, n.use, n.call",
    "MATCH (n:Set)-[:DELETE]->(m:Create) RETURN m",
    "RETURN {create: 1, set: 2, load: 3} AS m",
    "MATCH (set:Label) RETURN set.name",
    # Keywords in strings, comments and backtick names.
    "RETURN 'CREATE (n)', \"DETACH DELETE n\" // MERGE here is a comment",
    "MATCH (n) /* SET n.x = 1 */ RETURN n",
    "MATCH (n) RETURN n.`create` AS `DELETE`",
])
def test_the_letters_of_a_keyword_are_not_one(query):
    assert check(query, engine=NEO4J)


@pytest.mark.parametrize("query, word, at", [
    ("CREATE (n:X) RETURN n", "CREATE", 0),
    ("MATCH (n) SET n.x = 1 RETURN n", "SET", 10),
    ("MATCH (n) DETACH DELETE n", "DETACH", 10),
    ("MERGE (n:X {k: 1}) RETURN n", "MERGE", 0),
    ("MATCH (n) REMOVE n:X RETURN n", "REMOVE", 10),
    ("MATCH (n) FOREACH (x IN [1] | SET n.y = x) RETURN n", "FOREACH", 10),
    ("INSERT (n:X)", "INSERT", 0),
    ("DROP INDEX i", "DROP", 0),
    ("CREATE INDEX FOR (n:X) ON (n.k)", "CREATE", 0),
    ("GRANT ROLE r TO u", "GRANT", 0),
    ("TERMINATE TRANSACTIONS 'x'", "TERMINATE", 0),
    ("LOAD CSV FROM 'https://example.com/x.csv' AS l RETURN l", "LOAD", 0),
    ("USE other MATCH (n) RETURN n", "USE", 0),
    ("SHOW DATABASES", "SHOW", 0),
    ("EXPLAIN MATCH (n) RETURN n", "EXPLAIN", 0),
    ("PROFILE MATCH (n) RETURN n", "PROFILE", 0),
    ("CYPHER runtime=slotted MATCH (n) RETURN n", "CYPHER", 0),
    ("MATCH (n) CALL { WITH n RETURN n } IN TRANSACTIONS RETURN n", "TRANSACTIONS", 38),
    ("USING PERIODIC COMMIT LOAD CSV FROM 'x' AS l RETURN l", "PERIODIC", 6),
    # In a subquery, and in lower case.
    ("CALL { MATCH (n) DELETE n } RETURN 1", "DELETE", 17),
    ("match (n) set n.x = 1 return n", "SET", 10),
])
def test_writes_and_everything_outside_a_read_are_refused(query, word, at):
    refused = refusal(query)
    assert isinstance(refused, NativeQueryRefused)
    assert refused.position == at
    assert str(refused).startswith(word)


def test_a_lower_case_keyword_suggests_backticks():
    assert "`set`" in str(refusal("match (n) set n.x = 1 return n"))
    assert "backticks" not in str(refusal("MATCH (n) SET n.x = 1 RETURN n"))


@pytest.mark.parametrize("query, engine", [
    ("CALL db.idx.fulltext.queryNodes('Dataset', 'cust') YIELD node RETURN node", FALKORDB),
    ("CALL db.idx.vector.queryNodes('Dataset', 'emb', 5, vecf32([1.0])) YIELD node RETURN node",
     FALKORDB),
    ("CALL db.index.fulltext.queryNodes('names', 'cust') YIELD node RETURN node", NEO4J),
    ("CALL db.schema.visualization()", NEO4J),
    ("CALL `db`.`labels`()", NEO4J),
])
def test_read_procedures_may_be_called(query, engine):
    assert check(query, engine=engine)


@pytest.mark.parametrize("query, engine, at", [
    ("CALL apoc.load.json('https://example.com') YIELD value RETURN value", NEO4J, 5),
    ("CALL dbms.listConfig()", NEO4J, 5),
    ("CALL db.createLabel('X')", NEO4J, 5),
    ("CALL gds.pageRank.stream('g') YIELD nodeId RETURN nodeId", NEO4J, 5),
    ("CALL `apoc.load`.json('x') YIELD value RETURN value", NEO4J, 5),
    ("CALL algo.pageRank('X', 'R') YIELD node RETURN node", FALKORDB, 5),
    ("CALL db.idx.fulltext.createNodeIndex('X', 'name')", FALKORDB, 5),
    # Each engine's own names only.
    ("CALL db.index.fulltext.queryNodes('i', 'x') YIELD node RETURN node", FALKORDB, 5),
    ("CALL db.idx.fulltext.queryNodes('X', 'x') YIELD node RETURN node", NEO4J, 5),
    ("MATCH (n) CALL apoc.do.when(true, 'CREATE ()', '') YIELD value RETURN value", NEO4J, 15),
])
def test_other_procedures_are_refused(query, engine, at):
    refused = refusal(query, engine)
    assert isinstance(refused, NativeQueryRefused)
    assert refused.position == at
    assert "isn't a procedure native queries may call" in str(refused)


def test_call_needs_a_procedure_or_a_subquery():
    assert check("MATCH (n) CALL (n) { RETURN n.x AS x } RETURN x", engine=NEO4J)
    assert "needs a procedure" in str(refusal("CALL 1"))


@pytest.mark.parametrize("query, engine", [
    ("RETURN date.truncate('day', date()) AS d", NEO4J),
    ("RETURN duration.between(date('2024-01-01'), date()) AS d", NEO4J),
    ("RETURN vector.similarity.cosine([1.0, 0.0], [0.0, 1.0]) AS s", NEO4J),
    ("RETURN point.distance(point({x: 0, y: 0}), point({x: 3, y: 4})) AS d", NEO4J),
    ("RETURN string.join(['a', 'b'], ',') AS s", FALKORDB),
    ("RETURN list.dedup([1, 1, 2]) AS l", FALKORDB),
    ("RETURN vec.cosineDistance(vecf32([1.0]), vecf32([1.0])) AS d", FALKORDB),
    ("MATCH (n) RETURN toLower(n.name), size(n.tags), coalesce(n.x, 0)", NEO4J),
])
def test_built_in_functions_may_be_used(query, engine):
    assert check(query, engine=engine)


@pytest.mark.parametrize("query, engine, at", [
    ("RETURN apoc.coll.sum([1, 2]) AS s", NEO4J, 7),
    ("RETURN apoc.text.urlencode('x') AS s", NEO4J, 7),
    ("MATCH (n) RETURN gds.util.asNode(id(n)) AS x", NEO4J, 17),
    ("RETURN `apoc.coll.sum`([1]) AS s", NEO4J, 7),
    ("RETURN `apoc`.coll.sum([1]) AS s", NEO4J, 7),
    ("RETURN myplugin.lookup('x') AS s", FALKORDB, 7),
    # Each engine's own namespaces only.
    ("RETURN string.join(['a'], ',') AS s", NEO4J, 7),
    ("RETURN date.truncate('day', date()) AS d", FALKORDB, 7),
])
def test_plugin_functions_are_refused(query, engine, at):
    refused = refusal(query, engine)
    assert isinstance(refused, NativeQueryRefused)
    assert refused.position == at
    assert "isn't a function native queries may use" in str(refused)


def test_one_statement_at_a_time():
    refused = refusal("MATCH (n) RETURN n; MATCH (m) DETACH DELETE m")
    assert refused.position == 18
    assert str(refused) == "Run one statement at a time."


def test_values_go_in_the_text():
    refused = refusal("MATCH (n) WHERE n.urn = $urn RETURN n")
    assert refused.position == 24
    assert "$urn" in str(refused)


@pytest.mark.parametrize("query, at", [
    ("RETURN 'never closed", 7),
    ("MATCH (n RETURN n", 6),
    ("RETURN 1 /* open", 9),
    ("RETURN #", 7),
])
def test_text_cypher_cannot_hold_is_a_syntax_error(query, at):
    refused = refusal(query)
    assert isinstance(refused, NativeQuerySyntaxError)
    assert refused.position == at


@pytest.mark.parametrize("brk", ["\r", "\x0b", "\x0c", "\x85", "\u2028", "\u2029"])
def test_a_line_break_engines_read_differently_is_refused(brk):
    """Neo4j ends a // comment at a lone \\r and FalkorDB doesn't: left in,
    text one engine runs could be a comment to the guard."""
    refused = refusal(f"MATCH (n) // a note{brk}RETURN n")
    assert isinstance(refused, NativeQueryRefused)
    assert refused.position == len("MATCH (n) // a note")


def test_normalized_line_breaks_leave_nothing_hidden_in_a_comment():
    assert normalized("MATCH (n)\r\nRETURN n\rLIMIT 1") == "MATCH (n)\nRETURN n\nLIMIT 1"
    # On Neo4j, what follows the \\r would run, while a lexer reading to \\n
    # would call it a comment. Normalized, the guard sees it.
    trick = "MATCH (n) WITH n // x\rLOAD CSV FROM 'file:///etc/passwd' AS l WITH l //\nRETURN l"
    refused = refusal(normalized(trick))
    assert str(refused).startswith("LOAD")
    assert refused.position == trick.index("LOAD")


@pytest.mark.parametrize("query", ["", "   ", "// only a comment"])
def test_an_empty_query_asks_for_one(query):
    assert str(refusal(query)) == "Write a query to run."


# ---------------------------------------------------------------------------
# Seeded fuzz: the guard only ever refuses — it never crashes — and where a
# keyword stands decides, never whether its letters appear.
# ---------------------------------------------------------------------------

_DENIED = ["CREATE", "MERGE", "SET", "DELETE", "REMOVE", "DROP", "LOAD", "USE", "FOREACH"]
_HIDING = [
    "RETURN '{w}' AS x",
    'RETURN "{w} (n)" AS x',
    "RETURN 1 AS x // {w} (n)",
    "RETURN 1 AS x /* {w} (n) */",
    "RETURN n.`{w}` AS x",
    "RETURN n.{w} AS x",
    "MATCH (m:{w}) RETURN m AS x",
    "RETURN {{{w}: 1}} AS x",
]
_SOUP = list("()[]{},;:.|=<>+-*/%^!'\"`$ \n\t_aZ09") + ["MATCH", "RETURN", "CALL", "CREATE",
                                                        "//", "/*", "*/", "..", "->", "<-"]


def test_the_guard_never_crashes_on_any_text():
    rng = random.Random(566)
    for _ in range(5000):
        text = "".join(rng.choice(_SOUP) for _ in range(rng.randint(0, 40)))
        for engine in (FALKORDB, NEO4J):
            try:
                check(text, engine=engine)
            except NativeQueryError:
                pass  # A refusal is an answer; any other exception fails the test.


def test_a_keyword_counts_only_where_a_keyword_stands():
    rng = random.Random(1024)
    for _ in range(500):
        word = rng.choice(_DENIED)
        word = word if rng.random() < 0.5 else word.lower()
        hidden = rng.choice(_HIDING).format(w=word)
        assert check(f"MATCH (n) {hidden}", engine=NEO4J)
        bare = f"MATCH (n) {word} (m) {hidden}"
        refused = refusal(bare)
        assert isinstance(refused, NativeQueryRefused)
        assert refused.position == len("MATCH (n) ")

"""Cypher-execution kernel types.

See ``executor.py``: ``CypherResult`` (the engine-neutral wrapper around
one query's driver-native result) and ``CypherExecutor`` (the Protocol a
graph-database adapter implements so algorithmic code can run a query
without knowing which engine answers it).
"""

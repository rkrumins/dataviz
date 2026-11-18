"""``verify-schema`` compares the ORM's column types with what Postgres reflects. A ``Float`` with
no precision is stored as ``double precision``: it must read as the same type, or every such
column is reported as a mismatch and the Schema gate fails on a database that matches the ORM."""
from sqlalchemy import Float, Integer, Numeric, Text
from sqlalchemy.dialects import postgresql

from backend.scripts.upgrade import _type_name

D = postgresql.dialect()


def test_a_float_is_double_precision_as_postgres_stores_it():
    assert _type_name(Float(), D) == _type_name(postgresql.DOUBLE_PRECISION(), D) == "DOUBLE PRECISION"


def test_other_types_are_named_as_compiled():
    assert _type_name(Integer(), D) == "INTEGER"
    assert _type_name(Text(), D) == "TEXT"
    assert _type_name(Numeric(10, 2), D) == "NUMERIC(10, 2)"
    assert _type_name(postgresql.REAL(), D) == "REAL"

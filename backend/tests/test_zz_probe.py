"""Positive controls for the 7 new tests: would they fail if the control broke?"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from backend.app.api.v1.endpoints import profiling
from backend.tests.test_profiling_endpoints import (
    _two_tenants, _board, workspace_claims, OPERATOR, NOBODY,
)


async def _series(session, claims, scope, id_):
    return (await profiling.get_series(
        scope=scope, id=id_, window="24h", frm=None, to=None,
        grain="raw", metric="nodes", breakdown="none", top=8, compare=False,
        session=session, claims=claims,
    ))["data"]


async def test_PC_operator_workspace_series_ws2_is_nonzero(db_session: AsyncSession):
    """If this is 0, test_a_workspace_scoped_series_cannot_read_another_tenant
    is vacuous: nobody can see ws_2 raw at all."""
    await _two_tenants(db_session)
    p = await _series(db_session, OPERATOR, "workspace", "ws_2")
    print("OPERATOR ws_2 sources_observed =", p["sources_observed"], "grain=", p["grain"])
    assert p["sources_observed"] == 1


async def test_PC_operator_provider_series_prov2_is_nonzero(db_session: AsyncSession):
    await _two_tenants(db_session)
    p = await _series(db_session, OPERATOR, "provider", "prov_2")
    print("OPERATOR prov_2 sources_observed =", p["sources_observed"], "grain=", p["grain"])
    assert p["sources_observed"] == 1


async def test_PC_ws1_caller_own_workspace_series_is_nonzero(db_session: AsyncSession):
    await _two_tenants(db_session)
    p = await _series(db_session, workspace_claims("ws_1"), "workspace", "ws_1")
    print("ws_1 caller ws_1 sources_observed =", p["sources_observed"], "grain=", p["grain"])
    assert p["sources_observed"] == 1

"""A version-controlled data source reads through ``VersionedBranchProvider``, which does not
inherit ``GraphDataProvider``, so it has to answer ``resolve_identities`` itself. Without it,
exporting a view couldn't name its entities, the targets an import suggests couldn't be probed,
and every entity checked against such a data source came back "couldn't be checked".

The answer keeps the three states: found, absent, and (a lookup that failed) left out, so
unknown and never counted as missing.
"""
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider


class _Svc:
    def __init__(self, held, fail=False):
        self.held, self.fail, self.asked = held, fail, []

    async def get_nodes_from_state(self, *, graph_id, branch_id, urns, **kw):
        self.asked.append((graph_id, branch_id, list(urns or [])))
        if self.fail:
            raise RuntimeError("the state read failed")
        return [{"urn": u, "entityType": t, "displayName": n} for u, (t, n) in self.held.items() if u in (urns or [])]


async def test_found_and_absent_on_the_branch():
    svc = _Svc({"urn:orders": ("Table", "orders")})
    provider = VersionedBranchProvider(svc, graph_id="g1", branch_id="main")
    out = await provider.resolve_identities(["urn:orders", "urn:gone"])
    assert out == {"urn:orders": {"type": "Table", "name": "orders", "qualifiedName": None}, "urn:gone": None}
    assert svc.asked == [("g1", "main", ["urn:orders", "urn:gone"])], "one bounded read, on this branch"


async def test_a_failed_read_leaves_them_unknown_never_missing():
    provider = VersionedBranchProvider(_Svc({}, fail=True), graph_id="g1", branch_id="main")
    assert await provider.resolve_identities(["urn:orders"]) == {}

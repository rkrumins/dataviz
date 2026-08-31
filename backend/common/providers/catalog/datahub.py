"""DataHub's entry in the provider catalog.

DataHub is known-uninstantiable today: ``DataHubGraphQLProvider`` is
missing 6 abstract members (``create_edge``, ``delete_edge``,
``get_aggregated_edges_between``, ``get_full_lineage``,
``get_trace_lineage``, ``update_edge``) and its file is not edited this
PR -- see ``KNOWN_UNINSTANTIABLE`` in ``test_provider_catalog_classes.py``.
It still gets a full descriptor (and stays in the catalog / DB CHECK /
enum) because a saved ``datahub`` provider row is a real, existing thing
the read-only surface (ping/get_stats/get_ontology_metadata) serves today.

``auth="token"`` is deliberate: DataHub reads a bearer token, never a
username/password pair, so a wizard driven by this descriptor stops
sending credentials it would silently ignore.
"""
from backend.common.interfaces.provider import ProviderCapability

from . import register
from .descriptor import ConnectionShape, ProviderDescriptor, ProviderRequestError, ProviderSpec


def _build(spec: ProviderSpec):
    from backend.graph.adapters.datahub_provider import DataHubGraphQLProvider
    return DataHubGraphQLProvider(
        base_url=spec.host or "",
        token=spec.credentials.get("token"),
    )


def _validate(req) -> None:
    if not (req.host or "").strip():
        raise ProviderRequestError("DataHub requires a base URL (host).")


DESCRIPTOR = register(ProviderDescriptor(
    id="datahub",
    label="DataHub",
    description="DataHub metadata platform via its GraphQL API (read-only).",
    docs_url=None,
    family="graphql",
    capability=ProviderCapability(writable=False, full_crud=False, is_external=True, supports_copy=False),
    connection=ConnectionShape(
        kind="generic",
        uses_host_port=True,   # the host field is the GraphQL base URL
        default_port=8080,
        tls="none",
        auth="token",
        secret_credential_keys=("token",),
    ),
    build=_build,
    validate=_validate,
    provider_class_path="backend.graph.adapters.datahub_provider:DataHubGraphQLProvider",
))

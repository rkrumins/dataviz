"""Spanner's entry in the provider catalog.

``_build`` is ``manager.py``'s former ``elif provider_type == "spanner":``
branch, unchanged, including the ``SYNODIC_ALLOW_SPANNER_EMULATOR`` env
gate and both ``ValueError`` messages character-for-character --
``tests/regression/test_spanner_provider_contract.py`` /
``test_phase0_spanner_create_flow.py`` pin the emulator-rejection wording.
``_validate`` is the host/port rejection ``test_unsaved_provider_connection``
raises today, moved to a transport-agnostic ``ProviderRequestError`` --
the endpoint (a later task) maps it back to HTTP 422.
"""
from backend.common.interfaces.provider import ProviderCapability, ProviderFeature

from . import register
from .descriptor import ConnectionShape, ProviderDescriptor, ProviderRequestError, ProviderSpec


def _build(spec: ProviderSpec):
    # Spanner uses GCP project/instance/database identifiers rather
    # than host/port. They live on extra_config; credentials carry
    # the service-account JSON.
    import os as _os
    from backend.graph.adapters.spanner_provider import SpannerProvider
    creds = spec.credentials
    cfg = dict(spec.extra_config or {})
    use_emulator = bool(cfg.get("useEmulator", False))
    # Prevent the cloud-spanner-emulator from ever being selected
    # outside an explicitly opted-in dev environment. The FE wizard
    # already hides the toggle in production builds; this is the
    # corresponding server-side defense so a hand-crafted payload
    # cannot route a real provider at localhost:9010.
    if use_emulator and not _os.getenv("SYNODIC_ALLOW_SPANNER_EMULATOR"):
        raise ValueError(
            "Spanner emulator mode (extra_config.useEmulator=true) is "
            "disabled by default. Set SYNODIC_ALLOW_SPANNER_EMULATOR=1 "
            "in the backend environment to enable it for local development."
        )
    project_id = cfg.get("projectId") or creds.get("project_id")
    instance_id = cfg.get("instanceId")
    database_id = cfg.get("databaseId") or spec.graph_name
    if not project_id or not instance_id or not database_id:
        raise ValueError(
            "Spanner provider requires extra_config.projectId, "
            "extra_config.instanceId, and (extra_config.databaseId or graph_name). "
            f"Got project={project_id!r} instance={instance_id!r} database={database_id!r}."
        )
    return SpannerProvider(
        project_id=project_id,
        instance_id=instance_id,
        database_id=database_id,
        graph_name=cfg.get("graphName") or "UniViz",
        credentials_json=creds.get("service_account_json"),
        use_emulator=use_emulator,
        extra_config=cfg,
    )


def _validate(req) -> None:
    # Spanner is a managed gRPC service keyed on project / instance /
    # database (in extra_config). It does NOT use host/port. Reject
    # ambiguous requests so a misconfigured client doesn't silently
    # bypass the project/instance/database addressing -- emulator mode
    # is opt-in via extra_config.useEmulator, not via host=localhost.
    if req.host or req.port:
        raise ProviderRequestError(
            "Spanner is a managed service; host/port are not used. "
            "Provide projectId, instanceId, databaseId via extra_config; "
            "for the cloud-spanner-emulator set extra_config.useEmulator=true."
        )


DESCRIPTOR = register(ProviderDescriptor(
    id="spanner",
    label="Google Spanner",
    description="Google Cloud Spanner Graph (property-graph schema).",
    docs_url=None,
    family="gql",
    capability=ProviderCapability(
        writable=True, full_crud=True, is_external=False, supports_copy=False,
        features=frozenset({ProviderFeature.SCHEMA_DISCOVERY, ProviderFeature.MULTI_GRAPH}),
    ),
    connection=ConnectionShape(
        kind="spanner",
        uses_host_port=False,
        default_port=None,
        tls="none",
        auth="service_account",
        secret_credential_keys=("project_id", "service_account_json"),
        extra_config_keys=("projectId", "instanceId", "databaseId", "graphName", "useEmulator", "schemaMapping"),
    ),
    build=_build,
    validate=_validate,
    provider_class_path="backend.graph.adapters.spanner_provider:SpannerProvider",
))

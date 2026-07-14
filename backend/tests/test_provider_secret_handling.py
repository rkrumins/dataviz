"""Five verified defects, fixed here.

1. falkordbConnection.sentinel.password rode extra_config — a PLAINTEXT column
   (db/models.py ProviderORM.extra_config) that ProviderResponse RETURNS to clients.
2. Other extra_config sub-objects (and rows already in the DB) were echoed back
   unredacted, including a password hiding inside a URL's userinfo (legacy
   Neo4j extra_config["redisUrl"]).
3. provider_repo did `row.credentials = _encrypt(req.credentials.model_dump())` — a
   full replace, so a partial update wiped every omitted secret.
4. (found during a later task, same class) DataSourceCreateRequest/UpdateRequest had
   no extra_config validator at all — a secret or cluster-mode cacheConnection could
   be smuggled in through the data-source endpoint even though the sibling Provider
   endpoint blocks it.
5. cacheConnection sentinel mode checked for masterName/nodes presence but never
   validated the node list SHAPE, unlike falkordbConnection's sentinel validation.
6. (CRITICAL, found in a later code review) _validate_falkordb_connection had NO
   secret-key scan at all — unlike _validate_cache_connection's recursive `_scan` —
   so a brand-new ProviderCreateRequest with extraConfig.falkordbConnection.
   sentinel.password passed validation and landed in the plaintext column. Fixed by
   extracting the scan into a shared `_reject_secret_keys(block, *, path)` helper
   used by BOTH validators. It treats the redaction sentinel "***" (and empty/None)
   as "not a new secret" so a GET-then-PUT round-trip of an existing row keeps
   working.
7. (CRITICAL, same review) `_SECRET_HINTS` was too narrow (password/passwd/secret/
   token/credential) and gated both write-rejection AND read-redaction, so
   apiKey/accessKey/privateKey/pw/pass leaked through both. Broadened + normalized
   (lowercase, "_"/"-" stripped) so "api_key"/"apiKey"/"API-KEY" all match one hint.
"""
import logging

import pytest
from pydantic import ValidationError

from backend.common.models.management import redact_extra_config


# ── (2) redaction ────────────────────────────────────────────────────────────

def test_redaction_strips_secret_keys_from_extra_config():
    out = redact_extra_config({
        "falkordbConnection": {
            "mode": "sentinel",
            "sentinel": {"masterName": "m", "username": "su", "password": "LEAK"},
        },
        "cacheConnection": {"host": "h"},
    })
    assert out["falkordbConnection"]["sentinel"]["password"] == "***"
    assert out["falkordbConnection"]["sentinel"]["masterName"] == "m"
    assert out["cacheConnection"]["host"] == "h"


def test_redaction_is_recursive_and_case_insensitive():
    out = redact_extra_config({"a": {"b": {"authToken": "LEAK", "apiSecret": "LEAK"}}})
    assert out["a"]["b"]["authToken"] == "***"
    assert out["a"]["b"]["apiSecret"] == "***"


def test_redaction_recurses_through_lists():
    out = redact_extra_config({
        "items": [
            {"password": "LEAK"},
            {"nested": [{"apiToken": "LEAK2"}, {"host": "h2"}]},
        ],
    })
    assert out["items"][0]["password"] == "***"
    assert out["items"][1]["nested"][0]["apiToken"] == "***"
    assert out["items"][1]["nested"][1]["host"] == "h2"


def test_redaction_leaves_non_secret_values_intact():
    extra = {"host": "cache-b", "port": 6379, "enabled": True, "nodes": ["h1:1", "h2:2"]}
    out = redact_extra_config(extra)
    assert out == extra


def test_redaction_masks_url_userinfo_password():
    """Defect 4 (found during a later task): a secret hiding INSIDE a value under
    a non-secret-looking key — e.g. the legacy Neo4j extra_config["redisUrl"] —
    is not caught by the key-name scan alone."""
    out = redact_extra_config({"redisUrl": "redis://appuser:leaked-pw@cache-host:6379/0"})
    assert "leaked-pw" not in out["redisUrl"]
    assert out["redisUrl"] == "redis://appuser:***@cache-host:6379/0"


def test_redaction_url_userinfo_without_password_untouched():
    out = redact_extra_config({"url": "redis://cache-host:6379/0"})
    assert out["url"] == "redis://cache-host:6379/0"


def test_redaction_none_and_empty_passthrough():
    assert redact_extra_config(None) is None
    assert redact_extra_config({}) == {}


# ── (1) sentinel credentials: encrypted-blob-first, plaintext fallback ───────

def test_sentinel_password_old_plaintext_location_still_loads_with_warning(caplog):
    from backend.app.providers.falkordb_connection import load_connection_config

    with caplog.at_level(logging.WARNING):
        cfg = load_connection_config(
            {
                "mode": "sentinel",
                "sentinel": {
                    "masterName": "m",
                    "nodes": [["h", 26379]],
                    "password": "leaked-sentinel-pw",
                },
            },
            host="h", port=6379, username=None, password=None,
            credentials=None,
        )
    assert cfg.sentinel_password == "leaked-sentinel-pw"
    assert any("PLAINTEXT" in r.message for r in caplog.records)


def test_sentinel_password_prefers_encrypted_credentials_blob(caplog):
    """When both locations carry a value, the encrypted blob wins and no
    migration warning is logged (nothing plaintext is actually in play)."""
    from backend.app.providers.falkordb_connection import load_connection_config

    with caplog.at_level(logging.WARNING):
        cfg = load_connection_config(
            {
                "mode": "sentinel",
                "sentinel": {"masterName": "m", "nodes": [["h", 26379]]},
            },
            host="h", port=6379, username=None, password=None,
            credentials={
                "sentinel_username": "encrypted-su",
                "sentinel_password": "encrypted-sp",
            },
        )
    assert cfg.sentinel_username == "encrypted-su"
    assert cfg.sentinel_password == "encrypted-sp"
    assert not any("PLAINTEXT" in r.message for r in caplog.records)


async def test_sentinel_password_old_location_not_present_in_provider_response(db_session):
    """The redaction pass covers rows migrated by defect (1) as well: even
    before a provider is re-saved, its response never echoes the plaintext
    sentinel password back.

    Inserted directly at the ORM layer (bypassing ProviderCreateRequest):
    _validate_falkordb_connection now scans for secret-named keys too (see
    the "falkordbConnection secret scan" tests below) and refuses this exact
    payload as a NEW request, so the only way this shape exists is a row
    that predates that validator — which is precisely what this test is
    about."""
    import json as _json
    from backend.app.db.models import ProviderORM
    from backend.app.db.repositories import provider_repo

    row = ProviderORM(
        id="prov_sentinel_legacy",
        name="sentinel-legacy",
        provider_type="falkordb",
        host="h", port=6379,
        tls_enabled=False, is_active=True,
        extra_config=_json.dumps({
            "falkordbConnection": {
                "mode": "sentinel",
                "sentinel": {
                    "masterName": "m",
                    "nodes": [["h", 26379]],
                    "password": "leaked-sentinel-pw",
                },
            },
        }),
    )
    db_session.add(row)
    await db_session.flush()

    fetched = await provider_repo.get_provider(db_session, row.id)
    assert fetched.extra_config["falkordbConnection"]["sentinel"]["password"] == "***"
    assert "leaked-sentinel-pw" not in str(fetched.model_dump())


async def test_redis_url_password_masked_in_provider_response(db_session):
    """Defect 4: a provider row carrying the legacy Neo4j redisUrl alias with an
    embedded password must not echo it back either."""
    from backend.app.db.repositories import provider_repo
    from backend.common.models.management import ProviderCreateRequest

    created = await provider_repo.create_provider(db_session, ProviderCreateRequest(
        name="neo4j-legacy", providerType="neo4j", host="h", port=7687,
        credentials={"username": "u", "password": "p"},
        extraConfig={"redisUrl": "redis://appuser:leaked-pw@cache-host:6379/0"},
    ))
    fetched = await provider_repo.get_provider(db_session, created.id)
    assert "leaked-pw" not in fetched.extra_config["redisUrl"]
    assert fetched.extra_config["redisUrl"] == "redis://appuser:***@cache-host:6379/0"


# ── (3) merge-not-replace credentials ─────────────────────────────────────────

async def test_partial_credentials_update_does_not_wipe_other_secrets(db_session):
    """Updating ONLY the cache password must not blank the FalkorDB password."""
    from backend.app.db.repositories import provider_repo
    from backend.common.models.management import (
        ProviderCreateRequest, ProviderUpdateRequest,
    )

    created = await provider_repo.create_provider(db_session, ProviderCreateRequest(
        name="p", providerType="falkordb", host="h", port=6379,
        credentials={"username": "graph-u", "password": "graph-pw"},
    ))
    await provider_repo.update_provider(db_session, created.id, ProviderUpdateRequest(
        credentials={"cache_password": "cache-pw"},
    ))
    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds["cache_password"] == "cache-pw"
    assert creds["password"] == "graph-pw"      # NOT wiped
    assert creds["username"] == "graph-u"


async def test_explicit_null_clears_a_credential(db_session):
    from backend.app.db.repositories import provider_repo
    from backend.common.models.management import (
        ProviderCreateRequest, ProviderUpdateRequest,
    )

    created = await provider_repo.create_provider(db_session, ProviderCreateRequest(
        name="p2", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "password": "pw"},
    ))
    await provider_repo.update_provider(db_session, created.id, ProviderUpdateRequest(
        credentials={"password": None}, credentials_clear=["password"],
    ))
    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds.get("password") in (None, "")
    assert creds["username"] == "u"


async def test_credentials_clear_alone_removes_the_key(db_session):
    """`credentialsClear` must work even when the caller sends no other
    `credentials` field in the same request."""
    from backend.app.db.repositories import provider_repo
    from backend.common.models.management import (
        ProviderCreateRequest, ProviderUpdateRequest,
    )

    created = await provider_repo.create_provider(db_session, ProviderCreateRequest(
        name="p3", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "password": "pw"},
    ))
    await provider_repo.update_provider(db_session, created.id, ProviderUpdateRequest(
        credentials_clear=["password"],
    ))
    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds.get("password") in (None, "")
    assert creds["username"] == "u"


# ── (4) data-source endpoint: same validation gate as Provider ───────────────

def test_data_source_create_rejects_secret_in_extra_config():
    from backend.common.models.management import DataSourceCreateRequest

    with pytest.raises(ValidationError, match="credentials"):
        DataSourceCreateRequest(
            providerId="prov_x",
            extraConfig={"cacheConnection": {"host": "h", "password": "leaked"}},
        )


def test_data_source_create_rejects_cluster_mode_cache():
    from backend.common.models.management import DataSourceCreateRequest

    with pytest.raises(ValidationError, match="cluster"):
        DataSourceCreateRequest(
            providerId="prov_x",
            extraConfig={"cacheConnection": {"mode": "cluster", "host": "h"}},
        )


def test_data_source_update_rejects_secret_in_extra_config():
    from backend.common.models.management import DataSourceUpdateRequest

    with pytest.raises(ValidationError, match="credentials"):
        DataSourceUpdateRequest(
            extraConfig={"cacheConnection": {"host": "h", "authToken": "leaked"}},
        )


def test_data_source_create_accepts_clean_extra_config():
    from backend.common.models.management import DataSourceCreateRequest

    req = DataSourceCreateRequest(
        providerId="prov_x",
        extraConfig={"cacheConnection": {"mode": "standalone", "host": "h"}},
    )
    assert req.extra_config["cacheConnection"]["host"] == "h"


async def test_data_source_response_redacts_a_secret_already_in_the_row(db_session):
    """Rows written before the request-boundary validator existed can still hold
    a secret in the plaintext column; the response must redact it on read."""
    import json as _json
    from backend.app.db.models import WorkspaceORM, WorkspaceDataSourceORM
    from backend.app.db.repositories import provider_repo, data_source_repo
    from backend.common.models.management import ProviderCreateRequest

    provider = await provider_repo.create_provider(db_session, ProviderCreateRequest(
        name="ds-secret-provider", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "password": "p"},
    ))
    ws = WorkspaceORM(id="ws_secret_test", name="WS")
    db_session.add(ws)
    await db_session.flush()

    row = WorkspaceDataSourceORM(
        id="ds_secret_test",
        workspace_id="ws_secret_test",
        provider_id=provider.id,
        graph_name="g",
        is_primary=True,
        is_active=True,
        extra_config=_json.dumps({"cacheConnection": {"host": "h", "password": "LEAKED"}}),
    )
    db_session.add(row)
    await db_session.flush()

    resp = await data_source_repo.get_data_source(db_session, "ds_secret_test")
    assert resp is not None
    assert resp.extra_config["cacheConnection"]["password"] == "***"
    assert resp.extra_config["cacheConnection"]["host"] == "h"


# ── (5) cacheConnection.sentinel.nodes shape validation ──────────────────────

def test_cache_sentinel_malformed_node_list_rejected():
    from backend.common.models.management import ProviderCreateRequest

    with pytest.raises(ValidationError, match="sentinel.nodes"):
        ProviderCreateRequest(
            name="p", providerType="falkordb", host="h", port=6379,
            credentials={"username": "u", "password": "p"},
            extraConfig={"cacheConnection": {
                "mode": "sentinel",
                "sentinel": {"masterName": "m", "nodes": ["not-a-valid-node"]},
            }},
        )


def test_cache_sentinel_well_formed_node_list_is_accepted():
    from backend.common.models.management import ProviderCreateRequest

    req = ProviderCreateRequest(
        name="p", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "password": "p"},
        extraConfig={"cacheConnection": {
            "mode": "sentinel",
            "sentinel": {"masterName": "m", "nodes": [["h1", 26379]]},
        }},
    )
    assert req.extra_config["cacheConnection"]["sentinel"]["masterName"] == "m"


# ── (6) falkordbConnection secret scan (CRITICAL 1) ───────────────────────────

def test_falkordb_sentinel_password_new_secret_is_rejected():
    """The bug: _validate_falkordb_connection had no secret-key scan at all, so
    this exact payload used to pass and land in the plaintext column."""
    from backend.common.models.management import ProviderCreateRequest

    with pytest.raises(ValidationError, match="credentials"):
        ProviderCreateRequest(
            name="p", providerType="falkordb", host="h", port=6379,
            credentials={"username": "u", "password": "p"},
            extraConfig={"falkordbConnection": {
                "mode": "sentinel",
                "sentinel": {
                    "masterName": "m",
                    "nodes": [["h", 26379]],
                    "password": "real-secret",
                },
            }},
        )


def test_falkordb_secret_anywhere_in_tree_is_rejected():
    """Not just sentinel.password — any secret-named key anywhere under
    falkordbConnection (e.g. a hypothetical cluster-auth token)."""
    from backend.common.models.management import ProviderCreateRequest

    with pytest.raises(ValidationError, match="credentials"):
        ProviderCreateRequest(
            name="p", providerType="falkordb", host="h", port=6379,
            credentials={"username": "u", "password": "p"},
            extraConfig={"falkordbConnection": {
                "mode": "cluster",
                "cluster": {"startupNodes": [["h", 6379]], "authToken": "leaked"},
            }},
        )


def test_falkordb_sentinel_password_redaction_placeholder_round_trips():
    """Back-compat: redact_extra_config masks an existing sentinel.password to
    "***" on read. A client that GETs a provider and PUTs it back unmodified
    sends that placeholder back — the scan must accept it, not reject it as a
    new secret, or every round-trip update of an existing FalkorDB-sentinel
    provider breaks."""
    from backend.common.models.management import ProviderUpdateRequest

    req = ProviderUpdateRequest(
        extraConfig={"falkordbConnection": {
            "mode": "sentinel",
            "sentinel": {
                "masterName": "m",
                "nodes": [["h", 26379]],
                "password": "***",
            },
        }},
    )
    assert req.extra_config["falkordbConnection"]["sentinel"]["password"] == "***"


def test_falkordb_sentinel_password_empty_and_none_also_round_trip():
    from backend.common.models.management import ProviderUpdateRequest

    for placeholder in (None, ""):
        req = ProviderUpdateRequest(
            extraConfig={"falkordbConnection": {
                "mode": "sentinel",
                "sentinel": {
                    "masterName": "m",
                    "nodes": [["h", 26379]],
                    "password": placeholder,
                },
            }},
        )
        assert req.extra_config["falkordbConnection"]["sentinel"]["password"] == placeholder


def test_non_secret_falkordb_keys_are_accepted_by_the_validator():
    """False-positive check: none of the legitimate non-secret falkordbConnection
    fields — including keyPath, a diagnostic cert-file PATH, not a secret — trip
    the new scan."""
    from backend.common.models.management import ProviderCreateRequest

    req = ProviderCreateRequest(
        name="p", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "password": "p"},
        extraConfig={"falkordbConnection": {
            "mode": "sentinel",
            "authEnabled": True,
            "socketTimeout": 5,
            "graphPoolSize": 10,
            "sentinel": {"masterName": "m", "nodes": [["h", 26379]]},
            "tls": {
                "enabled": True,
                "checkHostname": True,
                "verifyMode": "required",
                "caCertPath": "/certs/ca.crt",
                "certPath": "/certs/client.crt",
                "keyPath": "/certs/client.key",
            },
        }},
    )
    fc = req.extra_config["falkordbConnection"]
    assert fc["authEnabled"] is True
    assert fc["sentinel"]["masterName"] == "m"
    assert fc["tls"]["keyPath"] == "/certs/client.key"
    assert fc["tls"]["caCertPath"] == "/certs/ca.crt"
    assert fc["tls"]["certPath"] == "/certs/client.crt"


# ── (7) broadened _SECRET_HINTS (CRITICAL 2) ──────────────────────────────────

@pytest.mark.parametrize("secret_key", [
    "apiKey", "api_key", "API-KEY", "accessKey", "access_key",
    "privateKey", "private_key", "pw", "pass", "pwd", "signingKey",
])
def test_broadened_secret_hints_rejected_in_cache_connection(secret_key):
    """The live-leak scenario from the review: apiKey/accessKey/privateKey/pw/
    pass all passed validation under the old narrow hint set."""
    from backend.common.models.management import ProviderCreateRequest

    with pytest.raises(ValidationError, match="credentials"):
        ProviderCreateRequest(
            name="p", providerType="falkordb", host="h", port=6379,
            credentials={"username": "u", "password": "p"},
            extraConfig={"cacheConnection": {"host": "h", secret_key: "sk-LIVE"}},
        )


def test_broadened_secret_hints_redacted_everywhere():
    out = redact_extra_config({
        "cacheConnection": {
            "apiKey": "sk-LIVE",
            "accessKey": "ak-LIVE",
            "privateKey": "pk-LIVE",
            "pw": "pw-LIVE",
            "pass": "pass-LIVE",
        },
    })
    conn = out["cacheConnection"]
    assert conn["apiKey"] == "***"
    assert conn["accessKey"] == "***"
    assert conn["privateKey"] == "***"
    assert conn["pw"] == "***"
    assert conn["pass"] == "***"


def test_non_secret_keys_are_not_redacted():
    """False-positive check: none of the legitimate non-secret keys — in
    particular keyPath (a diagnostic path, not a secret) and authEnabled (a
    boolean, not a secret) — get masked. keyPath must stay visible on the
    Admin page."""
    out = redact_extra_config({
        "falkordbConnection": {
            "mode": "sentinel",
            "authEnabled": True,
            "sentinel": {"masterName": "m"},
            "tls": {
                "caCertPath": "/certs/ca.crt",
                "certPath": "/certs/client.crt",
                "keyPath": "/certs/client.key",
            },
        },
    })
    fc = out["falkordbConnection"]
    assert fc["authEnabled"] is True
    assert fc["sentinel"]["masterName"] == "m"
    assert fc["tls"]["caCertPath"] == "/certs/ca.crt"
    assert fc["tls"]["certPath"] == "/certs/client.crt"
    assert fc["tls"]["keyPath"] == "/certs/client.key"


# ── merge no-op: explicit null credential without credentialsClear ───────────

async def test_explicit_null_credential_without_clear_is_merge_noop(db_session):
    """An explicit `{"credentials": {"cache_password": null}}` body — built the
    way FastAPI actually builds it, via model_validate, so __fields_set__ is
    exercised — must be a NO-OP merge (keeps the existing value). This is what
    distinguishes "omitted" from "explicit null": both end up filtered by
    `if v is not None` in provider_repo.update_provider's merge, but only
    because model_dump(exclude_unset=True) means the omitted sibling fields
    never entered `incoming` at all. Clearing a credential requires listing it
    in credentialsClear (see test_credentials_clear_alone_removes_the_key)."""
    from backend.app.db.repositories import provider_repo
    from backend.common.models.management import (
        ProviderCreateRequest, ProviderUpdateRequest,
    )

    created = await provider_repo.create_provider(db_session, ProviderCreateRequest(
        name="p4", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "cache_password": "cache-pw"},
    ))
    update_req = ProviderUpdateRequest.model_validate({"credentials": {"cache_password": None}})
    await provider_repo.update_provider(db_session, created.id, update_req)

    creds = await provider_repo.get_credentials(db_session, created.id)
    assert creds["cache_password"] == "cache-pw"   # NOT cleared
    assert creds["username"] == "u"

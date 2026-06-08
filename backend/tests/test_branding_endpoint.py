"""Endpoint tests for the branding API.

The public GET must answer without auth (it backs the login page /
favicon / tab title before a session exists). The admin PATCH + upload
are exercised through the test client's fake-admin claims.
"""
import base64

from httpx import AsyncClient


# ── public GET ────────────────────────────────────────────────────────

async def test_public_branding_returns_camel_case_payload(
    test_client: AsyncClient, monkeypatch,
):
    monkeypatch.setenv("APP_BRAND_NAME", "Acme Lineage")
    resp = await test_client.get("/api/v1/branding")
    assert resp.status_code == 200
    body = resp.json()
    # camelCase aliases, env default applied (no seeded row in tests).
    assert body["appName"] == "Acme Lineage"
    assert "accentColor" in body
    assert "logoUrl" in body
    assert body["version"] == 0


# ── admin PATCH ───────────────────────────────────────────────────────

async def test_admin_patch_updates_and_persists(test_client: AsyncClient):
    resp = await test_client.patch(
        "/api/v1/admin/branding",
        json={"appName": "Branded Co", "accentColor": "#ff0000"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["appName"] == "Branded Co"
    assert body["accentColor"] == "#ff0000"

    # Re-read through the public endpoint — change is persisted.
    again = await test_client.get("/api/v1/branding")
    assert again.json()["appName"] == "Branded Co"


async def test_admin_patch_version_conflict_returns_409(test_client: AsyncClient):
    await test_client.patch(
        "/api/v1/admin/branding", json={"appName": "First"},
    )
    resp = await test_client.patch(
        "/api/v1/admin/branding",
        json={"appName": "Stale", "expectedVersion": 999},
    )
    assert resp.status_code == 409


# ── logo upload ───────────────────────────────────────────────────────

async def test_logo_upload_stored_as_data_uri(test_client: AsyncClient):
    png_bytes = b"\x89PNG\r\n\x1a\nfake"
    resp = await test_client.post(
        "/api/v1/admin/branding/logo",
        files={"file": ("logo.png", png_bytes, "image/png")},
    )
    assert resp.status_code == 200
    expected = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
    assert resp.json()["logoUrl"] == expected


async def test_logo_upload_rejects_bad_mime(test_client: AsyncClient):
    resp = await test_client.post(
        "/api/v1/admin/branding/logo",
        files={"file": ("logo.txt", b"nope", "text/plain")},
    )
    assert resp.status_code == 415

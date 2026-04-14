"""
Authentication service module.

Self-contained module that owns user identity, sessions, and authentication.
Designed to be lifted into a standalone microservice once SSO providers
(SAML2 / OIDC) are added. The only symbol other services should import is
``IdentityService`` from ``backend.auth_service.interface``.

Module boundary rule: nothing under ``backend/auth_service/`` may import from
``backend/app/`` (DB engine and ORM models are passed in at construction
time via dependency injection).
"""

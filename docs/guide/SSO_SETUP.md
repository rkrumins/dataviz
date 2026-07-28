# Single Sign-On

*For Administrators.* Connect your company's identity provider so people sign in
with the credentials they already have. This page walks the whole job — including
the half that happens in your IdP's console, not here.

> **Note:** *Mental model* — your IdP proves **who someone is**. {brand} decides
> **what they can do**. The claim mapping is the translation between the two, and
> group mapping is how their org chart becomes your permissions.

```mermaid
flowchart LR
  U[Person] --> IdP[Your identity provider]
  IdP -->|signed assertion| A[{brand}]
  A -->|claim mapping| P[Profile: name, email, groups]
  P -->|group mapping| R[Roles and workspaces]
```

---

## Before you start

You will need, in your IdP's admin console:

- Permission to register an application (Entra: *App registrations*; Okta:
  *Applications*; Keycloak: *Clients*).
- Somewhere to paste our **redirect URI** — the setup flow shows you the exact
  value with a copy button, and it must match to the character.

You do **not** need to know whether your provider speaks OIDC or SAML. Pick the
product by name and the flow works that out.

---

## The setup flow

**Admin → SSO → Connect a provider.** Five steps.

### 1. Which provider

Pick your product. This is not cosmetic — it fills in the claim names that
provider actually sends, a worked example of one of its payloads, and the
instructions for its console.

If yours is not listed, **Other OIDC provider** or **Other SAML 2.0 provider**
work with anything standards-compliant. **Corporate portal** is for the case
where something in front of {brand} has already signed the user in and hands
over their profile — see [Corporate portals](#corporate-portals) below.

### 2. Connect

Name the connection, then paste your issuer or metadata URL and press **Fetch**.
We read what your IdP publishes so you do not have to transcribe endpoints.

Alongside it you will see the values to paste into your IdP. Copy each one over
before continuing:

| Value | Where it goes |
|---|---|
| Redirect URI | The OIDC app's allowed redirect / callback URL |
| ACS URL | The SAML app's Assertion Consumer Service |
| Entity ID | The SAML app's audience / SP entity ID |
| SP metadata URL | Import this instead of setting the two above by hand |

> **Note:** If **Fetch** fails, you can still continue and type the values by
> hand. An unreachable discovery endpoint is common behind a firewall and does
> not mean the connection is wrong.

### 3. Map their fields to ours

Already filled in from your provider's known claim names. The preview underneath
runs your mapping against a real payload of that shape, so you can see a name and
an email address resolve before anyone has signed in.

**External ID** and **Email** are required — sign-in fails without them.
External ID must be the *stable* identifier (Entra's `oid`, not the username):
if it changes, existing accounts are orphaned.

Once someone has signed in, **Load last assertion** replaces the example with
what your IdP genuinely sent. Map against that in preference to anything else.

### 4. Try it yourself

Sign in with your own account. The connection is still a **draft** — invisible on
the sign-in page — so this is safe to get wrong.

This is the step that catches what the earlier ones cannot: whether the redirect
URI is really registered, whether the signature verifies, whether clocks agree,
and which account the sign-in would create or link. Nothing is written and no
session is created.

### 5. Publish

Only now does the connection appear on the sign-in page. Until you press it,
nobody but you can see it.

---

## After it is live

### Give people roles automatically

**Admin → SSO → Access mapping.** Map an IdP group to a role or to an internal
group. Reconciliation runs on every sign-in and every session refresh, so
removing someone from a group in your IdP removes the access here within a few
minutes.

Some roles cannot be granted this way. Platform-admin roles require a **verified**
connection, and `super_admin` can never be auto-granted at all — that one stays a
deliberate, manual act.

### Assurance: how much a connection's word is worth

| Level | Means |
|---|---|
| **Verified** | A signature over a third-party assertion was checked against a key we hold |
| **Asserted** | A trusted network position vouched for it — sound if your proxy strips inbound copies of the header, a full bypass if it does not |
| **Unverified** | We cannot tell a genuine claim from a forged one |

Shown on every connection. It is derived from how the connection is configured,
not stored, so it always reflects reality.

### When someone cannot sign in

They will see a short reference like `a1b2c3d4`. Ask them for it, then
**Admin → SSO → Activity** and search for it. The precise reason is recorded
there — deliberately not shown to the person, because it would leak your
configuration to anyone who can reach the sign-in page.

### Certificate expiry

A SAML signing certificate that expires takes every sign-in down at once, and the
date is readable months ahead. Each connection shows its remaining days, and warns
from 30 days out. After rotating a certificate, rehearse a sign-in rather than
waiting for a user to find the problem.

---

## Corporate portals

If a portal or authenticating proxy already signs people in on your internal
network, {brand} can accept the profile it hands over — via a cookie, browser
storage, or a request header.

Two things decide whether this is safe:

- **Sign the payload.** A signed JWT is what earns the connection a *verified*
  rating. An unsigned payload means anyone who can write that cookie can sign in
  as anyone.
- **If you use a header, strip inbound copies at the edge.** Otherwise a caller
  can set the header themselves and impersonate any user. This is why the
  header source is rated *asserted* rather than *verified* — from here, we cannot
  tell a correctly-configured proxy from a missing one.

---

## Turning things off

- **Turn off one connection** — the power button on its card. The configuration
  is kept; sign-ins through it stop.
- **Turn off all SSO** — Settings → *SSO enabled*. The master switch.
- **SSO only, no passwords** — Settings → *Allow local login*. Refused if it
  would lock out an admin who has no SSO identity.

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

Two columns. On the left, **they send** — every key in the payload. On the right,
**we store** — our fields, each resolving live as you edit.

Already filled in from your provider's known claim names, so the usual job is to
read it rather than write it. To change something, click a key on the left and
pick the field it belongs to.

Each of our fields shows three things: the value it resolved to, which key
produced it, and the full fallback list. The list is walked in order and the
first key with a value wins — so a key marked **shadowed** is one you are
maintaining for nothing, and can be dropped.

**External ID** and **Email** are required. If either resolves to nothing, the
row says so and sign-in would fail. External ID must be the *stable* identifier
(Entra's `oid`, not the username): if it changes, existing accounts are orphaned.

**First name** and **Last name** are marked *IdP-managed* once they resolve, and
that marker is a decision, not a label. A field your IdP supplies is re-synced on
every sign-in and becomes read-only on that person's own profile, attributed to
this connection — so your directory stays the single source of truth, and nobody
can drift away from it. Leave the row empty and the field stays theirs to edit.
**Full / display name** is never taken this way, whatever you map: it is the one
name a person can always choose for themselves.

> **Note:** *Where the sample came from matters.* Until someone signs in, the
> preview runs against a worked example of your vendor's payload — good enough to
> check the shape, but it is not your tenant. The bar above the columns says which
> you are looking at. Once a real sign-in has happened, **Use last real
> assertion** swaps in what your IdP genuinely sent; prefer it over everything
> else.

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

**Admin → SSO → Access mapping.** Each rule reads as a sentence — *anyone in
`engineering` from Corporate Entra gets Editor in Analytics* — and rules are
re-evaluated on every sign-in and every session refresh, so your directory stays
the source of truth.

There is more to this than fits here: what a rule can grant, why removing
somebody from a group does not always remove their access, and what platform-
admin roles need. See [Running Single Sign-On](/guide/sso-operations).

### When someone cannot sign in

They will see a short reference like `a1b2c3d4`. Ask them for it, then
**Admin → SSO → Diagnostics** and search for it. Each result explains its reason
in place; the full list of reasons and what to do about each is in
[Running Single Sign-On](/guide/sso-operations#when-a-sign-in-fails).

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

### Changing a connection later

The pencil on a connection's card opens its editor, in five sections:

| Section | What lives there |
|---|---|
| **Identity** | Name, and how it decides whether an arriving person is someone you already know |
| **Connection** | Endpoints and credentials, including rotating a secret |
| **Claim mapping** | The same two-column mapper as setup — now resolving against this connection's own configuration |
| **Login page** | Button label and icon, ordering, email domains, and the on/off switch |
| **Danger zone** | Delete |

Two things it will not let you change: the **slug** and the **protocol**. The
slug is part of every URL this connection uses, including the redirect URI you
registered at the IdP, and the protocol is what every setting and every linked
identity is keyed to. Both would break a working connection rather than edit it.

Secrets are never shown. A configured one reads *Configured* with a **Rotate**
button, and until you rotate it, saving leaves it untouched.

Closing with unsaved edits asks first.

---

## Turning things off

- **Turn off one connection** — the power button on its card. The configuration
  is kept; sign-ins through it stop.
- **Turn off all SSO** — Settings → *Single sign-on*. The master switch.
- **SSO only, no passwords** — Settings → *Passwords*. Refused if it would lock
  out an admin who has no SSO identity.

The Settings tab opens with one sentence describing what somebody arriving at the
sign-in page gets right now, because four independent switches do not add up to
that on their own. Watch it as you change them — in particular, turning single
sign-on off while passwords are already off locks everyone out, and that is the
one combination no individual switch can warn you about.

---

## What next

Your connection is live and people are signing in. The questions from here are
about running it: who gets what, what happens when somebody leaves, and why one
person cannot sign in when everybody else can.

**→ [Running Single Sign-On](/guide/sso-operations)**

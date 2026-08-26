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
work with anything standards-compliant. Two entries cover the internal cases:
**Corporate portal**, where something in front of {brand} has already signed the
user in and hands over their profile — see
[Corporate portals](#corporate-portals) — and **Enterprise gateway**, where an
internal service will tell us who someone is if we ask it — see
[Enterprise gateways](#enterprise-gateways).

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

#### If your IdP only sends one name

Plenty do — Entra's `name`, a portal's `fullName` — with no separate given and
family name. Nothing to configure: when both name rows would otherwise be empty,
we split the full name and the rows say **split from `name`** rather than showing
you an empty field.

Splitting is a guess. `Doe, Alice` is read as *Alice Doe* — the comma marks the
family name first, as Active Directory writes it — and everything else divides at
the first space, so `Maria del Carmen García` keeps the particle with the
surname. A name with nothing to divide, like `Prince` or `山田太郎`, lands whole
in the first name rather than being cut somewhere arbitrary.

Because it is a guess, a split name is **not** marked IdP-managed: it fills the
profile in and stays the person's to correct. Map a claim of its own — even a
custom one — and the connection owns the field properly.

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
`engineering` from Corporate Entra gets Editor in Analytics*. Rules are
re-evaluated on every sign-in and every session refresh, so a rule you change
here applies to active sessions within minutes. The group list itself is read
from your directory at sign-in — a change made there lands at that person's
next full sign-in, within 24 hours at the latest.

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

## Enterprise gateways

Some organisations have no OIDC or SAML in front of their internal apps at all.
Instead there is a service that will tell you who someone is *if you ask it*,
using the session they already have. If that describes yours, this is the kind
to pick.

It works differently from every other connection here, and the difference is
worth understanding because it decides what you have to configure.

### How it works

The person's browser already carries a session token from your portal — a cookie
on a domain {brand} shares with it. When they arrive at the sign-in link, we take
that cookie and, from our server rather than their browser, make up to two calls:

```mermaid
flowchart LR
  B[Their browser] -->|arrives with the session cookie| A[{brand}]
  A -->|1. redeem the cookie| G[Your gateway]
  G -->|a token| A
  A -->|2. exchange the token| U[Your user endpoint]
  U -->|their details| A
  A -->|claim mapping| P[Profile and groups]
```

Two things follow from that shape:

- **We never read the cookie.** It is opaque to us. We hand it straight back to
  the service that issued it and believe what that service replies. So the
  connection is only as strong as your gateway, which is the right place for the
  decision to sit.
- **We ask every time.** Because the answer is current rather than a signature
  over something said earlier, a person your portal has just signed out stops
  being able to use {brand} on their next session renewal — not whenever their
  token would have expired. This is the one connection kind that closes that gap.

### When the session does not exist yet

The above assumes people already hold a session with your provider by
the time they open {brand}. Often they do. Where they do not — Kerberos
being the usual case, where the session is created on demand from the
workstation&rsquo;s own login — one more call is needed first, and
**that call is made by the browser rather than by {brand}**.

This is not a preference. Your provider challenges the browser, and
answering that challenge needs a ticket from the workstation&rsquo;s
operating system. Only the browser, on that machine, can get one; our
server cannot, ever. So {brand} makes the call from the sign-in page,
with the browser&rsquo;s credentials attached, and the exchange with the
operating system happens invisibly inside it.

Fill in the **Sign-in trigger** section of the connection with the
endpoint to call. Two things to know before you do:

- It runs **automatically**, once per browser tab, for anyone opening
  {brand}. A session the machine already holds should not need a button
  press. If it fails — an off-network laptop, a browser that has not
  been told to answer for that host — the ordinary sign-in form is still
  there, and pressing the button will say what went wrong.
- There is a **switch** on the section. Turning it off stops the call
  without losing what you configured, which is what you want during an
  incident on their side, or to check that people can still get in the
  ordinary way. While it is off, nothing about the section reaches
  anyone&rsquo;s browser.
- **The headers on that section are public.** They are sent from the
  user&rsquo;s browser and readable by anyone who opens the sign-in
  page. They are *not* the same as the header fields on the two steps
  below, which stay on our server. Put an application identifier there;
  never a credential.

Your identity team will need to allow {brand}&rsquo;s exact origin for
credentialed cross-origin calls, and your desktop team will need
workstations configured to answer the challenge for that host. Both are
in the contract document below.

### What you need from your identity team

Ask them for:

- **The cookie's name**, and confirmation it is set on a domain {brand} shares.
  If it is not, all is not lost — switch the connection's exchange to **the
  browser**: the sign-in page makes the translate call itself (the user's
  browser holds the cookie ours never sees) and hands over the signed token it
  answers with. That shape requires their **JWKS URL**, because a token the
  browser delivers is verified against their published keys, always.
- **The endpoint that redeems it**, and where in its reply the token sits.
- **The endpoint that returns the user**, if that is a second call — some
  gateways answer with the person's details straight away, and then you leave
  the second endpoint blank.
- **Whether the details arrive as a signed token (JWT).** Some translate
  endpoints answer with a JWT — bare in the body, or under a field — whose
  payload is the user object. Say so on the connection and the claims are read
  from the payload; give it their JWKS URL as well and the signature is
  verified too.
- **Any headers the server's calls need** — an application id, a key. They go
  in the connection's settings and are never sent to anyone's browser. (The
  trigger's and the browser exchange's headers are the exception, and the form
  says so where you type them: those calls are made *by* the browser, so their
  headers are public.)
- **Whether their reply includes an authentication time.** Without one there is
  no way to tell how long ago somebody actually signed in, and the daily
  re-authentication ceiling stops applying to them.
- **A validate-only endpoint, if they have one.** The session re-check calls it
  instead of the redeem endpoint (the connection's **Re-check URL**), so
  renewals stop minting a token apiece.

One more default worth knowing: corporate gateways rarely send an
`email_verified` claim, so the connection treats their addresses as verified —
that is what lets people land on their existing account, matched by email. An
explicit `false` from the gateway is always respected, and the toggle is in the
connection's Behaviour section.

### Allowing the host first

These endpoints are internal, and {brand} refuses to make requests into a private
network unless someone has explicitly permitted the destination. So before the
connection can work, its host must be on the allowlist:

**Admin → SSO → Settings → *Internal gateways SSO may call***.

An entry is one host and one port — permitting a gateway on 443 does not permit
whatever else answers on the same machine. That list is managed under its own
permission, separate from ordinary platform administration, because it decides
where {brand} may send requests. You may need to ask someone else to add it.

Some addresses are refused whatever is on the list — loopback, and the addresses
cloud providers use to hand out credentials. Nothing in the admin UI can unlock
those.

### Setting it up

The five-step flow is the same, with the differences you would expect:

| Step | What is different |
|---|---|
| **Connect** | No **Fetch** — there is no document to read. You fill in the two endpoints and where the token and the user details sit in their replies. |
| **Map** | The same two-column mapper. Your gateway's reply is the payload being mapped. |
| **Rehearse** | Works exactly as it does elsewhere, and matters more here: it is the only way to see what your gateway actually returned before anyone else depends on it. |
| **Publish** | Refused if the connection is not configured enough to work. |

If something is wrong, saving tells you which field and why. If a sign-in fails
afterwards, see *Running Single Sign-On* → **Why a sign-in failed**.

There is a document written for the team that owns the gateway rather
than for you — `docs/SSO_BACKCHANNEL_CONTRACT.md` in the {brand}
repository. It states what their endpoints have to do, and is worth
sending them before the work starts rather than after. The section on
status codes is the one that cannot be fixed from this side afterwards:
if their service returns a server error for an expired session, nobody
will ever be signed out; if it returns "unauthorised" during an outage,
everybody will be at once.

### Keeping sessions in step

By default, {brand} re-checks with your gateway each time it renews someone's
session, which happens as often as your access tokens expire — a few minutes on
the default setting. That is what makes signing out of your portal sign them out
here too.

If the gateway stops answering, sign-ins are not dropped immediately: existing
sessions keep working for a grace period, measured from the last time the gateway
actually answered rather than the last time we tried. So a brief outage is
invisible, and a long one still ends sessions rather than extending them
indefinitely. Both the re-check and the grace period are settings on the
connection.

And when the corporate session itself expires — they tend to live an hour or
four — nobody is dumped on a login form. The app notices at the next renewal
and silently re-runs the browser's part of the sign-in: the trigger, the
translate call on a browser-exchange connection, and the sign-in itself, all
behind the scenes. The user keeps working; the only way they find out is if the
corporate side actually refuses, in which case the login page opens with the
reason and tries again on its own a minute later. Browser-exchange connections
have no server re-check at all — the translate token's own expiry plays that
part, with the same silent recovery behind it.

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

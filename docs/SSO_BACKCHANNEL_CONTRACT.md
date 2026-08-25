# Back-channel SSO — integration contract

> **For the team that owns the sign-in service.** This describes what a
> back-channel SSO integration requires of *your* endpoints. It is
> deliberately vendor-neutral and says nothing about how the application
> is configured — that is the operator's side, and it is a form.
>
> Read §3 first if you read nothing else. It is the part that cannot be
> fixed from our side afterwards.

---

## 1. The shape

Back-channel SSO means the application never receives an assertion about
who someone is. It receives an opaque handle and **asks you**.

```
  browser ──(optional) authenticate ─────────────▶  your SSO
                                                    ↓ sets a cookie, or
                                                      answers with a handle
  browser ──arrives at the app with that handle──▶  the app
                                                    │
                        app ──1. redeem the handle──▶  your gateway
                            ◀── a token ─────────────
                        app ──2. present the token──▶  your user endpoint
                            ◀── the user's details ───
```

Legs 1 and 2 are server-to-server, from the application's backend to
yours. **Leg 2 is optional**: if your gateway already answers with the
user's details, say so and it is skipped.

Everything about the shape is configuration on our side — which HTTP
method, whether the handle travels as a cookie, a header or a JSON body
field, what the header is called, where in your JSON the token and the
details sit. You do not need to change your endpoints to match a format
we impose. Tell the operator the shape and they enter it.

### Why this is the strongest integration we offer

Every other kind verifies a signature over a statement you made at some
earlier moment. This one asks you *now*. Two consequences:

- A session you revoked thirty seconds ago fails here immediately,
  rather than at the expiry of an assertion already issued.
- A copied handle is worth exactly as much as a stolen session on your
  own portal — no more. The application inherits your session risk
  instead of adding one of its own.

---

## 2. The optional first call

Only needed when the user does not already hold a session with you by
the time they reach the application — most commonly **Kerberos /
SPNEGO**, where the session is created on demand from the workstation's
own login.

**This call is made by the browser, not by the application's server, and
that is not a preference.** Answering `401 WWW-Authenticate: Negotiate`
requires a Service Ticket from the workstation's OS credential store,
reachable through SSPI on Windows or GSS-API elsewhere. Only the user's
browser, on the user's machine, can obtain one. The application's
backend holds no ticket for that user, so a design in which our server
calls your authenticate endpoint cannot work.

The browser calls it with `credentials: 'include'`, which is what allows
the OS to be consulted and the challenge answered. The retry is
automatic and invisible to both of us.

You may answer either way:

| Your endpoint | What the application does next |
|---|---|
| sets a session cookie | our backend reads it off the next request and starts leg 1 |
| answers with a handle in its JSON | the browser hands it to our backend, which starts leg 1 |

### What this call requires of you

- **CORS, in full.** The application's page is on a different origin
  from yours, and it sends custom headers, so the browser issues a
  preflight. You must answer `OPTIONS`, allow those header names, and —
  because the call is credentialed — echo the application's **exact
  origin** in `Access-Control-Allow-Origin` (a wildcard is forbidden
  with credentials) alongside `Access-Control-Allow-Credentials: true`.
- **The preflight must not be challenged.** A CORS preflight is an
  `OPTIONS` request the browser sends without credentials and will not
  retry. If your service answers it with `401 WWW-Authenticate:
  Negotiate` — which an authentication filter applied to every method
  will do — the browser abandons the whole call before the real request
  is ever made, and the failure looks like a CORS misconfiguration
  rather than an authentication one. Exempt `OPTIONS` from
  authentication.
- **Browser policy for Kerberos.** Workstations must be configured to
  answer a Negotiate challenge for your host — `AuthServerAllowlist` on
  Chrome and Edge, `network.negotiate-auth.trusted-uris` on Firefox.
  Without it the browser silently declines to attach a ticket and the
  call simply fails. This is desktop group policy; neither the
  application nor your service can set it.
- **Headers sent here are public.** They travel from the user's browser
  and are readable by anyone who opens the sign-in page. An application
  identifier is fine. A credential is not.

---

## 3. Status codes — the part that matters most

The application distinguishes exactly two answers from your endpoints,
and gets it wrong in opposite directions if you conflate them.

| You answer | The application concludes | What it does |
|---|---|---|
| **401** or **403** | this session is over | ends the user's session, here and now |
| anything else that is not success | we could not tell | **does nothing** — the session continues |

This matters because the application re-asks you on every session
renewal, not only at sign-in. That is what makes signing out of your
portal sign the user out of the application too.

So:

- **If you return `500` for an invalid session**, the application will
  never sign anyone out. Sessions will outlive yours indefinitely.
- **If you return `401` during an outage**, the application will sign
  out every user at once, as fast as their sessions renew.

Neither is recoverable by configuration on our side. There is no setting
that means "treat 500 as revoked", because a server error genuinely is
not a statement about a user.

An outage is tolerated rather than acted on, but not forever: sessions
survive an unreachable gateway for a configurable grace period measured
from the last time you actually answered — not from the last time we
tried. A brief outage is invisible; a sustained one ends sessions rather
than extending them.

---

## 4. What each leg sends and expects

### Leg 1 — redeem the handle

Configurable: `GET` or `POST`; the handle sent as a cookie, as a header
with an optional prefix, or as a named field in a JSON body; any number
of static headers.

```http
POST /gateway/token HTTP/1.1
Host: sso-gateway.internal.example
Cookie: CORPSESSION=<opaque>
X-App-Id: <application identifier>
Content-Type: application/json
```

```json
{ "access_token": "<opaque>", "expires_in": 3600 }
```

We read the token from a path the operator configures — `access_token`
here, but `data.tokens[0].value` works equally well. Nest it however
your API already does.

### Leg 2 — exchange it for the user

```http
POST /gateway/userinfo HTTP/1.1
Host: sso-gateway.internal.example
Content-Type: application/json

{ "token": "<the token from leg 1>" }
```

```json
{
  "sub": "emp-100482",
  "email": "ada.lovelace@example.com",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "groups": ["engineering", "staff"],
  "auth_time": 1700000000
}
```

Field names are mapped by the operator, so yours need not match these.
What the application needs:

| | Required | Notes |
|---|---|---|
| a stable subject identifier | **yes** | must not change when someone's name or email does |
| email | **yes** | used to match an existing account |
| given / family name | no | a directory of blank names is how a bad mapping is discovered, late |
| groups | no | drives roles and workspace access when mapped |
| **authentication instant** | strongly | see below |

**The authentication instant** is the moment the person actually signed
in — not the moment you answered us. Without it the application cannot
tell how long ago that was, and a daily re-authentication ceiling stops
applying to everyone on this connection. If your reply carries no such
field, say so explicitly rather than letting a "close enough" timestamp
be mapped to it.

---

## 5. What we require, and what we never do

Of your endpoints:

- **TLS**, with a certificate that validates. Plain HTTP is refused
  outright in production.
- **No redirects.** A `3xx` from either endpoint is treated as an error,
  not followed. Redirecting a credentialed back-channel call is the
  standard way around a destination check, so it is refused rather than
  chased.
- **An answer within the timeout**, and a response within a size cap.
  Both are configurable; the defaults are seconds and hundreds of
  kilobytes, because a user record is small.
- **A reachable address.** These endpoints are usually internal, and the
  application refuses to make requests into a private network unless an
  operator has explicitly permitted the destination — by host *and*
  port. That is their side, but it is the most common reason a correctly
  built gateway does not work on the first attempt.

What the application never does:

- **Parse either token.** Both are opaque, including when they are
  visibly JWTs. Nothing is decoded, and no claim inside them is read.
  The user's identity comes only from leg 2's reply.
- **Keep the token.** It exists for the duration of one request and is
  discarded — never cached, never written to a database, never returned
  to a browser. Its own validity period is therefore irrelevant to us.
- **Send anything from this exchange to the browser.** Neither token,
  nor your endpoint URLs, nor any header configured for legs 1 and 2.

---

## 6. Load

The application re-confirms the session on every renewal, which happens
once per access-token lifetime — a few minutes by default, and a
deployment setting. So: roughly one leg-1 call per signed-in person per
renewal interval, plus one full exchange per sign-in.

If you have an endpoint that *validates* a handle without minting a new
token, say so — it is cheaper for this purpose and we would rather call
that one.

---

## 7. Before you start

Answers to these determine whether the integration works at all, and all
of them are cheaper to establish now than to discover later.

1. Is the session cookie scoped to a domain the application's host sits
   under? If it is only on your own hostname it never reaches the
   application, and nothing on our side can compensate.
2. Is that cookie `HttpOnly` and `Secure`? Both are preferred —
   `HttpOnly` blocks JavaScript, not our backend.
3. Do your endpoints distinguish "this session is invalid" (401/403)
   from "something went wrong here" (5xx)? See §3.
4. Does your user reply carry a stable subject id, an email, and an
   authentication instant?
5. Is there a validate-only endpoint (§6)?
6. If a first call is needed: is `OPTIONS` exempt from authentication,
   does the preflight answer with the application's exact origin and
   `Access-Control-Allow-Credentials`, and are workstations
   policy-configured to answer Negotiate for your host?
7. What happens to the session when someone signs out of your portal —
   is the cookie invalidated on your side, or only dropped by the
   browser? If only dropped, the application's re-check confirms "the
   cookie still exists" rather than "the session is still live", which
   is a materially weaker guarantee and worth knowing before relying on
   it.

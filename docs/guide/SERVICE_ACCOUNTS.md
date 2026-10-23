# Service Accounts

*For administrators, and for the people who look after an integration.*

A service account is an account nobody signs in as. An integration — a
scheduled job, a pipeline, a sync with another system — acts as it through
API keys its **managers** make, so the integration keeps running whoever set
it up, and goes on running when they move on.

> **Note:** *The one-sentence model* — a service account is a principal with
> its own roles; its keys work while it is enabled and someone answers for it.

---

## How it works

- An administrator **creates** it, names at least one **manager** — a person
  or a team — and gives it **workspace roles**.
- Its managers **make, rotate and revoke its keys**, each confirming it's them
  exactly as for their own keys. A key is recorded as made by the person, and
  acts as the account.
- A key reaches what the **account's** roles give it — never what the person
  who made it can reach — and counts against the account's own limit of 25.
- Its keys work while the account is **enabled** and someone **in good
  standing** manages it. When nobody does, they keep working for a grace
  period, then pause until a manager is appointed.

| | A personal key (`nxpat_…`) | A service account's key (`nxsat_…`) |
| --- | --- | --- |
| Acts as | You | The service account |
| Reaches | What you can | What the account's roles give it |
| Made by | You | Its managers |
| Pauses when | You stop signing in through your identity provider | Nobody has managed the account for longer than the grace period |
| Stops when | Your account is suspended or deleted | The account is disabled |

A person is **in good standing** when they could sign in now: active, not a
break-glass account, and either signed in through the identity provider within
the sign-in window (30 days unless changed) or holding a password while
password sign-in is on. A team is, when it has at least one such member.

---

## For administrators

Service accounts are looked after under **Administration → Service accounts**
by super admins and org admins (the permission is
`system:service-accounts:manage`). The list says how each one stands, most
pressing first: **Needs a manager**, with the day its keys pause; **Single
manager**, when one person is all it depends on; **Disabled**.

### Creating one

Choose **Create service account**, give it a name and say what it is for,
and choose at least one manager. Then open it and give it roles: pick a
workspace and a role. A service account can hold any workspace role that
neither administers the workspace nor lets people in — Viewer or Editor, say,
but never Admin or Steward — and never a platform role or a place in a team.
Its keys pick a new role up within half a minute.

### Teams as managers

Prefer a **team** — ideally one your identity provider keeps — to a single
person. As people join and leave the team, the account stays managed without
anyone remembering it.

The trade-off is said wherever you choose one: **anyone in the team can make
keys that act as the account**. Whoever controls the team's membership
controls that, too.

### Disabling

**Disable** stops every key the account holds at once (`api_key_owner_inactive`)
and refuses new ones; nothing is revoked, and **Enable** brings them back.
Accounts are not deleted: disable one, and revoke its keys, instead.

---

## For managers

The accounts you manage — yourself, or through a team — are listed under
**Account → API keys → Service accounts you manage**. Open one for how it
stands, who manages it and where it has a role, and its keys. **Create key**
opens the same wizard as for your own keys: what you choose is checked
against what the **account** can reach, and you confirm it's you before the
token is shown.

Who manages an account, and its roles, are an administrator's to change.
Someone allowed to manage users (a super admin) can make, rotate and revoke an
account's keys without managing it; its managers are told when they do.

Misuse of a key, a key about to expire and an administrator revoking one are
told to the account's managers — or, while it has none, to its administrators.

---

## When a manager leaves

Three things keep an integration from stopping because its person left.

1. **Hand over when they leave.** Suspending someone on **Administration →
   Users** lists the service accounts they manage, says which nobody else
   manages, and names the keys they made. Choose a successor — a person or a
   team — and **Hand over and suspend**. **Administration → Service accounts →
   Hand over…** does the same without suspending anyone.
2. **The safety net.** When an account's last manager in good standing goes —
   suspended, removed, out of their team, or no longer signing in — every
   super admin and org admin is told at once. Its keys keep working for the
   grace period, **14 days** unless changed under **Administration → Features →
   Authentication → Keep a service account's keys working after its last
   manager goes** (at once, 7, 14 or 30 days), and the administrators are
   reminded three days before they pause. Appointing a manager resumes them at
   once. Standing is checked whenever managers change and once an hour, so a
   lapse that comes with time alone is noticed within the hour.
3. **Rotate what they made.** Keys the leaver made may still be in their
   hands: the hand-over lists them, so the new manager can rotate them.

---

## For integrators

Swap `Authorization: Bearer nxpat_…` for `Authorization: Bearer nxsat_…` and
change nothing else: the same routes answer the same way.
`GET /api/v1/api-keys/self` shows `"kind": "service"`.

Two refusals say something particular about a service account:

| Status | `error` | What it means |
| --- | --- | --- |
| 401 | `api_key_unmanaged` | Paused: the account has had no manager for longer than the grace period. It works again as soon as one is appointed. |
| 401 | `api_key_owner_inactive` | The account is disabled. |

Secret scanners find both kinds with `nx[ps]at_[0-9A-Za-z]{38}`.

---

## What is recorded

Creating, renaming, disabling and enabling an account, and appointing or
removing its managers, appear in **Administration → Activity** with who did
it. Its keys' events name the person who made, rotated or revoked each key,
with the account as what it was done to.

---

## Where to next

- [API Keys](/guide/api-keys) — making, rotating and revoking keys, and what
  a key may call.
- [Users & Access](/guide/users-access) — roles, teams, and offboarding.
- [Feature Switches](/guide/feature-switches) — the grace period, and the
  other switches that govern keys.

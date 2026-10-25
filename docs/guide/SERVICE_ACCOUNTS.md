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

Those roles are all it has. Nothing else can be shared with it — a view, a
template or a draft — and should someone later widen a role it holds to
administer a workspace or let people in, it gets none of that. A view it made
is its own only while it holds a role in that view's workspace: take the role
away and the view is out of its reach too. In a workspace
whose identity provider decides who is in it, its role is not an exception
that ends within 90 days: the provider doesn't know the account, so the role
is your decision here, and it lasts until you take it away.

Wherever access is listed — a workspace's members, everyone with access,
access reviews, the activity log — it is marked as a service account, and
links here. It is never counted among people.

### Teams as managers

Prefer a **team** — ideally one your identity provider keeps — to a single
person. As people join and leave the team, the account stays managed without
anyone remembering it.

The trade-off is said wherever you choose one: **anyone in the team can make
keys that act as the account**. Whoever controls the team's membership
controls that, too — so once a team manages a service account, only an
administrator of service accounts can add someone to it: not a team
administrator alone, and never by approving an access request. Those who
answer for the account are told whenever someone joins. A team your identity
provider keeps changes as the provider says.

A manager can do whatever the account can, so appointing one — or handing an
account over — takes being able to grant each of its roles yourself.

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

What concerns the account is told to those who answer for it, naming it:
the people who manage it themselves and, about a key, whoever made it while
they still answer for it. An account managed only through a team tells up to
25 of its members, the most recently active first, rather than the whole team;
while nobody answers for it, its administrators are told instead. That covers
misuse of a key, a key about to expire, a key revoked by an administrator or
by whatever held it, disabling or enabling the account, and anything said to
the account itself, such as a workspace removing its access, an end date set
on that access or its coming end, or a decision on a publication it asked
for. Nobody reads the account's own inbox.

---

## When a manager leaves

Three things keep an integration from stopping because its person left.

1. **Hand over when they leave.** Suspending someone on **Administration →
   Users** lists every service account their leaving touches: those they
   manage themselves, which a hand-over moves; those they manage through a
   team, which keeps its seat; and those they made a key for that still works.
   It says which nobody else manages, and names the keys they made. Choose a
   successor — a person or a team — and **Hand over and suspend**.
   **Administration → Service accounts → Hand over…** does the same without
   suspending anyone.
2. **The safety net.** When an account's last manager in good standing goes —
   suspended, removed, out of their team, or no longer signing in — every
   super admin and org admin is told at once. Its keys keep working for the
   grace period, **14 days** unless changed under **Administration → Features →
   Authentication → Keep a service account's keys working after its last
   manager goes** (at once, 7, 14 or 30 days), and the administrators are
   reminded three days before they pause — again nearer the new day if the
   grace period is lengthened, and once that they have paused if it is
   shortened past it. When more than five accounts lose their last manager at
   once — a sign-in window shortened, say — the administrators get one notice
   naming them, not one each. Appointing a manager resumes the keys at once.
   Standing is checked whenever managers change and once an hour, first in
   that hour's pass, so a lapse that comes with time alone is noticed within
   the hour; [Observability](/docs/observability) says how to be alerted if
   that check stops completing.
3. **Revoke or rotate what they made.** Keys the leaver made may still be in
   their hands. Suspending them offers to revoke every one at once (that takes
   `system:users:manage`); whoever answers for each account is told, to make
   a new key for whatever used it. Otherwise rotate them. And whenever someone
   who made keys that still work stops answering for an account — removed as
   its manager, taken out of its team or the team deleted, suspended, or made
   a break-glass account — those who still answer for it are told.

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

A service account's key can't review or approve a pull request: approving is
a person's call, and its managers would otherwise approve through it. For the
same reason, nobody approves a pull request opened through an account they
manage, or one from a draft it owns.

Given **Publisher** (or **Data engineer**) in a workspace, its keys may write a
version-controlled data source's Published version directly — a bulk ingest,
or an edit with no draft — since that check reads the account's own roles.
Like every key, they never publish, merge, revert, restore or sync: a person
with publish lands the drafts it proposes.

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

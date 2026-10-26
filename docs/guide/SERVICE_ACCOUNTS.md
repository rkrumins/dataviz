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

- An administrator **creates** it and names at least one **manager** — a
  person or a team — or, where the administrators allow it, someone creates
  one for themselves. Creating it gives it no access.
- Each **workspace** decides what it may do there, as it does for a person:
  its admins and stewards add it on **Members**, or answer a request its
  managers make for it.
- Its managers **run** it on its own page: they rename it, disable and enable
  it, appoint and remove managers, ask workspaces for access, take away roles
  it no longer needs, and delete it when nothing runs as it any more — then
  it can be restored for 30 days.
- Its managers — or a super admin — **make, rotate and revoke its keys**, each
  confirming it's them exactly as for their own keys. A key is recorded as
  made by the person, and acts as the account.
- A key reaches what the **account's** roles give it — never what the person
  who made it can reach — and counts against the account's own limit of 25.
- Its keys work while the account is **enabled** and someone **in good
  standing** manages it. When nobody does, they keep working for a grace
  period, then pause until a manager is appointed.

| | A personal key (`nxpat_…`) | A service account's key (`nxsat_…`) |
| --- | --- | --- |
| Acts as | You | The service account |
| Reaches | What you can | What the account's roles give it |
| Made by | You | Its managers, or a super admin |
| Pauses when | You stop signing in through your identity provider | Nobody has managed the account for longer than the grace period |
| Stops when | Your account is suspended or deleted | The account is disabled or deleted |

A person is **in good standing** when they could sign in now: active, not a
break-glass account, and either signed in through the identity provider within
the sign-in window (30 days unless changed) or holding a password while
password sign-in is on. A team is, when it has at least one such member.

---

## For administrators

Service accounts are looked after under **Administration → Service accounts**
by super admins and org admins (the permission is
`system:service-accounts:manage`). Looking after accounts doesn't make their
keys: that takes managing the account, or `system:users:manage` (a super
admin). The list says how each one stands, most
pressing first: **Needs a manager**, with the day its keys pause; **Single
manager**, when one person is all it depends on; **Disabled**. Narrow it to
the accounts that need a manager or that an administrator holds, to those a
person or a team manages, or to those with a role in a workspace; **Deleted**
lists those that can still be restored. Each account opens on its own page,
the same one its managers use.

### Creating one

Choose **Create service account**, give it a name and say what it is for,
and choose at least one manager. Its access then comes from the workspaces it
works in, [as a person's does](#for-workspaces); you can also give it a role
yourself: open it, and pick a workspace and a role. A service account can hold
any workspace role that neither administers the workspace nor lets people in —
Workspace viewer to read, Workspace member or Data engineer to change data,
but never Workspace admin or Workspace steward — and never a platform role or
a place in a team. Its keys pick a new role up within half a minute.

Those roles are all it has. Nothing else can be shared with it — a view, a
template or a draft — and should someone later widen a role it holds to
administer a workspace or let people in, it gets none of that. A view it made
is its own only while it holds a role in that view's workspace: take the role
away and the view is out of its reach too.

Wherever access is listed — a workspace's members, everyone with access,
access reviews, the activity log — it is marked as a service account, and
links here. It is never counted among people.

### Who else may create one

Below the grace period, the page says who else may create a service account
for themselves, and **Change…** sets it:

- **Only administrators of service accounts** — as it ships, so upgrading
  changes nothing;
- **Anyone who lets people into a workspace** — its admins and stewards, who
  already decide what any account may do there;
- **Anyone** — any active person.

Each may have created up to **10** live accounts unless you choose another
number; a deleted one no longer counts, and administrators of service
accounts aren't limited. You can also ask that **a team they're in manages
each one**, so it outlives any one person. Whoever creates one manages it,
or the team they name; it reaches nothing until a workspace gives it a role.
Changes are recorded in the activity log.

### Teams as managers

Prefer a **team** — ideally one your identity provider keeps — to a single
person. As people join and leave the team, the account stays managed without
anyone remembering it.

The trade-off is said wherever you choose one: **anyone in the team can make
keys that act as the account**. Whoever controls the team's membership
controls that, too — so adding someone to a team that manages a service
account is held to the rule for appointing a manager, below, and nobody joins
one by having an access request approved. Those who answer for the account are
told whenever someone joins. A team your identity provider keeps changes as
the provider says.

A manager can do whatever the account can. So nobody — an administrator, or
one of its managers — can make someone able to act as it who would gain access
the appointer couldn't give them directly: for each of the account's roles,
either they hold as much there already, or whoever appoints them could grant
it there. A team holds what its own roles give every member. If someone would
gain more, the refusal names the roles in the way. The same goes for handing
an account over.

### Disabling and deleting

**Disable** stops every key the account holds at once (`api_key_owner_inactive`)
and refuses new ones; nothing is revoked, and **Enable** brings them back.
Its managers can disable and enable it too — but when an administrator of
service accounts disables it, it is **held**: it stays disabled until an
administrator enables it.

**Delete** retires an account whose integration is gone. Its keys stop at once,
as when it is disabled, and nobody is reminded that they expire; its requests
still waiting on a workspace are withdrawn. Nothing else changes. For **30 days** it is listed under
**Deleted**, and its page offers **Restore**, which brings it back as it was:
its keys, its roles and its managers. Then the hourly pass **purges** it: its
keys are revoked, and its roles and managers removed. Its name stays in the
activity log, by everything it did.

Its managers can delete and restore it too. Deleted by an administrator of
service accounts, it is held, and only an administrator restores it. Nor does
deleting let go of a hold: an account held disabled that its managers delete
comes back only through an administrator, and still disabled.

---

## For workspaces

A workspace lets a service account in as it lets a person in: its admins and
stewards decide, and no service account reaches it unless they — or an
administrator of service accounts — say so.

- **Add it.** On the workspace's **Members** tab, choose **Add member**, then
  **Service account**. Find it by its name or by what it is for — each says
  who manages it — and choose a role, for a while if you like. You give it
  what you could give a person, among the roles a service account may hold.
- **Answer a request for it.** Its managers ask from its page. The request
  says what the account is for, who manages it — marking a team your identity
  provider keeps — and who asked; approving lets them act here through it.
  Approve it with a role, for a while if you like, or decline it, as you
  would a person's. A request for a service account is never answered by
  adding it to a team or pointing it to the identity provider, and nobody
  answers one for an account they manage, or asked for.
- **See whose it is.** Its name opens its page: what it is for, who manages
  it, and its roles in the workspaces you can open.
- **Remove it** as you would a person. Its managers hear about it.
- **Removing someone who manages one** names it, when its role here gives
  more than they would keep — through its keys they could still act here —
  and offers to remove that role too.

A service account never joins on its own: in a workspace that people may join
at once, it is asked for like any other role, and a workspace that isn't
taking requests takes none for it either — its admins add it. Where the
identity provider decides who is in the workspace, only its admins give a
service account access, and its role is not an exception that ends within 90
days: the provider doesn't know the account, so the role is the admins'
decision, and it lasts until it is taken away, or until the end they chose.

---

## For managers

The accounts you manage — yourself, or through a team — are listed under
**Account → API keys → Service accounts you manage**. Where your
administrators allow it, **Create service account** there makes one for an
integration of yours: name it, say what it is for, and choose who manages it
— you, or a team you're in. It shows how many you have created of the most
you may. Each opens on its own
page: how it stands, who manages it and where it has a role, and its keys.
**Create key** opens the same wizard as for your own keys: what you choose is
checked against what the **account** can reach, and you confirm it's you
before the token is shown.

You run the account there, as any of its managers:

- **Rename** it, or say what it is for.
- **Disable** it, which stops every key at once, and **enable** it again —
  unless an administrator disabled it.
- **Appoint** other managers, by the rule above, and **remove** them — though
  not the last one: appoint another first.
- **Ask a workspace for access**: choose a workspace — one you are in, or one
  **Find a workspace** lists — a role it may hold there, and why. Its admins
  and stewards answer, as they answer a person. The request waits on the page,
  where any of its managers can withdraw it. A workspace that isn't taking
  requests says so: ask its admins to add the account.
- **Keep access that's ending**: a role given for a while says when it ends,
  and **Keep** asks the workspace to extend it.
- **Take away** a role it no longer needs, so it reaches no more than it uses.
- **Delete** it once nothing runs as it any more: its keys stop at once. It
  stays on your list, marked **Deleted**, and you can restore it, as it was,
  for 30 days — unless an administrator holds it.

Someone allowed to manage users (a super admin) can make, rotate and revoke an
account's keys without managing it; its managers are told when they do.

What concerns the account is told to those who answer for it, naming it:
the people who manage it themselves and, about a key, whoever made it while
they still answer for it. An account managed only through a team tells up to
25 of its members, the most recently active first, rather than the whole team;
while nobody answers for it, its administrators are told instead. That covers
misuse of a key, a key about to expire, a key revoked by an administrator or
by whatever held it, disabling, enabling, deleting or restoring the account,
and anything said to
the account itself, such as an answer to a request for its access, a
workspace removing that access, an end date set on it or its coming end, or a
decision on a publication it asked for. Nobody reads the account's own inbox.
Someone removed as its manager is told too, unless they still manage it
through a team.

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

To get one, create it under **Account → API keys → Service accounts you
manage**, where your administrators allow it — or ask a super admin or org
admin to. Name it for what it does, with you, or better your team, as its
manager. Then, from its page, ask
each workspace it works in for access — or ask their admins to add it — and
make its key under **Account → API keys → Service accounts you manage**.

Swap `Authorization: Bearer nxpat_…` for `Authorization: Bearer nxsat_…` and
change nothing else: the same routes answer the same way.
`GET /api/v1/api-keys/self` shows `"kind": "service"`, and `"status": "paused"`
while the account has had no manager for longer than the grace period. A
service account has no password, so the few routes a key can't call need a
person. Its first calls, and every answer it can get, are in the
[Integration Quickstart](/docs/integration-quickstart); managing its keys from
a script, in the [Key Management API](/docs/key-management-api).

Two refusals say something particular about a service account:

| Status | `error` | What it means |
| --- | --- | --- |
| 401 | `api_key_unmanaged` | Paused: the account has had no manager for longer than the grace period. It works again as soon as one is appointed. |
| 401 | `api_key_owner_inactive` | The account is disabled, or deleted. |

Secret scanners find both kinds with `nx[ps]at_[0-9A-Za-z]{38}`.

A service account's key can't review or approve a pull request: approving is
a person's call, and its managers would otherwise approve through it. For the
same reason, nobody approves a pull request opened through an account they
manage. Both answer `403` with `"type": "access_denied"`.

---

## What is recorded

Creating, renaming, disabling, enabling, deleting and restoring an account,
and appointing or removing its managers, appear in **Administration →
Activity** with who did it, and so does its purge, 30 days after it was
deleted. Its keys' events name the person who made, rotated or revoked each key,
with the account as what it was done to, and a request for its access names
the manager who asked.

---

## Where to next

- [Integration Quickstart](/docs/integration-quickstart) — an integration's
  first calls with the account's key, and every answer it can get.
- [API Keys](/guide/api-keys) — making, rotating and revoking keys, and what
  a key may call.
- [Users & Access](/guide/users-access) — roles, teams, and offboarding.
- [Feature Switches](/guide/feature-switches) — the grace period, and the
  other switches that govern keys.

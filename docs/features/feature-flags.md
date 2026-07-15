# Feature flags: adding one, and ending one

Every switch on **Admin → Features** decides what every user of the deployment can and cannot do.
That makes each one a permanent obligation: somebody has to understand it, it has to keep being
true, and one day somebody has to be brave enough to delete it. This document is the contract for
all three.

The rules below are not advice. **They are enforced by `backend/tests/test_feature_wiring.py`,
which runs on every pull request** (`.github/workflows/alembic-guards.yml`). If you break one, the
build fails and tells you which. That is deliberate: the previous version of this page relied on
people remembering, and eight of its twelve switches ended up doing nothing at all.

---

## The one idea

> **Code owns the FACTS. The database owns the PROSE.**

| | Lives in | Editable at runtime? |
|---|---|---|
| Where it's enforced, what it hides, whether it's wired | `app/config/feature_wiring.py` | **No.** Editing it would not change what the server does. |
| Name, description, admin hint, impact copy | `app/config/features_seed.py` → `feature_definitions` | Yes — that's what the registry is for. |
| The admin's chosen value | `feature_flags.config` | Yes. It's their setting; a redeploy never resets it. |

`implemented` used to be a column an admin could tick — a claim about the source tree, owned by
people who cannot change the source tree. It was wrong about four flags on the day it was written.
It is now **derived** from the wiring. There is no way to state it, so there is no way to state it
wrongly.

---

## The lifecycle

```
   experimental  ─────────►  active  ─────────►  deprecated  ─────────►  gone
   (being built)            (shipped)          (being removed)        (deleted)

   default OFF              default ON          gates removed          definition
   halves optional          BOTH halves         key appears            deleted;
   badged in the UI         required            NOWHERE                stored value
                            enforced server-side                       cleaned up
```

`stage` lives on the wiring entry. It exists because a flag used to have only two states — it
existed, or it didn't — and everything that matters happens in between.

---

## Adding a flag for a feature you are still BUILDING

Use `stage="experimental"`.

```python
# app/config/feature_wiring.py
"myNewThing": FeatureWiring(
    key="myNewThing",
    posture="capability",
    stage="experimental",          # the halves don't exist yet, and that's allowed
    server_gates=(),               # fill these in as you build
    ui_surfaces=(),
),
```

```python
# app/config/features_seed.py
{
    "key": "myNewThing",
    "name": "My new thing",
    "description": "...",
    "impact_when_off": "...",      # what a user LOSES. Required — see below.
    "category_id": "...",
    "type": "boolean",
    "default_value": json.dumps(False),   # experimental flags MUST ship OFF
    ...
}
```

**Why OFF?** Switching an unfinished feature on for every user is not a preview, it's an incident.
Nobody asked to be a tester. The guard enforces this
(`test_an_EXPERIMENTAL_flag_must_default_OFF`).

While the flag is experimental the both-halves rule is relaxed — you are allowed to have a gate with
no UI, or neither, because you are mid-build.

---

## Promoting it to `active` (i.e. shipping it)

Change `stage` to `"active"` and flip `default_value` to `True`. The guard now demands, and will
fail the build without:

1. **A server gate.** The key must be read somewhere in `backend/app`.
   Usually `dependencies=[Depends(require_feature("myNewThing"))]` on the route.
   *A flag that only hides a button is a lie: the endpoint is still there, and anyone who knows the
   URL still has the feature.*

2. **A UI surface.** The key must be read somewhere in `frontend/src` — `useFeature('myNewThing')`.
   *A server-only gate is honest but hostile: the UI keeps offering the feature and the user finds
   out it's off by being refused.*

3. **It must default ON.** Users cannot ask for a capability they have never seen. A capability flag
   that ships OFF is a feature nobody discovers and nobody requests — it just quietly isn't part of
   the product. Defaulting ON is the difference between *"an admin may restrict this"* and *"an admin
   must go and find this"*. (`test_an_ACTIVE_capability_flag_must_default_ON`)

   **The exemption:** `posture="security"`. There is exactly one member, and it is instructive.
   `signupEnabled` ON does not mean "users can see a feature" — it means any stranger who reaches
   the login page can create an account. A blanket default-ON rule would have opened the door on
   every fresh deployment in the name of discoverability. If you claim this exemption, the guard
   makes you come and say so out loud
   (`test_a_SECURITY_flag_that_ships_off_is_a_deliberate_exception`).

4. **`impact_when_off`.** The one question that decides whether an admin flips a switch affecting
   everybody is *"what breaks if I turn this off?"*. If you cannot answer it in a sentence, you do
   not understand your own flag yet.

Also add, if they apply:

- `still_allowed` — what KEEPS working. Not decoration: an admin who doesn't know a switch is
  non-destructive will avoid one they should feel free to use.
- `depends_on` — a flag that needs another to be on. The page renders the dependent as
  **"On, but having no effect"** and the turn-off dialog names the cascade.
- A probe in `app/services/feature_impact.py`, if there is a **cheap, honest count** of what turning
  it off would touch ("38 views already use this layout"). **A probe may not guess.** If there is no
  truthful number, add nothing — the dialog then says *"we can't measure this one"*, which is the
  correct answer and is very different from an empty space.

No migration is needed. Definitions are code-owned; the seeder reconciles them on startup.

---

## Ending one

A flag that outlives the question it was asked to answer is debt. Two things end a flag: the feature
is being **removed**, or the feature has stopped being **optional**. The procedure is the same, and
**the order is not optional.**

1. **Mark it `stage="deprecated"`.** It stays on the page, still honoured, so nobody is surprised.
2. **Remove the gates** — the `require_feature(...)` from the server, the `useFeature(...)` from the
   client. The guard now enforces the OPPOSITE of the usual rule: the key must appear **nowhere** in
   either tree (`test_a_DEPRECATED_flag_has_had_its_gates_REMOVED`).
3. **Delete the definition** from `features_seed.py` and `feature_wiring.py`.
   `feature_flags_repo.remove_keys_from_config` cleans the stored value.

**Why that order?** The dangerous half-step is deleting the definition while the gates are still in
the code. That leaves an unlisted switch quietly refusing things, with nothing on any page that can
turn it back on. The guard makes that sequence impossible.

---

## Things that are true and worth knowing

**The guard reads the Python AST, not the text.** An early version passed a flag on the strength of
a mention in a *docstring* — the guard being satisfied by a comment *about* the thing instead of the
thing. Prose cannot satisfy it.

**Fail-open vs fail-closed is a real decision.** `posture="capability"` fails **open**: if the flag
cannot be read (database hiccup), users keep their product. `posture="security"` fails **closed**: if
we cannot tell whether the admin left the door open, we assume they wanted it shut. The cost of
guessing wrong is unbounded in one direction and merely annoying in the other.

**A `string[]` flag governs only the options it enumerates.** `allowedViewModes` is an allow-list
over the layouts it names, not a universal whitelist over every string the API accepts — otherwise
the next person to add a layout would find it 403ing until they remembered to update the registry, a
trap that fires far from its cause.

**Changes are attributed.** Every flip records who did it and what it moved from
(`feature_flag_changes`). The page shows it against the switch. Nothing you need to do — it's
automatic — but it means "who turned this off?" is now answerable, which it wasn't.

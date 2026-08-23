# Announcing Analytics — 2026-08-23

**Status:** shipped on `claude/analytics-dashboard-insights-clrxbl`
**Full detail:** [Release notes](../RELEASE_NOTES_2026-08-23_analytics-insights.md)

---

# Part 1 · For internal readers

*Sales, CS, leadership. What shipped, what it proves, and what to be careful about.*

## The one-line version

{brand} can now answer "is this growing, and is anyone getting value out of it?" — on a
dashboard, in plain language, without exposing anything that identifies a person.

## What shipped

A top-level **Analytics** section with six tabs (Overview, Growth, Engagement, Content, Health,
Workspaces), one range control every chart obeys, and a strip of server-computed observations
that say what changed in sentences before anyone reads a chart.

Underneath it, the thing that makes it credible: **the product now measures its own value
moment.** Previously we could prove people opened views. We could not prove anyone ever traced
lineage — the reason the platform exists. Seven product actions are now instrumented, including
the failures: a trace that comes back with nothing and a search that finds nothing are recorded
as their own event types, because every other number on the page counts them as engagement.

And usage figures now appear **on the content itself** — opens, distinct viewers and a trend on
the view page — so the person who built something learns whether anyone uses it without ever
opening the dashboard.

## What it proves in a conversation

- **"Can we see adoption without a data team?"** Yes, and without a warehouse export. Every
  number was already in the database; this reads it.
- **"Can we open it to the whole company?"** Yes — one switch, and the version everyone else
  sees is redacted server-side, not hidden with CSS. Totals stay whole; names do not appear.
- **"Will it slow down as we grow?"** The costly path was removed rather than tuned. Counting
  one view's usage went from 1345 ms to 2.4 ms on a 200k-open dataset, and the standard windows
  are precomputed in the background so no reader waits on an aggregation.
- **"Does it respect our permissions?"** It follows them, and this release fixed four places
  where Analytics was *stricter* than the rest of the product — which sounds safe and is not: a
  dashboard that hides what the app shows teaches people its numbers are unreliable.

## What is off by default, and why

| Setting | Default | Say this |
|---|---|---|
| Analytics section | Admins, auditors and org admins only | Nothing is published on upgrade. |
| **Analytics for everyone** | **Off** | One switch opens a redacted view to all staff. Fails closed by design. |
| **What everyone can see** | **Show colleagues** | Counts and trends plus who built what. "Aggregate only" names nobody. |
| **Show every workspace** | **Off** | Reporting only, never access — but it *does* report on workspaces someone cannot open. Deliberate operator decision. |
| **Contact from Analytics** | **Off** | Adds email addresses only beside people attached to something the reader can already open. |

## Caveats worth saying out loud before a customer finds them

- **Usage history starts now.** View opens are counted from product events, which this release
  begins recording per open. Charts will not backfill a year of history on day one.
- **The numbers are minutes old**, by design — precomputed in the background. The page says how
  old, and a stall shows up as staler numbers, not as an outage.
- **Publishing per-person activity to all staff is a works-council question** in parts of the
  EU. "Aggregate only" exists for exactly that, and names nobody at any level.
- **Comparison charts draw a double-width axis.** A 30-day window spans 60 days so both periods
  sit on real dates; each bar is correspondingly narrower. The page says so.

---

# Part 2 · For everyone using {brand}

## Analytics is here

There is a new **Analytics** section in the sidebar. It answers the questions people have been
answering by guesswork: how much is the platform being used, by how many people, on what, and
whether that is going up.

Pick a period once — the last 7 days through the last year, or any custom range — and every
chart, figure and table on the page moves with it. The numbers always agree with each other.

### The six tabs

- **Overview** — the headline figures, and a short list of what actually changed, written out
  in sentences. If nothing meaningful moved, it says nothing rather than inventing something.
- **Growth** — sign-ups, where people came from, whether they stayed, and how the platform has
  grown over time.
- **Engagement** — who is active, how often people come back, and where new users drop out
  between signing up and getting an answer.
- **Content** — what has been built, who built it, what gets opened — and what never does.
- **Health** — whether the data people are reading is actually fresh, who is waiting for
  access, whether invitations are being accepted, and how much of the estate has an ontology.
- **Workspaces** — what your estate is made of: how many workspaces exist, how many have gone
  quiet, how many have nothing connected, and how size and team size are distributed. Open any
  workspace you belong to for its own detail.

### Every number tells you what it means

Hover the ⓘ beside a figure and it says three things: what is being counted, how it is
computed, and — the useful one — what you should do differently if it moves. If we could not
answer that third question, the number is probably not on the page.

### "Is anyone using this?" — now on the view itself

Open any saved view and its usage sits beside the name: how many times it has been opened, how
many different people opened it, and the shape of that over time. A steady habit and one burst
six months ago produce the same total, and only the shape tells them apart.

A view nobody has opened says so in words. That is the most useful thing its author can learn,
and a bare zero reads like a broken counter.

If you can open a view, you can see how much it is opened. There is no extra permission for it.

### Custom date ranges, with a real calendar

The range picker now shows two months side by side, paints the days you have picked as one
band, and tells you how long the range is and what it will be compared against. Four named
periods sit above it — this month, last month, this quarter, last quarter — because "how did
March compare to April" is the question presets could never answer. It works entirely from the
keyboard.

### Comparing two periods honestly

When a chart shows the previous period alongside the current one, both sit **on one continuous
timeline**, every bar on the date it actually happened, with a divider between them and a
caption naming each half. The earlier period is drawn hatched and outlined rather than just
faded — so it stays readable in greyscale, in a cropped screenshot, and for every kind of
colour blindness.

The trade-off is honest and on the page: a 30-day window draws a 60-day axis, so each bar is
half as wide.

Every chart has a table view if you would rather read the figures, and no chart has two
different scales fighting over one axis.

### Brand-new deployment?

If you have just set {brand} up, Analytics does not show you six empty charts and a flat line.
It shows you what to do next — invite people, connect a source, build a view — and only the
steps you personally have permission to take. The charts stay below, so you can see the shape
the page will take once there is something in it.

## Who can see what

By default, Analytics is for administrators, auditors and organisation admins.

Your administrator can open it to everyone. When they do, everyone sees the **whole platform's**
totals and trends — including workspaces they are not a member of, because an answer that
quietly drops most of the organisation is worse than no answer. What they do not see is names:
a workspace you are not in appears as a locked row that still counts toward the totals, and
individual activity is not shown.

Where something is hidden, the page says so and explains why — with the heading and description
still there, so you learn what the platform tracks even where you cannot see the figures. And a
locked workspace row offers to request access: it tells you what you are asking for, why the
name is missing, who will see the request and what happens next, and lets you leave a note.

Your administrator chooses between three levels — counts only, counts plus colleagues, or
counts plus colleagues plus operational health — and can separately allow email addresses to
appear beside the colleague who built something you can already open.

## Questions

- **Why does the page say "as of 4 min ago"?** The figures are computed in the background on a
  schedule so nobody waits on them. The exact time is on hover.
- **Why does this view show no usage history?** Opens are counted from this release onwards.
- **Why is a workspace's name hidden when I can see its numbers?** Because you are not a member.
  The totals include it; the identity does not. Request access from the row.

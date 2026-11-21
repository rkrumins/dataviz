# Asking Questions

*For anyone who opens a view and wonders what it shows, where its data comes from, or
whether it's right — and for the people who look after it.* Every view has a place to ask:
the question goes to the people who own the view and the data under it, the conversation
stays with the view, and the answer is there for the next person who wonders.

> **Before you start:** Questions are off until a platform administrator turns on
> conversations in [Feature Switches](/guide/feature-switches). You can ask about any view you
> can open, and anyone who can open it can be asked or mentioned.

```mermaid
sequenceDiagram
  participant You
  participant App as {brandShort}
  participant Owners as The view's owners and data owners
  You->>App: Ask a question about the view, or about one thing on it
  App->>Owners: Inbox message, with a link to the question
  Owners->>App: Reply, and mark the reply that answers it
  App->>You: Each reply in your Inbox, and the answer marked on the view
```

---

## Ask a question

Open the view and click **Questions** in its header — the number beside it counts the
questions still open. The drawer that opens lists who looks after the view, every question
asked about it so far, and **Ask a question…** at the top. You can also start from:

* **About** (or **Details → About**) in the view's header, where **Who to ask** names each
  owner and why they are one, with **Ask a question** under them;
* a node on the canvas: right-click it and choose **Ask about this**, and the question is
  about that one thing.

Write your question and press **⌘↵** (Ctrl+Enter on Windows and Linux), or click **Ask**.
Type `@` to mention someone who can open the view — their name joins the question, and they
are told.

### Who it goes to

**Send to** has two switches, both on for a view:

* **View's owners** — whoever made the view and the people who can edit it.
* **Data owners** — the data source's named owner and stewards. Where nobody is named yet,
  the people who connected the data or asked for it stand in.

Faces and a count show who each one reaches. **Add people** asks anyone else who can open
the view. Someone who can't open it can't be asked: the composer names them before you send,
so you can share the view with them first. If nobody at all can be asked, the question goes
to the workspace's admins.

### Who can see it

* **Everyone who can see this view** — the default. Anyone who can open the view can read
  the question and reply, so the answer helps the next person too.
* **Only the people involved** — a private question. Only you, the people you ask or
  mention, anyone who replies, the view's owners and the workspace's admins see it. A
  private question carries a **Private** badge; hover it to see who can read it.

## Follow the conversation

Every reply reaches you in your Inbox; click one to open the question at that reply. In the
drawer:

* a line marks **New since you last looked**, before the first reply you haven't seen;
* **Open**, **Answered**, **All** and **Mine** filter the list, each with its count, and an
  unread question carries a dot;
* the **…** on a question offers **Copy link**, **Mute notifications** (stop hearing about
  it), **Follow** (hear about it without having taken part), **Close question** and
  **Reopen**;
* the **…** on a message offers **Copy link**, and **Edit** or **Delete** on your own. An
  edited message says so; a deleted one leaves a note in its place.

**Watch** in the drawer's header tells you about every new open question on the view, even
ones you weren't asked.

## Answer a question

When you're asked, reply in the box at the foot of the question. Hover the reply that answers
it and click **Mark as answer** — the asker, the view's owners and admins can. The question
moves to **Answered**, and the reply is framed in green with who accepted it, so the next
reader finds it first. Changed your mind? **Unmark as answer** from the reply's **…**.

A question nobody has answered after three days is brought up again with the people asked,
and after a week with the workspace's admins.

If someone else changed a question while you were looking — answered or closed it — the
drawer says **This changed** with **Reload**, rather than overwriting what they did.

## Questions on the canvas

A question asked about one thing on the canvas puts an amber **?** beside it, with how many
are still open — a grey one once they're all answered or closed. Click the **?** to see the
questions about that thing alone, and ask another. In a question about a node, **Show on
canvas** closes the drawer and selects the node, bringing it into view.

You can also ask from the Explorer: a view's preview shows **Who to ask** under who made it
and a **Questions** button with the open count, and the **…** on a view's card offers **Ask a
question**.

## Ask about the data

Questions about the data itself — where it comes from, how fresh it is, what a field means —
belong to the data source. Open it from the workspace's **Data → Sources**:

* **Who to ask about this data** on its Overview names its **Owner** and **Stewards**, people
  or teams. While nobody is named, it shows who it worked out instead — whoever connected
  it, the people named on the data request it came from, else the workspace's admins — and
  says so. **Ask a question** there opens the ask box.
* the **Questions** tab, with the open count, lists what was asked about it; a question opens
  right there, and the link in a notification lands on it.
* **Watch** in the source's header tells you about every new open question on it.

Anyone who manages the source can name its Stewards (**Edit**, or **Name them**), up to ten,
each a person or a team of up to 50 — a bigger team is flagged before you save. The Owner is
the workspace admins' to change, or the current Owner's — handing it on. **Who to ask about
this data** is there, and editable, whenever conversations or **Data source details** are
on; **Ask a question** needs conversations. The Owner and Stewards named here are the ones
who can certify the source — see [Describing and Trusting Data](/guide/describing-data).

## Your conversations

Your profile — **Your profile** in the menu under your avatar, top right — has a
**Conversations** tab with how many are unread. **Conversations** in the same menu goes
straight there.

* **To me** — questions asked of you, as a view's owner or the data's.
* **Mine** — the ones you asked.
* **Mentions** — where someone @mentioned you.
* **Watching** — new questions on the views and data you watch.

Pick one to read it beside the list (on a phone it opens on its own, with **Back**); **Open
the view** or **Open the data source** takes you to it. **Status** narrows the list to open,
answered or closed questions. The **Watching** tab lists what you watch, with how many open
questions each has, and stops watching one. Your profile's Overview leads with **Waiting on
you**: the open questions asked of you that nobody has answered yet.

## People's profiles

Hover a person's name — on a question, in **Who to ask**, on a view's card — and choose **View
profile**, or click an @mention. Their profile shows the workspaces they run, the views they made and
the data they look after, each as far as you can see it. **Ask a question** on it lists their
views and data; choose one and the ask box opens with them among the people asked. A
question is always about something — there are no direct messages.

## Where to next

- [Browsing Views](/guide/browsing-views) — when you're looking for the view to ask about.
- [Managing Views](/guide/managing-views) — when you own a view and want to share it with
  someone who can't open it yet.
- [Requesting Access](/guide/requesting-access) — when the question is really "can I see
  this?".
- [Feature Switches](/guide/feature-switches) — when you administer the switch that turns
  questions on.

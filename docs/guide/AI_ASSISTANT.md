# AI Assistant

*For everyone who reads views, and for administrators who set the assistant up.*

The assistant answers questions about your data in plain language — what feeds what, what breaks if something changes, which tables hold personal data, which views cover a subject — and about using {brand} itself. It writes searches for you, shows its working, and asks rather than guesses when your words could mean more than one thing. It reads only what you can read, and never changes anything.

> **Note:** The assistant is off until an administrator turns on **AI assistant** under **Administration → Features** and connects an AI model under **Administration → AI**. See [For administrators](#for-administrators).

---

## Get started in 2 minutes

1. Open a View and press **⌘J** / **Ctrl+J**, or choose the assistant button in the top bar. The panel opens beside the page.
2. Ask: *What breaks if `customers` is removed?*
3. Watch **How I got this** — each step the assistant takes, as it takes it.
4. Read the answer and its report card. **Open the trace** shows it on the canvas; **Open in Advanced Search** gives you the exact search to keep.
5. Click a follow-up chip — *Who owns the affected assets?* — or type your own: *only the dashboards*.

---

## Two ways to ask

The switch at the top of the panel chooses who answers:

| | **Ask about data** | **Help** |
|---|---|---|
| Answers | Questions about your views, lineage and data | Questions about using {brand} |
| From | The views and data sources you can read, as you | The documentation and user guide, and knowledge sources your administrator added |
| Shows | Results, impact reports, searches, view suggestions | Steps, with links to the exact section they come from |

The **context chip** says what the assistant is looking at — *View Supply chain · 2 selected*. Remove it to ask about anything you can access.

---

## Asking about data

| You ask | You get |
|---|---|
| *What are the downstream consumers of suppliers?* | A lineage report: everything it feeds, by type and container, ending in the dashboards and reports that use it |
| *If first_name in customers is dropped, who is affected, why and when?* | An **impact report** — below |
| *Which tables hold PII?* | A results card, after the assistant confirms what PII means in this data source |
| *Do any of those feed my datasets in Finance?* | The earlier results, narrowed — "those" always means the last results |
| *Where does revenue_daily come from?* | Its upstream lineage, back to the sources and the jobs on the way |
| *Do we have views about supply-chain failures?* | View cards, across every workspace you can read, with **Open** |
| *Write the search for datasets owned by finance that feed a dashboard* | A query card — the search in the query language, with how many it finds |
| *Write Cypher for the ten largest tables* | Cypher, checked to be read-only, to open in the **Cypher** tab and run yourself |

Right-click an entity on the canvas and choose **What breaks if this changes?**, or choose **Ask about this** in its drawer, to ask about it directly.

### Reading an impact report

| Part | Tells you |
|---|---|
| **Severity** | High, medium or low, with the reasons — consumers reached, how much is affected, certified or critical assets. A guide, not a verdict |
| **Affected** | How many entities, by type, exactly — or *at least* when the data source is too large to count in time |
| **Consumers** | The dashboards, reports and models at the end of the line, and how many steps away |
| **Owners to tell** | The owners recorded on the affected assets or their containers. *No owner is recorded* when there are none |
| **Why** | The path from what changes to each consumer, with what each step records about the transformation |
| **When** | The schedules of the jobs on the way — *the first job that reads it runs daily at 04:00 UTC* — when the metadata has them |
| **Notes** | Whether the answer used physical lineage (exact) or rolled-up lineage (faster, approximate), and anything cut short |

### When the assistant asks you

Words such as *PII*, *owner*, *updated* or *ingested* are recorded differently in every catalogue. When yours could mean more than one thing, the assistant shows what it found, with how many entities each holds:

> There's nothing called "PII" in this data source. Which of these means PII here?
> ○ Tag "pii" — on 312 columns  ○ personal_data is true — on 290 columns  ○ Either of these — 340 columns

Pick one. Tick **Remember for this data source** and it will not ask you again; administrators can make a reading everyone's under **Business vocabulary**. Your remembered readings are listed — and can be forgotten — from the panel's menu.

### Follow-ups

Every result is remembered for the conversation. *Those*, *these* and *of them* mean the last results, however many there are, and the assistant adds your new condition to the search that produced them rather than to a list — so the answer stays exact.

---

## Help

Ask how to do something: *How do I share a view with a team?*, *Why can't I edit this view?*, *What is a data source?* Answers come with numbered citations; each opens the guide at the section it came from. When the docs don't answer, the assistant says so and gives your support contact. If a feature is switched off in your deployment, it tells you.

---

## In Advanced Search

- **Ask AI** — when **Ask in plain words** can't place your words, **Ask AI** writes the search instead. It reads back what it understood and how many it finds before anything changes, marked *AI-drafted*, with any assumptions. **Enter** applies it; it is then an ordinary search you can edit, save and share.
- **Draft with AI** in the **Cypher** tab writes read-only Cypher for your question. Review it, then press **Run** — the assistant never runs Cypher itself.

**Ask in plain words** stays rule-based and sends nothing anywhere; only **Ask AI** and **Draft with AI** use the AI service.

---

## What is sent, and what is kept

- Your question, and the names, types — and, if your administrator allows, descriptions and property values — of what the answer needs, are sent to the AI model your administrator connected. Nothing you cannot read is ever sent: the assistant reads as you.
- The assistant never changes anything. It cannot: it reads with a read-only pass that expires within minutes.
- Conversations are kept for you only, for 30 days unless your administrator chose otherwise. Delete one from the history menu at any time.
- The activity log records *that* you asked, and where — never what.

---

## For administrators

### Turn it on

1. **Administration → Features → AI assistant**: on. (It is a security switch: off if its value can't be read.)
2. **Administration → AI → Connections → Add connection**, and **Test connection**.
3. **Administration → AI → Assistant**: choose the connection for answers, and for embeddings if you want matching by meaning.

Who may use it is the `workspace:ai:use` permission, which every role that reads data sources has; remove it from a role under **Administration → Permissions** to withhold it.

### Connecting a model

Any endpoint that speaks the OpenAI Chat Completions API works: OpenAI, Azure OpenAI, vLLM, Ollama, LiteLLM and most corporate gateways.

| Your endpoint signs in with | Choose | You give |
|---|---|---|
| A key in a header | **API key** | The key; the header (`Authorization`, or `api-key` for Azure) and prefix (`Bearer`, or none) |
| A fixed token | **Bearer token** | The token |
| A username and password, on every call | **Basic** | Both |
| OAuth client credentials | **OAuth client credentials** | Token URL, client id and secret, scope, audience |
| A token you mint first — a username and password, or a custom request | **Token mint** | The token URL, the body (with `{{username}}`, `{{password}}`, `{{clientId}}`, `{{clientSecret}}`), where the token is in the answer (`access_token`, `data.token`…), when it expires, and the header to send it in |

For **Azure OpenAI**, the **Azure** preset sets the path `/openai/deployments/{model}/chat/completions` and the `api-version` query parameter; the model names are your deployment names. Secrets are stored encrypted and never shown again; leave a secret's field as it is to keep it.

**Test connection** checks three things: that it answers, that it can call tools (if not, the assistant uses a strict JSON protocol with it instead), and that it can embed.

> **Tip:** An endpoint on your private network must be allowed by an operator first: they list its `host:port` in `AI_EGRESS_ALLOWED_HOSTS`. Cloud metadata and loopback addresses are never reachable.

### Data sharing and limits

Under **Assistant**:

- **Data sharing** — whether descriptions, property values and sample values may be sent to the model; how many result rows it sees (the person always sees them all); patterns to redact from everything sent, such as email addresses.
- **Limits** — tool calls per answer, tokens per person per day, answers running at once per person.
- **Retention** — how many days conversations are kept.

### Knowledge

Under **Knowledge**:

- **Collections** — the docs and the views catalogue, embedded for matching by meaning when an embedding connection is set and the vector store is configured. Each shows its model, size and last sync; **Re-index** rebuilds one. Without embeddings, matching is by keyword.
- **The views catalogue** needs a read-only service account's API key (`AI_INDEXER_API_KEY`, set by an operator) to list views. Private views are never embedded.
- **External sources** — MCP servers your teams host (a wiki, a runbook store). Give the URL, how to sign in, the tool to call, and how its arguments and results map. Their answers are labelled with the source's name and trust label wherever they appear.

### Business vocabulary

What a word means in a data source — *PII is the tag pii*. People's remembered readings are listed by data source; **Make it everyone's** promotes one to the whole workspace, and **Remove** forgets it.

### Usage and feedback

Requests and tokens by day, and the answers people marked 👎 with their comments — the questions the docs or the metadata do not answer yet.

---

## For other teams' agents: the knowledge MCP endpoint

Agents can search {brand}'s documentation and the views their key can read over the Model Context Protocol:

```bash
curl -s https://your-host/api/v1/ai/mcp/knowledge \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_knowledge","arguments":{"query":"share a view","collection":"docs"}}}'
```

Tools: `list_collections`, `search_knowledge` and `get_document`. Use an [API key](/guide/api-keys) with read access, or a service account's. Point an MCP client at the URL with the key as a bearer token.

---

## Troubleshooting

| You see | Why | What to do |
|---|---|---|
| *No AI model is connected yet* | No connection is chosen for answers | An administrator chooses one under **Administration → AI → Assistant** |
| *The AI connection's sign-in was refused* | The endpoint rejected the credentials | **Test connection**; rotate the secret |
| *…may not reach* | The endpoint is on a private network not allowed, or plain http in production | An operator adds it to `AI_EGRESS_ALLOWED_HOSTS`; use https |
| *You have used today's assistant budget* | The daily token limit per person | Wait until midnight UTC, or an administrator raises it |
| Counts say *at least* | The data source was too large to count in time | The rest of the answer stands; narrow the question for an exact count |
| No owners or schedules in a report | The metadata doesn't record them | Add `owner` and schedule properties at ingestion |
| A Neo4j or Spanner source gives partial answers | Search and closure walks need FalkorDB | — |

---

## Where to next

- [Advanced Search](/guide/advanced-search) — the search the assistant writes, and how to keep it
- [Reading Lineage](/guide/reading-lineage) — what the trace shows
- [Feature Switches](/guide/feature-switches) — the **AI assistant** switch
- [API Keys](/guide/api-keys) — for the knowledge MCP endpoint

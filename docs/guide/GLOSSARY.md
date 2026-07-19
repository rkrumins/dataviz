# Glossary & Acronyms

Every term and acronym you'll meet in {brand}, in plain language. Skim it once;
return whenever a word trips you up.

> **Tip:** New to the platform? Pair this with [Key Concepts](/guide/key-concepts),
> which explains how the core terms fit together.

---

## Core platform terms

| Term | Meaning |
| --- | --- |
| **Provider** | A connection to a graph database (FalkorDB, Neo4j, DataHub, Spanner) where lineage data lives. |
| **Catalog Item** | A discovered graph/dataset registered for governed sharing into workspaces. |
| **Workspace** | An isolated team or project context containing data sources, Views, and members. |
| **Data Source** | A binding of a catalog item (graph) + ontology that you actually explore. |
| **Ontology** | The semantic layer — the dictionary defining entity types, relationships, and visuals. |
| **Semantic Layer** | Another name for the ontology; the meaning layer over raw data. |
| **Entity Type** | A kind of node (Domain, Dataset, Table, Column, Dashboard…). |
| **Relationship Type** | A kind of edge (e.g. "feeds", "contains"). |
| **View** | A saved, shareable snapshot of an exploration. |
| **Context Lens / Lens** | A saved configuration that focuses or organises a View. |
| **Layer** | A lane/row grouping nodes within a View (e.g. by pipeline stage). |
| **Layer Studio** | The tool for organising a View's nodes into layers. |

---

## Exploration terms

| Term | Meaning |
| --- | --- |
| **Lineage** | The network of connections showing how data flows. |
| **Upstream** | Where data came from (follow arrows backwards). |
| **Downstream** | What data feeds (follow arrows forwards). |
| **Trace** | Following lineage edges from a node to reveal its chain. |
| **Expand** | Following containment edges to reveal a node's children. |
| **Blast Radius** | Everything affected by a change to a given node. |
| **Granularity** | The level of detail: column → table → domain. |
| **Persona Toggle** | Switch between Business and Technical framing of the same graph. |
| **Projection Mode** | How a graph is laid out (Graph, Hierarchy, Reference, Layered). |
| **Canvas / Explorer** | The interactive space where the graph is drawn and explored. |
| **Node** | A single item in the graph (a table, column, dashboard…). |
| **Edge** | A connection between two nodes. |

---

## Access & governance terms

| Term | Meaning |
| --- | --- |
| **Role** | A named bundle of permissions (Admin, User, Viewer, or custom). |
| **Permission** | A fine-grained capability (e.g. "create views"). |
| **Role Binding** | An assignment of a role to a user/group at a scope. |
| **Scope** | Where access applies — **global** (whole platform) or **workspace**. |
| **Group** | A set of users managed and granted access together. |
| **Resource Grant** | Explicit share of a single resource (e.g. a View) to a person/group. |
| **Visibility** | A View's reach: Personal, Team, or Enterprise. |
| **My Access** | The page showing what *you* are allowed to do. |
| **Approval** | The admin step that activates a pending signup. |
| **Audit Trail** | A log of sensitive changes (e.g. ontology lifecycle). |
| **Feature Flag** | An admin toggle that enables/disables a capability. |
| **Announcement** | A banner notification shown to users. |
| **Impact Analysis** | A preview of what depends on something before you delete/change it. |
| **Aggregation** | Background processing that powers higher-level granularity. |
| **Discovery / Introspection** | Detecting the graphs and schema inside a provider. |
| **Source Mapping** | Translating an external system's type labels into {brand} types. |
| **Drift** | External types not yet mapped to your ontology. |

---

## Acronyms

| Acronym | Stands for | In {brand}… |
| --- | --- | --- |
| **RBAC** | Role-Based Access Control | How permissions are granted via roles. |
| **URN** | Uniform Resource Name | A unique identifier for a node/entity. |
| **ADR** | Architecture Decision Record | A documented design decision (see engineer [docs](/docs)). |
| **JWT** | JSON Web Token | The token issued at login for your session. |
| **SSO** | Single Sign-On | Logging in via a central identity provider; admins can configure it. |
| **OIDC** | OpenID Connect | One of the two supported SSO protocols. |
| **SAML** | Security Assertion Markup Language | The other supported SSO protocol. |
| **SCIM** | System for Cross-domain Identity Management | The protocol for syncing users/groups from an identity provider. |
| **WIP** | Work In Progress | A suggested tag/prefix for unfinished Views. |
| **UI / UX** | User Interface / Experience | How the platform looks and feels. |

---

## Database & tech names you may see

| Name | What it is |
| --- | --- |
| **FalkorDB** | The default graph database (Redis-protocol). |
| **Neo4j** | A supported enterprise graph database. |
| **DataHub** | A supported metadata/catalog source. |
| **Spanner** | A supported cloud graph database backend. |
| **PostgreSQL / SQLite** | The platform's own management database (prod / local dev). |

---

Can't find a term? It may be covered in [Key Concepts](/guide/key-concepts), or in
the deeper engineer-focused [documentation](/docs).

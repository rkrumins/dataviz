"""Business words, read as searches — and asked about rather than guessed.

"PII", "owner", "ingested", "updated" mean something different in every
catalogue: a tag ``pii``, a property ``personal_data = true``, an edge to a
``PII`` glossary term, ``last_modified``, ``updated_at``… The assistant does not
pick one silently. For a word it is given it:

1. uses a **confirmed reading** if there is one — confirmed in this
   conversation, remembered by this person for this data source, or set for
   the whole workspace by an administrator (``ai_concept_mappings``);
2. otherwise gathers **candidates** from the data itself — tags, property
   keys, property values and named tag or glossary entities that match the
   word or its usual synonyms — and **counts** each one exactly, in scope;
3. applies a candidate on its own only when it is the word itself (a tag
   called ``PII`` for "PII") and nothing else matches anything; otherwise it
   **asks**, listing the candidates with their counts and "any of these",
   and remembers the answer if the person says so.

So an answer about PII is about what this data source calls PII, and says so.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import or_, select

from ..models import AiConceptMappingORM
from . import predicates as P

logger = logging.getLogger(__name__)

#: Usual synonyms. The model may add more for a word it is given.
LEXICON: dict[str, tuple[str, ...]] = {
    "pii": ("pii", "personal", "personaldata", "personallyidentifiable", "gdpr", "sensitive",
            "ppi", "privacy", "confidential", "phi"),
    "personal data": ("pii", "personal", "personaldata", "gdpr", "sensitive", "privacy"),
    "sensitive": ("sensitive", "confidential", "restricted", "pii", "secret", "classification"),
    "owner": ("owner", "steward", "custodian", "team", "contact", "responsible", "maintainer"),
    "updated": ("updated", "modified", "lastmodified", "changed", "refreshed", "lastsynced",
                "synced", "loaded", "lastupdate"),
    "created": ("created", "creation", "createdat", "since"),
    "ingested": ("raw", "bronze", "landing", "ingest", "ingestion", "source", "staging", "stg"),
    "certified": ("certified", "gold", "trusted", "verified", "endorsed"),
    "deprecated": ("deprecated", "legacy", "retired", "obsolete", "sunset"),
    "critical": ("critical", "tier1", "tier0", "p1", "important", "sla"),
    "domain": ("domain", "businessunit", "area", "department"),
}

_MAX_CANDIDATES = 8


def option_id(predicate: dict) -> str:
    """Stable for the same reading, so a choice made on one request can be
    applied on the next without the server remembering anything."""
    digest = hashlib.sha1(json.dumps(predicate, sort_keys=True).encode()).hexdigest()[:10]
    return f"opt_{digest}"


def clarification_id(concept: str, data_source_id: Optional[str]) -> str:
    digest = hashlib.sha1(f"{norm(concept)}@{data_source_id or ''}".encode()).hexdigest()[:10]
    return f"clr_{digest}"


def norm(text: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def tokens_for(name: str, synonyms: Optional[list[str]] = None) -> set[str]:
    key = name.strip().lower()
    out = {norm(name)} | {norm(w) for w in re.split(r"\s+", key) if len(norm(w)) >= 3}
    for entry, words in LEXICON.items():
        if norm(entry) == norm(name) or norm(name) in words:
            out |= set(words)
    out |= {norm(s) for s in synonyms or [] if len(norm(s)) >= 2}
    return {t for t in out if len(t) >= 2}


@dataclass
class Candidate:
    id: str
    label: str
    description: str
    predicate: dict
    exact: bool = False
    kind: str = "tag"           # tag | property | value | entity
    property_key: Optional[str] = None
    count: Optional[int] = None

    def option(self) -> dict:
        return {"id": self.id, "label": self.label,
                "description": self.description + (f" · {self.count:,} in scope" if self.count is not None else ""),
                "count": self.count}


@dataclass
class Resolution:
    status: str                         # mapped | auto | ask | missing
    concept: str
    label: str = ""
    predicate: Optional[dict] = None
    property_key: Optional[str] = None
    source: str = ""                    # conversation | personal | workspace | data
    candidates: list[Candidate] = field(default_factory=list)
    clarification: Optional[dict] = None

    def for_model(self) -> dict:
        out: dict[str, Any] = {"concept": self.concept, "status": self.status}
        if self.predicate is not None:
            out.update({"label": self.label, "predicate": self.predicate, "source": self.source})
            if self.property_key:
                out["propertyKey"] = self.property_key
            out["useAs"] = {"kind": "concept", "name": self.concept}
        if self.status == "ask":
            out["note"] = ("The person has been asked which reading they mean. Stop and wait "
                           "for their choice; do not guess.")
        if self.status == "missing":
            out["note"] = ("Nothing in this data source matches. Say so plainly, and ask how it "
                           "is recorded (a tag? a property?) instead of inventing a filter.")
        if self.status == "auto" and len(self.candidates) > 1:
            out["alsoFound"] = [c.label for c in self.candidates[1:4]]
        return out


# ── Stored mappings ─────────────────────────────────────────────────────


async def stored(session, *, data_source_id: str, user_id: str, concept: str) -> Optional[AiConceptMappingORM]:
    key = norm(concept)
    rows = (await session.execute(
        select(AiConceptMappingORM).where(
            AiConceptMappingORM.data_source_id == data_source_id,
            AiConceptMappingORM.concept == key,
            or_(
                AiConceptMappingORM.scope == "workspace",
                (AiConceptMappingORM.scope == "personal") & (AiConceptMappingORM.user_id == user_id),
            ),
        )
    )).scalars().all()
    # A person's own reading wins over the workspace's.
    rows.sort(key=lambda r: 0 if r.scope == "personal" else 1)
    return rows[0] if rows else None


async def remember(session, *, workspace_id: str, data_source_id: str, user_id: str,
                   concept: str, label: str, predicate: dict, description: str = "") -> None:
    key = norm(concept)
    row = (await session.execute(
        select(AiConceptMappingORM).where(
            AiConceptMappingORM.data_source_id == data_source_id,
            AiConceptMappingORM.scope == "personal",
            AiConceptMappingORM.user_id == user_id,
            AiConceptMappingORM.concept == key,
        )
    )).scalar_one_or_none()
    now = datetime.now(timezone.utc).isoformat()
    if row is None:
        row = AiConceptMappingORM(
            workspace_id=workspace_id, data_source_id=data_source_id, scope="personal",
            user_id=user_id, concept=key, created_by=user_id, created_at=now,
        )
        session.add(row)
    row.label = label[:200]
    row.description = (description or f"What “{concept}” means in this data source")[:500]
    row.predicate = json.dumps(predicate)
    row.updated_at = now
    await session.flush()


async def all_for(session, *, data_source_id: str, user_id: str) -> list[dict]:
    rows = (await session.execute(
        select(AiConceptMappingORM).where(
            AiConceptMappingORM.data_source_id == data_source_id,
            or_(AiConceptMappingORM.scope == "workspace",
                (AiConceptMappingORM.scope == "personal") & (AiConceptMappingORM.user_id == user_id)),
        )
    )).scalars().all()
    return [{"concept": r.concept, "label": r.label, "scope": r.scope} for r in rows]


# ── Candidates from the data ────────────────────────────────────────────


def _looks_boolean(prop: dict) -> bool:
    kinds = set(prop.get("kinds") or [])
    if "Boolean" in kinds:
        return True
    values = {str(v.get("value")).lower() for v in prop.get("values") or []}
    return bool(values) and values <= {"true", "false", "yes", "no", "y", "n", "1", "0"}


def _truthy_value(prop: dict) -> Any:
    for v in prop.get("values") or []:
        raw = v.get("value")
        if str(raw).lower() in ("true", "yes", "y", "1"):
            return raw
    return True


def candidates_from(grounding, name: str, *, synonyms: Optional[list[str]] = None,
                    want: str = "predicate") -> list[Candidate]:
    """Every reading of *name* the catalogue suggests, best first, uncounted."""
    toks = tokens_for(name, synonyms)
    exact_key = norm(name)
    found: list[Candidate] = []

    def matches(text: Any) -> bool:
        n = norm(text)
        return bool(n) and any(t in n for t in toks if len(t) >= 3 or t == n)

    if want == "predicate":
        for tag in grounding.tags():
            value = tag.get("tag")
            if matches(value):
                found.append(Candidate(
                    id="", label=f"Tag “{value}”",
                    description=f"tagged {value}", kind="tag",
                    predicate={"kind": "tag", "op": "has", "values": [value]},
                    exact=norm(value) == exact_key,
                ))
    for prop in grounding.properties():
        key = prop.get("key")
        if not key:
            continue
        if matches(key):
            if want == "property":
                found.append(Candidate(
                    id="", label=f"The property “{key}”",
                    description=f"{', '.join(prop.get('kinds') or []) or 'values'}",
                    kind="property", property_key=key,
                    predicate={"kind": "hasProperty", "key": key}, exact=norm(key) == exact_key,
                ))
            elif _looks_boolean(prop):
                value = _truthy_value(prop)
                found.append(Candidate(
                    id="", label=f"{key} is {str(value).lower()}",
                    description=f"property {key}", kind="property", property_key=key,
                    predicate={"kind": "property", "key": key, "op": "eq", "value": value},
                    exact=norm(key) in (exact_key, f"is{exact_key}", f"has{exact_key}"),
                ))
            else:
                found.append(Candidate(
                    id="", label=f"Has a “{key}” value",
                    description=f"property {key}", kind="property", property_key=key,
                    predicate={"kind": "hasProperty", "key": key}, exact=False,
                ))
        if want == "predicate":
            for v in prop.get("values") or []:
                raw = v.get("value")
                if isinstance(raw, str) and matches(raw) and not matches(key):
                    found.append(Candidate(
                        id="", label=f"{key} is “{raw}”",
                        description=f"property {key}", kind="value", property_key=key,
                        predicate={"kind": "property", "key": key, "op": "eq", "value": raw},
                        exact=norm(raw) == exact_key,
                    ))
    for c in found:
        c.id = option_id(c.predicate)
    found.sort(key=lambda c: (not c.exact, {"tag": 0, "property": 1, "value": 2, "entity": 3}[c.kind]))
    seen, out = set(), []
    for c in found:
        sig = json.dumps(c.predicate, sort_keys=True)
        if sig not in seen:
            seen.add(sig)
            out.append(c)
    return out[:_MAX_CANDIDATES]


async def entity_candidates(client, target, name: str, type_ids: list[str]) -> list[Candidate]:
    """Tag and glossary *entities* named like the word: matches are what is
    linked to one (a ``TAGGED_WITH`` edge rather than a tag on the node)."""
    if not type_ids or not target.searchable:
        return []
    refs = [{"path": ["**", name], "entityType": t, "caseSensitive": False} for t in type_ids[:4]]
    try:
        body = await client.resolve(target.workspace_id, target.data_source_id,
                                    target.scope("data_source"), refs)
    except Exception as exc:  # noqa: BLE001 — a candidate source, not the answer
        logger.info("concept entity lookup failed: %s", exc)
        return []
    out = []
    for type_id, result in zip(type_ids, (body or {}).get("results") or []):
        for match in (result.get("matches") or [])[:2]:
            out.append(Candidate(
                id="", label=f"Linked to the {type_id} “{match.get('displayName')}”",
                description=f"connected to that {type_id}", kind="entity",
                predicate={"kind": "related", "axis": "neighbor", "edgeClass": "links",
                           "where": {"kind": "is", "refs": [{"urn": match.get("urn")}]}},
                exact=norm(match.get("displayName")) == norm(name),
            ))
    for c in out:
        c.id = option_id(c.predicate)
    return out


async def count(client, target, candidates: list[Candidate], *, scope_mode: str,
                applies_to: Optional[str]) -> None:
    if not candidates or not target.searchable:
        return
    items = []
    for c in candidates:
        predicate = P.all_of(c.predicate, P.of_types([applies_to])) if applies_to else c.predicate
        items.append({"id": c.id, "predicate": predicate})
    try:
        body = await client.counts(target.workspace_id, target.data_source_id,
                                   target.scope(scope_mode), items, budget_seconds=15)
    except Exception as exc:  # noqa: BLE001
        logger.info("concept counts failed: %s", exc)
        return
    for c in candidates:
        row = (body.get("counts") or {}).get(c.id) or {}
        if "count" in row and not row.get("error"):
            c.count = int(row["count"])


def clarification(concept: str, candidates: list[Candidate], *, applies_label: str,
                  data_source_id: Optional[str] = None) -> dict:
    options = [c.option() for c in candidates]
    live = [c for c in candidates if c.count]
    if len(live) >= 2:
        options.append({
            "id": "opt_any", "label": "Any of these",
            "description": f"{applies_label} matching any reading above", "count": None,
        })
    no_exact = not any(c.exact for c in candidates)
    question = (
        f"There's nothing called “{concept}” in this data source. Which of these means {concept} here?"
        if no_exact else f"“{concept}” could mean more than one thing here. Which do you mean?"
    )
    return {"id": clarification_id(concept, data_source_id), "question": question,
            "concept": concept, "options": options,
            "allowRemember": True, "allowOther": True}

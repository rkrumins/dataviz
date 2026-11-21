"""What a conversation remembers between turns (``ai_conversations.state``).

* **Result references** — every result set an answer produced, stored as the
  predicate (or trace) that produced it, never as a list of URNs. "Those" in a
  follow-up is ``{"kind":"resultSet","ref":"r2"}``, which composes with any
  new condition and stays correct however many entities it means.
* **A pending clarification** — the options the person was offered, each with
  the predicate it stands for, and the question that needed it, so their
  choice can finish the original question.
* **Confirmed concepts** — "PII means tag pii" for this conversation, whether
  or not the person chose to remember it for the data source.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional

MAX_RESULT_REFS = 20


@dataclass
class ResultRef:
    id: str
    label: str
    predicate: dict
    workspace_id: Optional[str]
    data_source_id: Optional[str]
    view_id: Optional[str]
    scope_mode: str = "view"
    total: Optional[int] = None

    def to_json(self) -> dict:
        return {
            "id": self.id, "label": self.label, "predicate": self.predicate,
            "workspaceId": self.workspace_id, "dataSourceId": self.data_source_id,
            "viewId": self.view_id, "scopeMode": self.scope_mode, "total": self.total,
        }

    @classmethod
    def from_json(cls, raw: dict) -> "ResultRef":
        return cls(
            id=str(raw.get("id")), label=str(raw.get("label") or ""),
            predicate=raw.get("predicate") or {"kind": "all"},
            workspace_id=raw.get("workspaceId"), data_source_id=raw.get("dataSourceId"),
            view_id=raw.get("viewId"), scope_mode=raw.get("scopeMode") or "view",
            total=raw.get("total"),
        )


@dataclass
class ConversationState:
    results: list[ResultRef] = field(default_factory=list)
    pending: Optional[dict] = None
    concepts: dict[str, dict] = field(default_factory=dict)  # "pii@ds" -> {label, predicate}
    next_ref: int = 1

    # ── result references ──────────────────────────────────────────

    def add_result(self, *, label: str, predicate: dict, workspace_id: Optional[str],
                   data_source_id: Optional[str], view_id: Optional[str],
                   scope_mode: str = "view", total: Optional[int] = None) -> ResultRef:
        ref = ResultRef(
            id=f"r{self.next_ref}", label=label[:160], predicate=predicate,
            workspace_id=workspace_id, data_source_id=data_source_id, view_id=view_id,
            scope_mode=scope_mode, total=total,
        )
        self.next_ref += 1
        self.results.append(ref)
        self.results = self.results[-MAX_RESULT_REFS:]
        return ref

    def result(self, ref_id: str) -> Optional[ResultRef]:
        ref_id = (ref_id or "").lstrip("@")
        return next((r for r in self.results if r.id == ref_id), None)

    def describe_results(self) -> list[str]:
        return [
            f"{r.id}: {r.label}" + (f" ({r.total} entities)" if r.total is not None else "")
            for r in self.results[-8:]
        ]

    # ── concepts ───────────────────────────────────────────────────

    @staticmethod
    def concept_key(name: str, data_source_id: Optional[str]) -> str:
        return f"{name.strip().lower()}@{data_source_id or ''}"

    def confirm_concept(self, name: str, data_source_id: Optional[str], *, label: str,
                        predicate: dict) -> None:
        self.concepts[self.concept_key(name, data_source_id)] = {
            "label": label, "predicate": predicate,
        }

    def confirmed(self, name: str, data_source_id: Optional[str]) -> Optional[dict]:
        return self.concepts.get(self.concept_key(name, data_source_id))

    # ── storage ────────────────────────────────────────────────────

    def dumps(self) -> str:
        return json.dumps({
            "results": [r.to_json() for r in self.results],
            "pending": self.pending,
            "concepts": self.concepts,
            "nextRef": self.next_ref,
        })

    @classmethod
    def loads(cls, raw: Optional[str]) -> "ConversationState":
        try:
            data = json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        return cls(
            results=[ResultRef.from_json(r) for r in data.get("results") or [] if isinstance(r, dict)],
            pending=data.get("pending") if isinstance(data.get("pending"), dict) else None,
            concepts=data.get("concepts") if isinstance(data.get("concepts"), dict) else {},
            next_ref=int(data.get("nextRef") or 1),
        )

"""What a turn tells the person as it happens: the event stream (contract v1).

A turn writes events to a :class:`Turn`; the chat route reads them as
server-sent events. The same object keeps what the stored answer needs —
the text, blocks, steps, follow-ups — so what was streamed and what is saved
cannot differ.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

CONTRACT_VERSION = 1


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def sse(event: str, data: Any) -> bytes:
    payload = json.dumps(data, separators=(",", ":"), default=str)
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")


KEEPALIVE = b": keep-alive\n\n"


@dataclass
class Turn:
    """One answer being made."""

    conversation_id: str
    message_id: str
    persona: str
    queue: "asyncio.Queue[Optional[bytes]]" = field(default_factory=asyncio.Queue)
    text: list[str] = field(default_factory=list)
    blocks: list[dict] = field(default_factory=list)
    steps: dict[str, dict] = field(default_factory=dict)
    actions: list[dict] = field(default_factory=list)
    followups: list[str] = field(default_factory=list)
    status: str = "ok"
    closed: bool = False

    def _emit(self, event: str, data: Any) -> None:
        if not self.closed:
            self.queue.put_nowait(sse(event, data))

    def meta(self, **extra: Any) -> None:
        self._emit("meta", {
            "conversationId": self.conversation_id, "messageId": self.message_id,
            "persona": self.persona, "contractVersion": CONTRACT_VERSION, **extra,
        })

    def step(self, label: str, *, status: str = "running", detail: Optional[str] = None,
             step_id: Optional[str] = None) -> str:
        sid = step_id or new_id("step")
        record = {"id": sid, "label": label, "status": status}
        if detail:
            record["detail"] = detail
        self.steps[sid] = record
        self._emit("step", record)
        return sid

    def finish_step(self, step_id: str, *, status: str = "done", detail: Optional[str] = None,
                    label: Optional[str] = None) -> None:
        record = dict(self.steps.get(step_id) or {"id": step_id, "label": label or ""})
        record["status"] = status
        if label:
            record["label"] = label
        if detail:
            record["detail"] = detail
        self.steps[step_id] = record
        self._emit("step", record)

    def say(self, delta: str) -> None:
        if delta:
            self.text.append(delta)
            self._emit("text", {"delta": delta})

    def block(self, kind: str, data: dict) -> str:
        bid = new_id("blk")
        record = {"id": bid, "type": kind, "data": data}
        self.blocks.append(record)
        self._emit("block", record)
        return bid

    def notice(self, text: str, *, tone: str = "info") -> None:
        self.block("notice", {"tone": tone, "text": text})

    def clarify(self, payload: dict) -> None:
        self.status = "clarify"
        self.blocks.append({"id": payload["id"], "type": "clarify", "data": {**payload, "answered": False}})
        self._emit("clarify", payload)

    def add_actions(self, actions: list[dict]) -> None:
        fresh = [a for a in actions if a]
        if fresh:
            self.actions.extend(fresh)
            self._emit("actions", fresh)

    def add_followups(self, followups: list[str]) -> None:
        for question in followups:
            question = (question or "").strip()
            if question and question not in self.followups and len(self.followups) < 4:
                self.followups.append(question)

    def usage(self, input_tokens: int, output_tokens: int, model: str) -> None:
        self._emit("usage", {"inputTokens": input_tokens, "outputTokens": output_tokens,
                             "model": model})

    def error(self, code: str, message: str) -> None:
        self.status = "error"
        self._emit("error", {"code": code, "message": message})

    def close(self) -> None:
        if self.closed:
            return
        if self.followups:
            self._emit("followups", self.followups)
        self._emit("done", {"status": self.status})
        self.closed = True
        self.queue.put_nowait(None)

    @property
    def content(self) -> str:
        return "".join(self.text)

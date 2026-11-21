"""The vocabulary between the agent and a model, whatever serves it."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Union

Role = Literal["system", "user", "assistant", "tool"]
ModelRole = Literal["chat", "fast", "embedding"]


@dataclass(frozen=True)
class ToolSpec:
    """A tool the model may call: a name, what it is for, and a JSON Schema
    for its arguments."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    #: What the model sent, before parsing — for repair prompts and logs.
    raw_arguments: str = ""
    #: Set when the arguments were not valid JSON.
    parse_error: Optional[str] = None


@dataclass
class ChatMessage:
    role: Role
    content: Optional[str] = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: Optional[str] = None
    name: Optional[str] = None


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            self.input_tokens + other.input_tokens,
            self.output_tokens + other.output_tokens,
        )


@dataclass
class CompletionRequest:
    messages: list[ChatMessage]
    tools: list[ToolSpec] = field(default_factory=list)
    #: ``auto`` lets the model choose, ``none`` forbids tools.
    tool_choice: Literal["auto", "none"] = "auto"
    temperature: Optional[float] = 0.1
    max_tokens: Optional[int] = None
    #: Ask for a JSON object as the answer (where the endpoint supports it).
    json_mode: bool = False
    role: ModelRole = "chat"


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ToolCallsReady:
    calls: tuple[ToolCall, ...]


@dataclass(frozen=True)
class UsageReport:
    usage: Usage
    model: str = ""


@dataclass(frozen=True)
class Finished:
    reason: str = "stop"


StreamEvent = Union[TextDelta, ToolCallsReady, UsageReport, Finished]


@dataclass
class CompletionResult:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    finish_reason: str = "stop"
    model: str = ""


@dataclass(frozen=True)
class Capabilities:
    streaming: bool = True
    tools: bool = True
    json_mode: bool = True
    embeddings: bool = False
    embedding_dimensions: Optional[int] = None


class LlmError(Exception):
    """A model call that did not produce an answer.

    ``code`` is stable and safe to show: ``auth`` (the endpoint refused the
    credentials), ``rate_limited``, ``timeout``, ``unavailable`` (5xx, or not
    reachable), ``refused_destination`` (the network guard said no),
    ``bad_request`` (the endpoint rejected what was sent), ``protocol`` (an
    answer this adapter cannot read), ``not_configured``. The message never
    holds a credential or a response body.
    """

    def __init__(
        self, code: str, message: str, *, status: Optional[int] = None,
        retry_after: Optional[float] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.code in ("rate_limited", "timeout", "unavailable")

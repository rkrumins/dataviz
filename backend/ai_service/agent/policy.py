"""What may leave the platform for a model (Administration → AI → Data sharing).

Applied to everything this service sends to a model — the grounding card and
every tool result — and to nothing the person sees: their own answer cards
carry the full data, because they could read it anyway.

* names, types and structure always go: an answer about a dataset needs it;
* ``sendDescriptions`` off — descriptions are dropped;
* ``sendPropertyValues`` off — property *values* are dropped, keys kept, so
  the model can still say "filter on ``owner``" without seeing who owns what;
* ``sendSampleValues`` off — the catalogue's most common values are dropped;
* ``maxResultRows`` — no list sent to the model is longer;
* ``redactPatterns`` — matches are replaced by ``[redacted]`` in every string.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

REDACTED = "[redacted]"

_DESCRIPTION_KEYS = frozenset({"description"})
_PROPERTY_BAGS = frozenset({"properties"})
_SAMPLE_KEYS = frozenset({"values", "topValues", "sampleValues", "valueSamples"})


@dataclass(frozen=True)
class DataPolicy:
    send_descriptions: bool = True
    send_property_values: bool = True
    send_sample_values: bool = True
    max_result_rows: int = 25
    redact_patterns: tuple[re.Pattern, ...] = ()

    @classmethod
    def from_settings(cls, policy: Mapping[str, Any]) -> "DataPolicy":
        patterns = []
        for raw in policy.get("redactPatterns") or []:
            try:
                patterns.append(re.compile(str(raw)))
            except re.error:
                continue
        return cls(
            send_descriptions=bool(policy.get("sendDescriptions", True)),
            send_property_values=bool(policy.get("sendPropertyValues", True)),
            send_sample_values=bool(policy.get("sendSampleValues", True)),
            max_result_rows=max(1, int(policy.get("maxResultRows") or 25)),
            redact_patterns=tuple(patterns),
        )

    def redact(self, text: str) -> str:
        for pattern in self.redact_patterns:
            text = pattern.sub(REDACTED, text)
        return text

    def apply(self, value: Any, *, _key: str = "") -> Any:
        """*value* as it may be sent to a model."""
        if isinstance(value, Mapping):
            out = {}
            for key, item in value.items():
                if key in _DESCRIPTION_KEYS and not self.send_descriptions:
                    continue
                if key in _SAMPLE_KEYS and not self.send_sample_values:
                    continue
                if key in _PROPERTY_BAGS and isinstance(item, Mapping) and not self.send_property_values:
                    out[key] = sorted(str(k) for k in item.keys())
                    continue
                out[key] = self.apply(item, _key=str(key))
            return out
        if isinstance(value, (list, tuple)):
            items = list(value)
            clipped = items[: self.max_result_rows]
            out_list = [self.apply(v, _key=_key) for v in clipped]
            if len(items) > len(clipped):
                out_list.append(f"… {len(items) - len(clipped)} more not shown")
            return out_list
        if isinstance(value, str):
            return self.redact(value)
        return value

    def to_model_text(self, value: Any, *, limit: int = 12_000) -> str:
        """Compact JSON for a model, policy applied, bounded in size."""
        text = json.dumps(self.apply(value), separators=(",", ":"), default=str, ensure_ascii=False)
        if len(text) > limit:
            text = text[:limit] + "…(truncated)"
        return text

"""
Feature flags: validation only. No hardcoded registry.
Schema and categories come from the database (feature_definitions, feature_categories).
"""

from typing import Any


class ValidationError(Exception):
    """Structured validation error for feature flags."""
    def __init__(self, message: str, code: str = "VALIDATION", field: str | None = None):
        self.message = message
        self.code = code
        self.field = field
        super().__init__(message)


def validate_and_merge_values(
    definitions: list[dict[str, Any]], payload: dict[str, Any]
) -> dict[str, Any]:
    """
    Validate payload against definitions (from DB) and merge with defaults.
    definitions: list of API-shaped feature definition dicts (key, type, default, options, etc.).
    Returns full values dict. Raises ValidationError on invalid input.
    """
    defaults = {d["key"]: d["default"] for d in definitions}
    result = dict(defaults)
    defs_by_key = {d["key"]: d for d in definitions}

    for key, value in payload.items():
        if key not in defs_by_key:
            raise ValidationError(f"Unknown feature key: {key}", field=key)
        defn = defs_by_key[key]
        ftype = defn.get("type")
        if ftype == "string[]":
            if not isinstance(value, list):
                raise ValidationError(f"{key} must be a list", field=key)
            options = defn.get("options") or []
            allowed = {opt["id"] for opt in options}
            invalid = set(value) - allowed
            if invalid:
                raise ValidationError(f"Invalid options for {key}: {invalid}", field=key)
            if len(value) < 1:
                raise ValidationError("At least one option must be selected", field=key)
            result[key] = list(value)
        elif ftype == "boolean":
            if not isinstance(value, bool):
                raise ValidationError(f"{key} must be a boolean", field=key)
            result[key] = value
        else:
            result[key] = value
    return result
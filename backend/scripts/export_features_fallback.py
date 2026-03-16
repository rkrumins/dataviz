"""
Export feature categories and definitions in API shape for frontend fallback.
Single source of truth: seed data in backend/app/db/seed_feature_registry.py.
Run from repo root: python backend/scripts/export_features_fallback.py
Output: JSON to stdout (redirect to frontend/src/generated/featuresFallback.json).
"""
import json
import sys
from pathlib import Path

# Add backend to path so we can import from app
repo_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(repo_root))

from backend.app.db.seed_feature_registry import SEED_CATEGORIES, SEED_DEFINITIONS


def main() -> None:
    categories = [
        {
            "id": c["id"],
            "label": c["label"],
            "icon": c["icon"],
            "color": c["color"],
            "sortOrder": c["sort_order"],
        }
        for c in SEED_CATEGORIES
    ]
    schema = []
    defaults = {}
    for d in SEED_DEFINITIONS:
        default_val = json.loads(d["default_value"])
        defaults[d["key"]] = default_val
        options = json.loads(d["options"]) if d.get("options") else None
        schema.append({
            "key": d["key"],
            "name": d["name"],
            "description": d["description"],
            "category": d["category_id"],
            "type": d["type"],
            "default": default_val,
            "userOverridable": d["user_overridable"],
            "options": options,
            "helpUrl": d.get("help_url"),
            "adminHint": d.get("admin_hint"),
            "sortOrder": d["sort_order"],
            "deprecated": d["deprecated"],
        })
    out = {"schema": schema, "categories": categories, "defaults": defaults}
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()

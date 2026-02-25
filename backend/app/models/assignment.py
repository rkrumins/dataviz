# Re-export from common kernel — preserves all existing imports unchanged.
from backend.common.models.assignment import (
    RuleOperator,
    RuleCondition,
    LayerAssignmentRuleConfig,
    EntityAssignmentConfig,
    LogicalNodeConfig,
    ViewLayerConfig,
    ScopeFilterConfig,
    LayerAssignmentRequest,
    EntityAssignment,
    LayerAssignmentStats,
    LayerAssignmentResult,
)

__all__ = [
    "RuleOperator", "RuleCondition", "LayerAssignmentRuleConfig",
    "EntityAssignmentConfig", "LogicalNodeConfig", "ViewLayerConfig",
    "ScopeFilterConfig", "LayerAssignmentRequest",
    "EntityAssignment", "LayerAssignmentStats", "LayerAssignmentResult",
]

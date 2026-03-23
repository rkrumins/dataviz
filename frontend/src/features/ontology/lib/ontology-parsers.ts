import type { EntityTypeSchema } from '@/types/schema'
import type { RelTypeWithClassifications } from './ontology-types'

export function entityDefToSchema(id: string, def: Record<string, unknown>): EntityTypeSchema {
  const visual = (def.visual as Record<string, unknown>) ?? {}
  const hierarchy = (def.hierarchy as Record<string, unknown>) ?? {}
  const behavior = (def.behavior as Record<string, unknown>) ?? {}
  const fields = (def.fields as Array<Record<string, unknown>>) ?? []

  return {
    id,
    name: (def.name as string) ?? humanizeId(id),
    pluralName: (def.plural_name as string) ?? `${(def.name as string) ?? humanizeId(id)}s`,
    description: def.description as string | undefined,
    visual: {
      icon: (visual.icon as string) ?? 'Box',
      color: (visual.color as string) ?? '#6366f1',
      shape: ((visual.shape as string) ?? 'rounded') as EntityTypeSchema['visual']['shape'],
      size: ((visual.size as string) ?? 'md') as EntityTypeSchema['visual']['size'],
      borderStyle: ((visual.border_style as string) ?? 'solid') as EntityTypeSchema['visual']['borderStyle'],
      showInMinimap: (visual.show_in_minimap as boolean) ?? true,
    },
    fields: fields.map(f => ({
      id: f.id as string,
      name: f.name as string,
      type: ((f.type as string) ?? 'string') as EntityTypeSchema['fields'][number]['type'],
      required: (f.required as boolean) ?? false,
      showInNode: (f.show_in_node as boolean) ?? false,
      showInPanel: (f.show_in_panel as boolean) ?? true,
      showInTooltip: (f.show_in_tooltip as boolean) ?? false,
      displayOrder: (f.display_order as number) ?? 0,
    })),
    hierarchy: {
      level: (hierarchy.level as number) ?? 0,
      canContain: (hierarchy.can_contain as string[]) ?? [],
      canBeContainedBy: (hierarchy.can_be_contained_by as string[]) ?? [],
      defaultExpanded: (hierarchy.default_expanded as boolean) ?? false,
      rollUpFields: [],
    },
    behavior: {
      selectable: (behavior.selectable as boolean) ?? true,
      draggable: (behavior.draggable as boolean) ?? true,
      expandable: (behavior.expandable as boolean) ?? true,
      traceable: (behavior.traceable as boolean) ?? true,
      clickAction: ((behavior.click_action as string) ?? 'select') as EntityTypeSchema['behavior']['clickAction'],
      doubleClickAction: ((behavior.double_click_action as string) ?? 'expand') as EntityTypeSchema['behavior']['doubleClickAction'],
    },
  }
}

export function entitySchemaToBackend(et: EntityTypeSchema): Record<string, unknown> {
  return {
    name: et.name,
    plural_name: et.pluralName,
    description: et.description,
    visual: {
      icon: et.visual.icon,
      color: et.visual.color,
      shape: et.visual.shape,
      size: et.visual.size,
      border_style: et.visual.borderStyle,
      show_in_minimap: et.visual.showInMinimap,
    },
    hierarchy: {
      level: et.hierarchy.level,
      can_contain: et.hierarchy.canContain,
      can_be_contained_by: et.hierarchy.canBeContainedBy,
      default_expanded: et.hierarchy.defaultExpanded,
      roll_up_fields: et.hierarchy.rollUpFields ?? [],
    },
    behavior: {
      selectable: et.behavior.selectable,
      draggable: et.behavior.draggable,
      expandable: et.behavior.expandable,
      traceable: et.behavior.traceable,
      click_action: et.behavior.clickAction,
      double_click_action: et.behavior.doubleClickAction,
    },
    // FIX: Convert field properties from camelCase to snake_case
    fields: et.fields.map(f => ({
      id: f.id,
      name: f.name,
      type: f.type,
      required: f.required,
      show_in_node: f.showInNode,
      show_in_panel: f.showInPanel,
      show_in_tooltip: f.showInTooltip,
      display_order: f.displayOrder,
    })),
  }
}

export function relDefToSchema(id: string, def: Record<string, unknown>): RelTypeWithClassifications {
  const visual = (def.visual as Record<string, unknown>) ?? {}
  return {
    id,
    name: (def.name as string) ?? humanizeId(id),
    description: (def.description as string) ?? '',
    sourceTypes: (def.source_types as string[]) ?? [],
    targetTypes: (def.target_types as string[]) ?? [],
    visual: {
      strokeColor: (visual.stroke_color as string) ?? '#6366f1',
      strokeWidth: (visual.stroke_width as number) ?? 2,
      strokeStyle: ((visual.stroke_style as string) ?? 'solid') as 'solid' | 'dashed' | 'dotted',
      animated: (visual.animated as boolean) ?? false,
      animationSpeed: ((visual.animation_speed as string) ?? 'normal') as 'slow' | 'normal' | 'fast',
      arrowType: ((visual.arrow_type as string) ?? 'arrow') as 'arrow' | 'arrowclosed' | 'none',
      curveType: ((visual.curve_type as string) ?? 'bezier') as 'bezier' | 'step' | 'straight' | 'smoothstep',
    },
    bidirectional: (def.bidirectional as boolean) ?? false,
    showLabel: (def.show_label as boolean) ?? false,
    isContainment: (def.is_containment as boolean) ?? false,
    isLineage: (def.is_lineage as boolean) ?? false,
    category: (def.category as RelTypeWithClassifications['category']) ?? 'association',
    direction: (def.direction as RelTypeWithClassifications['direction']) ?? 'source-to-target',
  }
}

export function relSchemaToBackend(rt: RelTypeWithClassifications): Record<string, unknown> {
  return {
    name: rt.name,
    description: rt.description,
    is_containment: rt.isContainment ?? false,
    is_lineage: rt.isLineage ?? false,
    category: rt.category ?? 'association',
    direction: rt.direction ?? 'source-to-target',
    visual: {
      stroke_color: rt.visual.strokeColor,
      stroke_width: rt.visual.strokeWidth,
      stroke_style: rt.visual.strokeStyle,
      animated: rt.visual.animated,
      animation_speed: rt.visual.animationSpeed,
      arrow_type: rt.visual.arrowType,
      curve_type: rt.visual.curveType,
    },
    source_types: rt.sourceTypes,
    target_types: rt.targetTypes,
    bidirectional: rt.bidirectional,
    show_label: rt.showLabel,
  }
}

export function humanizeId(id: string): string {
  return id
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return iso }
}

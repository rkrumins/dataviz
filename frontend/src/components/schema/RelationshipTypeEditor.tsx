/**
 * RelationshipTypeEditor — Edit a single relationship type definition.
 *
 * Key features over the old hardcoded approach:
 * - isContainment / isLineage classification toggles
 * - Full visual configuration (stroke color, style, animation)
 * - Source/target type selectors
 */
import { useState } from 'react'
import * as LucideIcons from 'lucide-react'
import type { RelationshipTypeSchema, RelationshipVisualConfig } from '@/types/schema'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/utils'

const COLOR_PALETTE = [
  '#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#14b8a6',
  '#10b981', '#22c55e', '#84cc16', '#eab308', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#d946ef', '#a855f7',
  '#64748b', '#6b7280', '#94a3b8',
]

interface RelTypeWithClassifications extends RelationshipTypeSchema {
  isContainment?: boolean
  isLineage?: boolean
  category?: 'structural' | 'flow' | 'metadata' | 'association'
  direction?: 'source-to-target' | 'target-to-source' | 'bidirectional'
}

interface RelationshipTypeEditorProps {
  relType?: RelTypeWithClassifications
  availableEntityTypes?: { id: string; name: string }[]
  readOnly?: boolean
  onSave: (relType: RelTypeWithClassifications) => void
  onCancel: () => void
}

function createDefaultRelType(): RelTypeWithClassifications {
  return {
    id: generateId('rel'),
    name: '',
    description: '',
    sourceTypes: [],
    targetTypes: [],
    visual: {
      strokeColor: '#6366f1',
      strokeWidth: 2,
      strokeStyle: 'solid',
      animated: true,
      animationSpeed: 'normal',
      arrowType: 'arrow',
      curveType: 'bezier',
    },
    bidirectional: false,
    showLabel: false,
    isContainment: false,
    isLineage: false,
    category: 'association',
    direction: 'source-to-target',
  }
}

export function RelationshipTypeEditor({
  relType,
  availableEntityTypes = [],
  readOnly,
  onSave,
  onCancel,
}: RelationshipTypeEditorProps) {
  const isNew = !relType
  const [form, setForm] = useState<RelTypeWithClassifications>(
    relType ?? createDefaultRelType()
  )
  const [activeTab, setActiveTab] = useState<'basic' | 'visual' | 'connections'>('basic')

  const updateVisual = <K extends keyof RelationshipVisualConfig>(
    key: K,
    value: RelationshipVisualConfig[K]
  ) => {
    setForm((prev) => ({ ...prev, visual: { ...prev.visual, [key]: value } }))
  }

  const preview = (
    <svg viewBox="0 0 120 30" className="w-full h-8 overflow-visible">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={form.visual.strokeColor} />
        </marker>
      </defs>
      <line
        x1="10" y1="15" x2="100" y2="15"
        stroke={form.visual.strokeColor}
        strokeWidth={form.visual.strokeWidth}
        strokeDasharray={
          form.visual.strokeStyle === 'dashed' ? '8,4' :
          form.visual.strokeStyle === 'dotted' ? '2,4' : undefined
        }
        markerEnd={form.visual.arrowType !== 'none' ? 'url(#arrow)' : undefined}
      />
      {form.bidirectional && (
        <line
          x1="100" y1="15" x2="10" y2="15"
          stroke={form.visual.strokeColor}
          strokeWidth={form.visual.strokeWidth}
          strokeDasharray={
            form.visual.strokeStyle === 'dashed' ? '8,4' :
            form.visual.strokeStyle === 'dotted' ? '2,4' : undefined
          }
          markerEnd={form.visual.arrowType !== 'none' ? 'url(#arrow)' : undefined}
        />
      )}
      {form.showLabel && (
        <text x="55" y="12" textAnchor="middle" fontSize="8" fill={form.visual.strokeColor}>
          {form.name || 'label'}
        </text>
      )}
    </svg>
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-glass-border">
        <div>
          <h2 className="text-lg font-display font-semibold">
            {isNew ? 'Create Relationship Type' : 'Edit Relationship Type'}
          </h2>
          <p className="text-sm text-ink-muted">
            Define how this edge type appears and is classified
          </p>
        </div>
        <button onClick={onCancel} className="btn btn-ghost p-2">
          <LucideIcons.X className="w-5 h-5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-2 border-b border-glass-border">
        {(['basic', 'visual', 'connections'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize",
              activeTab === tab
                ? "bg-accent-lineage/10 text-accent-lineage"
                : "text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <fieldset disabled={readOnly} className={cn('flex-1 overflow-y-auto p-4 space-y-4', readOnly && 'opacity-75')}>
        {activeTab === 'basic' && (
          <>
            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-1">Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Flows To"
                className="input w-full"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-1">Description</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                rows={2}
                placeholder="What does this relationship represent?"
                className="input w-full resize-none"
              />
            </div>

            {/* Classifications — the core feature replacing hardcoded edge classification */}
            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-2">
                Classification
              </label>
              <div className="space-y-2">
                <label className={cn(
                  "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                  form.isContainment
                    ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30"
                    : "border-glass-border hover:bg-black/5 dark:hover:bg-white/5"
                )}>
                  <input
                    type="checkbox"
                    checked={form.isContainment ?? false}
                    onChange={(e) => setForm((p) => ({ ...p, isContainment: e.target.checked }))}
                    className="rounded"
                  />
                  <div>
                    <div className="text-sm font-medium">Containment</div>
                    <div className="text-xs text-ink-muted">Parent–child structural relationship (used for graph hierarchy)</div>
                  </div>
                </label>

                <label className={cn(
                  "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                  form.isLineage
                    ? "border-green-500 bg-green-50 dark:bg-green-950/30"
                    : "border-glass-border hover:bg-black/5 dark:hover:bg-white/5"
                )}>
                  <input
                    type="checkbox"
                    checked={form.isLineage ?? false}
                    onChange={(e) => setForm((p) => ({ ...p, isLineage: e.target.checked }))}
                    className="rounded"
                  />
                  <div>
                    <div className="text-sm font-medium">Lineage</div>
                    <div className="text-xs text-ink-muted">Data flow edge (shown in lineage traces)</div>
                  </div>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-ink-secondary mb-1">Category</label>
                <select
                  value={form.category ?? 'association'}
                  onChange={(e) => setForm((p) => ({ ...p, category: e.target.value as any }))}
                  className="input w-full"
                >
                  <option value="structural">Structural</option>
                  <option value="flow">Flow</option>
                  <option value="metadata">Metadata</option>
                  <option value="association">Association</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-secondary mb-1">Direction</label>
                <select
                  value={form.direction ?? 'source-to-target'}
                  onChange={(e) => setForm((p) => ({ ...p, direction: e.target.value as any }))}
                  className="input w-full"
                >
                  <option value="source-to-target">Source → Target</option>
                  <option value="target-to-source">Target → Source</option>
                  <option value="bidirectional">Bidirectional</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg border border-glass-border">
              <div>
                <div className="text-sm font-medium">Show Label</div>
                <div className="text-xs text-ink-muted">Display relationship name on edge</div>
              </div>
              <input
                type="checkbox"
                checked={form.showLabel}
                onChange={(e) => setForm((p) => ({ ...p, showLabel: e.target.checked }))}
                className="rounded"
              />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg border border-glass-border">
              <div>
                <div className="text-sm font-medium">Bidirectional</div>
                <div className="text-xs text-ink-muted">Edges in both directions are equivalent</div>
              </div>
              <input
                type="checkbox"
                checked={form.bidirectional}
                onChange={(e) => setForm((p) => ({ ...p, bidirectional: e.target.checked }))}
                className="rounded"
              />
            </div>
          </>
        )}

        {activeTab === 'visual' && (
          <>
            {/* Edge Preview */}
            <div className="p-4 rounded-xl border border-glass-border bg-canvas-elevated/50">
              <label className="block text-sm font-medium text-ink-secondary mb-3">Preview</label>
              {preview}
            </div>

            {/* Color */}
            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-2">Stroke Color</label>
              <div className="flex flex-wrap gap-2">
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => updateVisual('strokeColor', c)}
                    className={cn(
                      "w-7 h-7 rounded-full border-2 transition-transform hover:scale-110",
                      form.visual.strokeColor === c ? "border-ink scale-110" : "border-glass-border"
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <input
                type="color"
                value={form.visual.strokeColor}
                onChange={(e) => updateVisual('strokeColor', e.target.value)}
                className="mt-2 w-full h-8 rounded cursor-pointer"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-ink-secondary mb-1">Stroke Width</label>
                <input
                  type="number" min={1} max={8}
                  value={form.visual.strokeWidth}
                  onChange={(e) => updateVisual('strokeWidth', Number(e.target.value))}
                  className="input w-full"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-secondary mb-1">Stroke Style</label>
                <select
                  value={form.visual.strokeStyle}
                  onChange={(e) => updateVisual('strokeStyle', e.target.value as any)}
                  className="input w-full"
                >
                  <option value="solid">Solid</option>
                  <option value="dashed">Dashed</option>
                  <option value="dotted">Dotted</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-secondary mb-1">Arrow</label>
                <select
                  value={form.visual.arrowType}
                  onChange={(e) => updateVisual('arrowType', e.target.value as any)}
                  className="input w-full"
                >
                  <option value="arrow">Arrow</option>
                  <option value="arrowclosed">Filled Arrow</option>
                  <option value="none">None</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg border border-glass-border">
              <div>
                <div className="text-sm font-medium">Animated</div>
                <div className="text-xs text-ink-muted">Moving dash animation on edge</div>
              </div>
              <input
                type="checkbox"
                checked={form.visual.animated}
                onChange={(e) => updateVisual('animated', e.target.checked)}
                className="rounded"
              />
            </div>

            {form.visual.animated && (
              <div>
                <label className="block text-sm font-medium text-ink-secondary mb-1">Animation Speed</label>
                <select
                  value={form.visual.animationSpeed}
                  onChange={(e) => updateVisual('animationSpeed', e.target.value as any)}
                  className="input w-full"
                >
                  <option value="slow">Slow</option>
                  <option value="normal">Normal</option>
                  <option value="fast">Fast</option>
                </select>
              </div>
            )}
          </>
        )}

        {activeTab === 'connections' && (
          <>
            <p className="text-sm text-ink-muted">
              Specify which entity types this relationship can connect.
              Leave empty to allow any type.
            </p>

            {availableEntityTypes.length === 0 && (
              <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-700 dark:text-amber-300">
                Load a workspace to see available entity types.
              </div>
            )}

            {availableEntityTypes.length > 0 && (
              <>
                <div>
                  <label className="block text-sm font-medium text-ink-secondary mb-2">Source Types</label>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {availableEntityTypes.map((et) => (
                      <label key={et.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.sourceTypes.includes(et.id)}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...form.sourceTypes, et.id]
                              : form.sourceTypes.filter((t) => t !== et.id)
                            setForm((p) => ({ ...p, sourceTypes: next }))
                          }}
                          className="rounded"
                        />
                        <span className="text-sm">{et.name}</span>
                        <code className="text-xs text-ink-muted font-mono ml-auto">{et.id}</code>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-ink-secondary mb-2">Target Types</label>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {availableEntityTypes.map((et) => (
                      <label key={et.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.targetTypes.includes(et.id)}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...form.targetTypes, et.id]
                              : form.targetTypes.filter((t) => t !== et.id)
                            setForm((p) => ({ ...p, targetTypes: next }))
                          }}
                          className="rounded"
                        />
                        <span className="text-sm">{et.name}</span>
                        <code className="text-xs text-ink-muted font-mono ml-auto">{et.id}</code>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </fieldset>

      {/* Footer */}
      <div className="p-4 border-t border-glass-border flex items-center justify-end gap-2">
        <button onClick={onCancel} className="btn btn-ghost">{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && (
          <button
            onClick={() => onSave(form)}
            disabled={!form.name.trim()}
            className="btn btn-primary"
          >
            {isNew ? 'Create' : 'Stage Changes'}
          </button>
        )}
      </div>
    </div>
  )
}

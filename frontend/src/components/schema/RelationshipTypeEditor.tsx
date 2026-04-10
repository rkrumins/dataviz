/**
 * RelationshipTypeEditor — Edit a single relationship type definition.
 *
 * Key features:
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

const TAB_DEFS = [
  { id: 'basic' as const, label: 'Identity', icon: LucideIcons.FileText },
  { id: 'visual' as const, label: 'Appearance', icon: LucideIcons.Palette },
  { id: 'connections' as const, label: 'Connections', icon: LucideIcons.Plug },
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

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <h3 className="text-xs font-bold text-ink-muted uppercase tracking-wider mb-1">{title}</h3>
      {description && <p className="text-[10px] text-ink-muted/70 mb-3">{description}</p>}
      {!description && <div className="mb-3" />}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main editor
// ---------------------------------------------------------------------------

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

  const canSave = form.name.trim()

  // Edge preview SVG
  const preview = (
    <svg viewBox="0 0 200 40" className="w-full h-10 overflow-visible">
      <defs>
        <marker id="rel-arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={form.visual.strokeColor} />
        </marker>
      </defs>
      {/* Source node */}
      <rect x="4" y="12" width="40" height="16" rx="4" fill={`${form.visual.strokeColor}15`} stroke={form.visual.strokeColor} strokeWidth="1" />
      <text x="24" y="23" textAnchor="middle" fontSize="7" fill={form.visual.strokeColor} fontWeight="600">SRC</text>
      {/* Edge */}
      <line
        x1="48" y1="20" x2="148" y2="20"
        stroke={form.visual.strokeColor}
        strokeWidth={form.visual.strokeWidth}
        strokeDasharray={
          form.visual.strokeStyle === 'dashed' ? '8,4' :
          form.visual.strokeStyle === 'dotted' ? '2,4' : undefined
        }
        markerEnd={form.visual.arrowType !== 'none' ? 'url(#rel-arrow)' : undefined}
      />
      {form.showLabel && (
        <text x="98" y="15" textAnchor="middle" fontSize="7" fill={form.visual.strokeColor} fontWeight="500">
          {form.name || 'label'}
        </text>
      )}
      {/* Target node */}
      <rect x="152" y="12" width="40" height="16" rx="4" fill={`${form.visual.strokeColor}15`} stroke={form.visual.strokeColor} strokeWidth="1" />
      <text x="172" y="23" textAnchor="middle" fontSize="7" fill={form.visual.strokeColor} fontWeight="600">TGT</text>
    </svg>
  )

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tabs — underline style matching page tabs */}
      <div className="flex items-center border-b border-glass-border px-4 shrink-0">
        {TAB_DEFS.map(t => {
          const Icon = t.icon
          const isActive = activeTab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-3 text-xs font-semibold transition-all border-b-2',
                isActive
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Read-only banner for immutable ontologies */}
      {readOnly && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
          <LucideIcons.Lock className="w-3.5 h-3.5 flex-shrink-0" />
          <span>This schema is locked. <strong>Clone</strong> it to make edits.</span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <fieldset disabled={readOnly} className={cn(readOnly && 'opacity-75')}>
          <div className="p-5">
            {activeTab === 'basic' && (
              <div className="space-y-5">
                <Section title="Identification">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold text-ink mb-1.5">
                        Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={form.name}
                        onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                        placeholder="e.g., Flows To, Contains, Depends On"
                        className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/20 transition-all"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-ink mb-1.5">Description</label>
                      <textarea
                        value={form.description}
                        onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                        rows={2}
                        placeholder="What does this relationship represent?"
                        className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/20 transition-all resize-none"
                      />
                    </div>
                  </div>
                </Section>

                <Section title="Classification" description="How this edge type is used in the graph">
                  <div className="space-y-2">
                    <label className={cn(
                      'flex items-center gap-3 px-3.5 py-3 rounded-xl border cursor-pointer transition-all',
                      form.isContainment
                        ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 shadow-sm'
                        : 'border-glass-border hover:border-glass-border-hover hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                    )}>
                      <LucideIcons.FolderTree className={cn('w-4 h-4 flex-shrink-0', form.isContainment ? 'text-indigo-500' : 'text-ink-muted/50')} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-ink">Containment</span>
                        <p className="text-[10px] text-ink-muted">Parent-child structural relationship (used for graph hierarchy)</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={form.isContainment ?? false}
                        onChange={(e) => setForm((p) => ({ ...p, isContainment: e.target.checked }))}
                        className="w-4 h-4 rounded accent-indigo-500"
                      />
                    </label>

                    <label className={cn(
                      'flex items-center gap-3 px-3.5 py-3 rounded-xl border cursor-pointer transition-all',
                      form.isLineage
                        ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/30 shadow-sm'
                        : 'border-glass-border hover:border-glass-border-hover hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                    )}>
                      <LucideIcons.Route className={cn('w-4 h-4 flex-shrink-0', form.isLineage ? 'text-green-500' : 'text-ink-muted/50')} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-ink">Lineage</span>
                        <p className="text-[10px] text-ink-muted">Data flow edge (shown in lineage traces)</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={form.isLineage ?? false}
                        onChange={(e) => setForm((p) => ({ ...p, isLineage: e.target.checked }))}
                        className="w-4 h-4 rounded accent-green-500"
                      />
                    </label>
                  </div>
                </Section>

                <Section title="Properties">
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="block text-xs font-semibold text-ink mb-1.5">Category</label>
                      <select
                        value={form.category ?? 'association'}
                        onChange={(e) => setForm((p) => ({ ...p, category: e.target.value as any }))}
                        className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink focus:outline-none focus:ring-1 focus:ring-indigo-500/30 cursor-pointer"
                      >
                        <option value="structural">Structural</option>
                        <option value="flow">Flow</option>
                        <option value="metadata">Metadata</option>
                        <option value="association">Association</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-ink mb-1.5">Direction</label>
                      <select
                        value={form.direction ?? 'source-to-target'}
                        onChange={(e) => setForm((p) => ({ ...p, direction: e.target.value as any }))}
                        className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink focus:outline-none focus:ring-1 focus:ring-indigo-500/30 cursor-pointer"
                      >
                        <option value="source-to-target">Source &rarr; Target</option>
                        <option value="target-to-source">Target &rarr; Source</option>
                        <option value="bidirectional">Bidirectional</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {([
                      { key: 'showLabel' as const, label: 'Show Label', desc: 'Display relationship name on edge', icon: LucideIcons.Tag },
                      { key: 'bidirectional' as const, label: 'Bidirectional', desc: 'Edges in both directions are equivalent', icon: LucideIcons.ArrowLeftRight },
                    ]).map(({ key, label, desc, icon: Icon }) => (
                      <label
                        key={key}
                        className={cn(
                          'flex items-center gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all',
                          form[key]
                            ? 'border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-950/20'
                            : 'border-glass-border hover:border-glass-border-hover hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                        )}
                      >
                        <Icon className={cn('w-4 h-4 flex-shrink-0', form[key] ? 'text-indigo-500' : 'text-ink-muted/50')} />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-ink">{label}</span>
                          <p className="text-[10px] text-ink-muted">{desc}</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={form[key]}
                          onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.checked }))}
                          className="w-4 h-4 rounded accent-indigo-500"
                        />
                      </label>
                    ))}
                  </div>
                </Section>
              </div>
            )}

            {activeTab === 'visual' && (
              <div className="space-y-5">
                {/* Live Preview */}
                <div className="p-5 rounded-2xl bg-gradient-to-br from-black/[0.02] to-black/[0.04] dark:from-white/[0.02] dark:to-white/[0.04] border border-glass-border">
                  <p className="text-[10px] text-ink-muted uppercase tracking-widest font-bold mb-3">Live Preview</p>
                  {preview}
                </div>

                <Section title="Stroke Color">
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {COLOR_PALETTE.map((c) => (
                      <button
                        key={c}
                        onClick={() => updateVisual('strokeColor', c)}
                        className={cn(
                          'w-7 h-7 rounded-lg transition-all',
                          form.visual.strokeColor === c
                            ? 'ring-2 ring-offset-2 ring-offset-canvas ring-ink scale-110 shadow-md'
                            : 'hover:scale-110',
                        )}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <input
                    type="color"
                    value={form.visual.strokeColor}
                    onChange={(e) => updateVisual('strokeColor', e.target.value)}
                    className="w-full h-7 rounded-lg cursor-pointer border border-glass-border"
                  />
                </Section>

                <div className="grid grid-cols-3 gap-3">
                  <Section title="Width">
                    <input
                      type="number" min={1} max={8}
                      value={form.visual.strokeWidth}
                      onChange={(e) => updateVisual('strokeWidth', Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                    />
                  </Section>

                  <Section title="Style">
                    <select
                      value={form.visual.strokeStyle}
                      onChange={(e) => updateVisual('strokeStyle', e.target.value as any)}
                      className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink focus:outline-none focus:ring-1 focus:ring-indigo-500/30 cursor-pointer"
                    >
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                      <option value="dotted">Dotted</option>
                    </select>
                  </Section>

                  <Section title="Arrow">
                    <select
                      value={form.visual.arrowType}
                      onChange={(e) => updateVisual('arrowType', e.target.value as any)}
                      className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink focus:outline-none focus:ring-1 focus:ring-indigo-500/30 cursor-pointer"
                    >
                      <option value="arrow">Arrow</option>
                      <option value="arrowclosed">Filled</option>
                      <option value="none">None</option>
                    </select>
                  </Section>
                </div>

                <Section title="Animation">
                  <div className="space-y-2">
                    <label className={cn(
                      'flex items-center gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all',
                      form.visual.animated
                        ? 'border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-950/20'
                        : 'border-glass-border hover:border-glass-border-hover hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                    )}>
                      <LucideIcons.Zap className={cn('w-4 h-4 flex-shrink-0', form.visual.animated ? 'text-indigo-500' : 'text-ink-muted/50')} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-ink">Animated</span>
                        <p className="text-[10px] text-ink-muted">Moving dash animation on edge</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={form.visual.animated}
                        onChange={(e) => updateVisual('animated', e.target.checked)}
                        className="w-4 h-4 rounded accent-indigo-500"
                      />
                    </label>

                    {form.visual.animated && (
                      <div>
                        <label className="block text-xs font-semibold text-ink mb-1.5">Speed</label>
                        <div className="flex gap-1.5">
                          {(['slow', 'normal', 'fast'] as const).map(speed => (
                            <button
                              key={speed}
                              onClick={() => updateVisual('animationSpeed', speed)}
                              className={cn(
                                'flex-1 px-3 py-2 rounded-xl text-xs font-medium border transition-all capitalize',
                                form.visual.animationSpeed === speed
                                  ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400'
                                  : 'border-glass-border text-ink-secondary hover:border-glass-border-hover',
                              )}
                            >
                              {speed}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Section>
              </div>
            )}

            {activeTab === 'connections' && (
              <div className="space-y-5">
                {availableEntityTypes.length === 0 ? (
                  <div className="p-5 rounded-xl bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/40 text-center">
                    <LucideIcons.AlertTriangle className="w-5 h-5 text-amber-500 mx-auto mb-2" />
                    <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">No entity types available</p>
                    <p className="text-[11px] text-amber-600/70 dark:text-amber-400/60 mt-0.5">Define entity types first to configure connections.</p>
                  </div>
                ) : (
                  <>
                    <Section title="Source Types" description="Which entity types can be the source of this relationship. Leave empty for any.">
                      <div className="flex flex-wrap gap-1.5">
                        {availableEntityTypes.map((et) => {
                          const selected = form.sourceTypes.includes(et.id)
                          return (
                            <button
                              key={et.id}
                              onClick={() => {
                                const next = selected
                                  ? form.sourceTypes.filter((t) => t !== et.id)
                                  : [...form.sourceTypes, et.id]
                                setForm((p) => ({ ...p, sourceTypes: next }))
                              }}
                              className={cn(
                                'px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all',
                                selected
                                  ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700 shadow-sm'
                                  : 'bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted border-glass-border hover:border-blue-300 hover:text-blue-600',
                              )}
                            >
                              {selected && <LucideIcons.Check className="w-2.5 h-2.5 inline mr-1" />}
                              {et.name}
                            </button>
                          )
                        })}
                      </div>
                      {form.sourceTypes.length === 0 && (
                        <p className="text-[10px] text-ink-muted/60 mt-1 italic">Any entity type can be a source</p>
                      )}
                    </Section>

                    <div className="flex items-center justify-center">
                      <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-black/[0.03] dark:bg-white/[0.03]">
                        <LucideIcons.ArrowDown className="w-3 h-3 text-ink-muted/40" />
                        <span className="text-[10px] text-ink-muted font-medium">connects to</span>
                        <LucideIcons.ArrowDown className="w-3 h-3 text-ink-muted/40" />
                      </div>
                    </div>

                    <Section title="Target Types" description="Which entity types can be the target. Leave empty for any.">
                      <div className="flex flex-wrap gap-1.5">
                        {availableEntityTypes.map((et) => {
                          const selected = form.targetTypes.includes(et.id)
                          return (
                            <button
                              key={et.id}
                              onClick={() => {
                                const next = selected
                                  ? form.targetTypes.filter((t) => t !== et.id)
                                  : [...form.targetTypes, et.id]
                                setForm((p) => ({ ...p, targetTypes: next }))
                              }}
                              className={cn(
                                'px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all',
                                selected
                                  ? 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 shadow-sm'
                                  : 'bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted border-glass-border hover:border-emerald-300 hover:text-emerald-600',
                              )}
                            >
                              {selected && <LucideIcons.Check className="w-2.5 h-2.5 inline mr-1" />}
                              {et.name}
                            </button>
                          )
                        })}
                      </div>
                      {form.targetTypes.length === 0 && (
                        <p className="text-[10px] text-ink-muted/60 mt-1 italic">Any entity type can be a target</p>
                      )}
                    </Section>
                  </>
                )}
              </div>
            )}
          </div>
        </fieldset>
      </div>

      {/* Footer — prominent action bar */}
      <div className="flex items-center justify-between px-5 py-4 border-t border-glass-border bg-canvas-elevated/50">
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-all"
        >
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button
            onClick={() => onSave(form)}
            disabled={!canSave}
            className={cn(
              'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all',
              canSave
                ? 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-md shadow-indigo-500/25 hover:shadow-lg'
                : 'bg-indigo-500/40 text-white/60 cursor-not-allowed',
            )}
          >
            <LucideIcons.Check className="w-4 h-4" />
            {isNew ? 'Create' : 'Stage Changes'}
          </button>
        )}
      </div>
    </div>
  )
}

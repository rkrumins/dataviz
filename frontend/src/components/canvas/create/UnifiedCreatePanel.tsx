/**
 * UnifiedCreatePanel — the single entity-creation surface for the canvas.
 *
 * Replaces the old split between QuickCreateNode (fast, type+name, wrote
 * directly) and EntityCreationPanel (full form, staged). Both modes now stage
 * through {@link useStageEntityCreation}, so creation always flows into the
 * draft. The entity-type picker is driven by the resolved ontology's
 * containment rules ({@link allowedChildTypeIds}), so it works for staged
 * parents too (one-child-at-a-time hierarchy).
 */
import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  useEntityTypes,
  useRootEntityTypes,
  useEntityTypeHierarchyMap,
  useRelationshipTypes,
  useContainmentEdgeTypes,
} from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { allowedChildTypeIds, deriveContainmentEdges } from '@/services/ontologyPreflightService'
import { useStageEntityCreation } from './useStageEntityCreation'
import type { EntityTypeSchema } from '@/types/schema'

/** Friendly label for a containment relationship id (e.g. `partOf` → "part of"). */
function relationshipLabel(id: string): string {
  const spaced = id.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

function DynamicIcon({ name, className, style }: { name?: string; className?: string; style?: React.CSSProperties }) {
  const Icon = name
    ? (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
    : undefined
  if (!Icon) return <LucideIcons.Box className={className} style={style} />
  return <Icon className={className} style={style} />
}

export type CreateMode = 'quick' | 'detailed'

export interface UnifiedCreatePanelProps {
  isOpen: boolean
  onClose: () => void
  /** Pre-selected parent for nested creation (node urn/id). */
  parentUrn?: string | null
  /** Pre-selected layer (carried into properties.layerAssignment). */
  layerId?: string | null
  defaultMode?: CreateMode
  /** Fired after each stage so the canvas can expand the parent. */
  onEntityCreated?: (tempUrn: string, parentUrn?: string) => void
}

export function UnifiedCreatePanel({
  isOpen,
  onClose,
  parentUrn,
  layerId,
  defaultMode = 'quick',
  onEntityCreated,
}: UnifiedCreatePanelProps) {
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const relationshipTypes = useRelationshipTypes()
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const nodes = useCanvasStore((s) => s.nodes)
  const { stageEntity } = useStageEntityCreation()

  const nameRef = useRef<HTMLInputElement>(null)
  const typeSearchRef = useRef<HTMLInputElement>(null)

  const [mode, setMode] = useState<CreateMode>(defaultMode)
  const [selectedTypeId, setSelectedTypeId] = useState<string>('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({})
  const [parentSel, setParentSel] = useState<string>(parentUrn || '')
  const [typeQuery, setTypeQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [containmentType, setContainmentType] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Reset whenever the panel (re)opens or its parent target changes.
  useEffect(() => {
    if (!isOpen) return
    setMode(defaultMode)
    setSelectedTypeId('')
    setDisplayName('')
    setDescription('')
    setTagsInput('')
    setFieldValues({})
    setParentSel(parentUrn || '')
    setTypeQuery('')
    setHighlighted(0)
    setContainmentType('')
    setError(null)
    setSuccess(null)
    setTimeout(() => typeSearchRef.current?.focus(), 60)
  }, [isOpen, parentUrn, defaultMode])

  const effectiveParentUrn = parentSel || null

  const parentNode = useMemo(
    () => (effectiveParentUrn ? nodes.find((n) => n.id === effectiveParentUrn || (n.data?.urn as string) === effectiveParentUrn) : null),
    [nodes, effectiveParentUrn],
  )
  const parentType = (parentNode?.data?.type as string) || null

  // Ontology-allowed child types for the current parent (or roots).
  const availableTypes = useMemo<EntityTypeSchema[]>(() => {
    const allowed = allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap)
    return entityTypes.filter((et) => allowed.has(et.id))
  }, [entityTypes, parentType, rootEntityTypes, hierarchyMap])

  const filteredTypes = useMemo(() => {
    if (!typeQuery.trim()) return availableTypes
    const q = typeQuery.toLowerCase()
    return availableTypes.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
  }, [availableTypes, typeQuery])

  const selectedType = useMemo(() => entityTypes.find((et) => et.id === selectedTypeId), [entityTypes, selectedTypeId])

  // Ontology-allowed containment relationship types for parent→child. Only meaningful
  // when nesting under a parent and a child type is chosen.
  const containmentOptions = useMemo(() => {
    if (!effectiveParentUrn || !parentType || !selectedTypeId) return []
    return deriveContainmentEdges(parentType, selectedTypeId, relationshipTypes, containmentEdgeTypes)
      .filter((o) => o.allowed)
  }, [effectiveParentUrn, parentType, selectedTypeId, relationshipTypes, containmentEdgeTypes])

  // Auto-select when exactly one relationship is valid (or the current pick became invalid).
  useEffect(() => {
    if (containmentOptions.length === 0) { setContainmentType(''); return }
    setContainmentType((prev) =>
      prev && containmentOptions.some((o) => o.edgeType === prev) ? prev : containmentOptions[0].edgeType,
    )
  }, [containmentOptions])

  // True when nesting is requested but the ontology permits no containment relationship.
  const noValidContainment = Boolean(effectiveParentUrn && selectedTypeId && containmentOptions.length === 0)

  const canSubmit = Boolean(selectedTypeId && displayName.trim() && !noValidContainment)

  // Potential parents = existing nodes whose type can contain something.
  const potentialParents = useMemo(() => {
    return nodes
      .filter((n) => {
        const t = n.data?.type as string
        const canContain = entityTypes.find((et) => et.id === t)?.hierarchy.canContain
        return canContain && canContain.length > 0
      })
      .map((n) => ({
        urn: (n.data?.urn as string) || n.id,
        name: (n.data?.label as string) || n.id,
        type: (n.data?.type as string) || 'unknown',
      }))
  }, [nodes, entityTypes])

  const selectType = useCallback((id: string) => {
    setSelectedTypeId(id)
    setError(null)
    if (mode === 'quick') {
      const t = entityTypes.find((et) => et.id === id)
      setDisplayName((prev) => prev || `New ${t?.name ?? id}`)
      setTimeout(() => { nameRef.current?.focus(); nameRef.current?.select() }, 50)
    }
  }, [mode, entityTypes])

  const doStage = useCallback(() => {
    if (!selectedTypeId) { setError('Select an entity type'); return }
    if (!displayName.trim()) { setError('Enter a display name'); return }
    if (noValidContainment) {
      setError(`The ontology has no containment relationship that nests a '${selectedType?.name ?? selectedTypeId}' under '${parentNode?.data?.label as string ?? parentType}'. Pick a different type or parent.`)
      return
    }

    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
    const properties: Record<string, unknown> = { ...fieldValues }
    if (description.trim()) properties.description = description.trim()
    if (layerId) properties.layerAssignment = layerId

    const tempUrn = stageEntity({
      entityType: selectedTypeId,
      displayName: displayName.trim(),
      parentUrn: effectiveParentUrn,
      containmentEdgeType: effectiveParentUrn ? (containmentType || undefined) : undefined,
      tags,
      properties,
    })

    onEntityCreated?.(tempUrn, effectiveParentUrn ?? undefined)
    setError(null)   // clear any stale validation error from a prior attempt
    setSuccess(`Staged '${displayName.trim()}' — click Save to commit`)
    // Keep the type + parent for rapid sibling creation; clear the rest.
    setDisplayName('')
    setDescription('')
    setTagsInput('')
    setFieldValues({})
    setTimeout(() => setSuccess(null), 1600)
    if (mode === 'quick') setTimeout(() => nameRef.current?.focus(), 50)
    return tempUrn
  }, [selectedTypeId, displayName, tagsInput, fieldValues, description, layerId, effectiveParentUrn, containmentType, noValidContainment, selectedType, parentNode, parentType, stageEntity, onEntityCreated, mode])

  /** Outliner move: stage, then re-scope so the NEXT entity nests under the one just created. */
  const doStageThenNest = useCallback(() => {
    const tempUrn = doStage()
    if (!tempUrn) return
    setParentSel(tempUrn)
    setSelectedTypeId('')
    setTypeQuery('')
    setTimeout(() => typeSearchRef.current?.focus(), 50)
  }, [doStage])

  const onTypeSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((i) => Math.min(i + 1, filteredTypes.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filteredTypes[highlighted]) selectType(filteredTypes[highlighted].id) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }, [filteredTypes, highlighted, selectType, onClose])

  const onNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Outliner-style: Enter stages a sibling (keeps the parent); Shift+Enter or Tab
    // stages and nests — the next entity becomes a child of the one just created.
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); doStageThenNest() }
    else if (e.key === 'Enter') { e.preventDefault(); doStage() }
    else if (e.key === 'Tab' && !e.shiftKey && canSubmit) { e.preventDefault(); doStageThenNest() }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }, [doStage, doStageThenNest, canSubmit, onClose])

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        key="unified-create-panel"
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: 400 }}
        exit={{ opacity: 0, width: 0 }}
        className="relative h-full flex-shrink-0 overflow-hidden glass-panel border-l border-glass-border shadow-lg"
      >
        <div className="w-[400px] h-full flex flex-col">
          {/* Header + mode toggle */}
          <div className="flex-shrink-0 px-5 py-4 border-b border-glass-border bg-canvas-elevated/95">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-green-500/10 flex items-center justify-center">
                  <LucideIcons.Plus className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-ink">Create Entity</h3>
                  <p className="text-xs text-ink-muted">Staged into the draft — Save to commit</p>
                </div>
              </div>
              <button onClick={onClose} className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                <LucideIcons.X className="w-5 h-5 text-ink-muted" />
              </button>
            </div>
            <div className="mt-3 inline-flex rounded-lg border border-glass-border overflow-hidden text-xs font-medium">
              {(['quick', 'detailed'] as CreateMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn('px-3 py-1.5 capitalize transition-colors', mode === m ? 'bg-accent-primary text-white' : 'text-ink-muted hover:text-ink')}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            <AnimatePresence>
              {error && (
                <motion.div key="err" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                  className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm flex items-center gap-2">
                  <LucideIcons.AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
                </motion.div>
              )}
              {success && (
                <motion.div key="ok" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                  className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400 text-sm flex items-center gap-2">
                  <LucideIcons.CheckCircle className="w-4 h-4 flex-shrink-0" />{success}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Parent — editable in detailed, shown as context in quick */}
            {mode === 'detailed' ? (
              <div className="space-y-2">
                <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Parent Container (Optional)</label>
                <select value={parentSel} onChange={(e) => { setParentSel(e.target.value); setSelectedTypeId('') }} className="input w-full">
                  <option value="">— No Parent (Root Level) —</option>
                  {potentialParents.map((p) => <option key={p.urn} value={p.urn}>{p.name} ({p.type})</option>)}
                </select>
              </div>
            ) : effectiveParentUrn && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs">
                <LucideIcons.GitFork className="w-3.5 h-3.5" />
                Creating inside <span className="font-medium">{parentNode?.data?.label as string ?? effectiveParentUrn}</span>
              </div>
            )}

            {/* Type picker */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">
                Entity Type <span className="text-red-400">*</span>
              </label>
              {mode === 'quick' ? (
                <>
                  <div className="relative">
                    <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input
                      ref={typeSearchRef} type="text" value={typeQuery}
                      onChange={(e) => { setTypeQuery(e.target.value); setHighlighted(0) }}
                      onKeyDown={onTypeSearchKeyDown} placeholder="Search entity types..."
                      className="input w-full pl-10"
                    />
                  </div>
                  <div className="max-h-[260px] overflow-y-auto custom-scrollbar space-y-1 mt-1">
                    {filteredTypes.map((t, i) => (
                      <button key={t.id} onClick={() => selectType(t.id)}
                        className={cn('w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors',
                          t.id === selectedTypeId ? 'bg-accent-primary/10 ring-1 ring-accent-primary'
                            : i === highlighted ? 'bg-black/5 dark:bg-white/5' : 'hover:bg-black/5 dark:hover:bg-white/5')}>
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${t.visual?.color}20`, color: t.visual?.color }}>
                          <DynamicIcon name={t.visual?.icon} className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-ink truncate">{t.name}</div>
                          {t.description && <div className="text-[10px] text-ink-muted truncate">{t.description}</div>}
                        </div>
                        {t.id === selectedTypeId && <LucideIcons.Check className="w-4 h-4 text-accent-primary" />}
                      </button>
                    ))}
                    {filteredTypes.length === 0 && <div className="text-center py-6 text-amber-500 text-xs">No entity types allowed here</div>}
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {availableTypes.map((t) => (
                      <button key={t.id} type="button" onClick={() => selectType(t.id)}
                        className={cn('p-3 rounded-lg border-2 transition-colors text-left',
                          selectedTypeId === t.id ? 'border-accent-primary bg-accent-primary/5' : 'border-glass-border hover:border-ink-muted/50')}>
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded flex items-center justify-center" style={{ backgroundColor: `${t.visual?.color}20` }}>
                            <DynamicIcon name={t.visual?.icon} className="w-3.5 h-3.5" style={{ color: t.visual?.color }} />
                          </div>
                          <span className="text-sm font-medium text-ink truncate">{t.name}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                  {availableTypes.length === 0 && (
                    <p className="text-xs text-amber-500 flex items-center gap-1">
                      <LucideIcons.AlertTriangle className="w-3 h-3" />No entity types available for this parent
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Relationship to parent — only when nesting and a child type is chosen */}
            {effectiveParentUrn && selectedTypeId && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Relationship to parent</label>
                {noValidContainment ? (
                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-start gap-2">
                    <LucideIcons.AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>No containment relationship in the ontology nests a <span className="font-medium">{selectedType?.name ?? selectedTypeId}</span> under <span className="font-medium">{parentNode?.data?.label as string ?? parentType}</span>. Choose a different type or parent.</span>
                  </div>
                ) : containmentOptions.length === 1 ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas-elevated border border-glass-border text-xs text-ink">
                    <LucideIcons.Link2 className="w-3.5 h-3.5 text-accent-primary flex-shrink-0" />
                    <span>
                      Added as <span className="font-semibold">{relationshipLabel(containmentOptions[0].edgeType)}</span>
                      {' '}<span className="text-ink-muted">{parentNode?.data?.label as string ? `(${parentNode?.data?.label as string})` : ''}</span>
                    </span>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {containmentOptions.map((o) => (
                      <button
                        key={o.edgeType} type="button" onClick={() => setContainmentType(o.edgeType)}
                        className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors',
                          containmentType === o.edgeType ? 'border-accent-primary bg-accent-primary/5' : 'border-glass-border hover:border-ink-muted/50')}
                      >
                        <span className={cn('w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 grid place-items-center',
                          containmentType === o.edgeType ? 'border-accent-primary' : 'border-ink-muted/40')}>
                          {containmentType === o.edgeType && <span className="w-1.5 h-1.5 rounded-full bg-accent-primary" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink truncate">{relationshipLabel(o.edgeType)}</span>
                          {o.description && <span className="block text-[10px] text-ink-muted truncate">{o.description}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Name */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Display Name <span className="text-red-400">*</span></label>
              <input ref={nameRef} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} onKeyDown={onNameKeyDown}
                placeholder="Enter display name..." className="input w-full" />
            </div>

            {/* Detailed-only fields */}
            {mode === 'detailed' && (
              <>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Description</label>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Enter description..." className="input w-full resize-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Tags</label>
                  <input type="text" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="tag1, tag2, tag3..." className="input w-full" />
                  <p className="text-xs text-ink-muted">Separate multiple tags with commas</p>
                </div>
                {selectedType && selectedType.fields.filter((f) => f.showInPanel && !['name', 'description', 'urn'].includes(f.id)).length > 0 && (
                  <div className="space-y-3">
                    <div className="text-xs font-medium text-ink-muted uppercase tracking-wider">Additional Fields</div>
                    {selectedType.fields
                      .filter((f) => f.showInPanel && !['name', 'description', 'urn'].includes(f.id))
                      .sort((a, b) => a.displayOrder - b.displayOrder)
                      .map((field) => (
                        <div key={field.id} className="space-y-1">
                          <label className="text-xs text-ink-muted">{field.name}{field.required && <span className="text-red-400 ml-1">*</span>}</label>
                          {field.type === 'boolean' ? (
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={!!fieldValues[field.id]} onChange={(e) => setFieldValues((p) => ({ ...p, [field.id]: e.target.checked }))} className="rounded" />
                              <span className="text-sm text-ink">{field.name}</span>
                            </label>
                          ) : field.type === 'number' ? (
                            <input type="number" value={(fieldValues[field.id] as number) ?? ''} onChange={(e) => setFieldValues((p) => ({ ...p, [field.id]: parseFloat(e.target.value) || 0 }))} className="input w-full" />
                          ) : (
                            <input type="text" value={(fieldValues[field.id] as string) ?? ''} onChange={(e) => setFieldValues((p) => ({ ...p, [field.id]: e.target.value }))} className="input w-full" />
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 px-5 py-4 border-t border-glass-border bg-canvas-elevated/95 flex items-center justify-between gap-3">
            <span className="text-[10px] text-ink-muted">
              <kbd className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono">↵</kbd> sibling ·{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono">⇥</kbd> child
            </span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors">Done</button>
              <button type="button" onClick={doStage} disabled={!canSubmit}
                className={cn('px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2',
                  canSubmit ? 'bg-green-500 text-white hover:bg-green-600 shadow-sm' : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed')}>
                <LucideIcons.Plus className="w-4 h-4" />Stage Entity
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

export default UnifiedCreatePanel

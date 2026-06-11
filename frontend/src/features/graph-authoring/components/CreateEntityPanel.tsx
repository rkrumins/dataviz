/**
 * CreateEntityPanel — the detailed entity-creation surface (right rail), the
 * successor to UnifiedCreatePanel's "detailed" mode. The quick path now lives in
 * DraftNodeCard, so this panel drops the mode toggle and focuses on the full
 * form: ontology-constrained type, parent, name, description, tags, and every
 * required custom field (gated by validateEntityDraft). Each "Stage" keeps the
 * type + parent for rapid sibling entry; the new node flows into the draft via
 * the authoring controller's commitCreate.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEntityTypes, useRootEntityTypes, useEntityTypeHierarchyMap } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { allowedChildTypeIds, validateEntityDraft } from '../model/ontologyGuard'
import type { StageEntityCreateInput } from '../model/stageNode'
import type { EntityTypeSchema } from '@/types/schema'

function DynamicIcon({ name, className, style }: { name?: string; className?: string; style?: React.CSSProperties }) {
  const Icon = name
    ? (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
    : undefined
  if (!Icon) return <LucideIcons.Box className={className} style={style} />
  return <Icon className={className} style={style} />
}

export interface CreateEntityPanelProps {
  parentId: string | null
  layerId: string | null
  /** Optional seed carried from the inline card's "Details…" escalation. */
  seedEntityType?: string
  seedDisplayName?: string
  onCommit: (input: StageEntityCreateInput, opts: { keepOpen: boolean; layerId: string | null }) => void
  onClose: () => void
}

export function CreateEntityPanel({ parentId, layerId, seedEntityType, seedDisplayName, onCommit, onClose }: CreateEntityPanelProps) {
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const nodes = useCanvasStore((s) => s.nodes)
  const nameRef = useRef<HTMLInputElement>(null)

  const [selectedTypeId, setSelectedTypeId] = useState(seedEntityType ?? '')
  const [displayName, setDisplayName] = useState(seedDisplayName ?? '')
  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({})
  const [parentSel, setParentSel] = useState(parentId ?? '')
  const [success, setSuccess] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)

  useEffect(() => { setTimeout(() => nameRef.current?.focus(), 60) }, [])

  const effectiveParentUrn = parentSel || null
  const parentNode = useMemo(
    () => (effectiveParentUrn ? nodes.find((n) => n.id === effectiveParentUrn || (n.data?.urn as string) === effectiveParentUrn) : null),
    [nodes, effectiveParentUrn],
  )
  const parentType = (parentNode?.data?.type as string) || null

  const availableTypes = useMemo<EntityTypeSchema[]>(() => {
    const allowed = allowedChildTypeIds(parentType, entityTypes, rootEntityTypes, hierarchyMap)
    return entityTypes.filter((et) => allowed.has(et.id))
  }, [entityTypes, parentType, rootEntityTypes, hierarchyMap])

  const selectedType = useMemo(() => entityTypes.find((et) => et.id === selectedTypeId), [entityTypes, selectedTypeId])

  const potentialParents = useMemo(() => nodes
    .filter((n) => {
      const t = n.data?.type as string
      const canContain = entityTypes.find((et) => et.id === t)?.hierarchy.canContain
      return canContain && canContain.length > 0
    })
    .map((n) => ({ urn: (n.data?.urn as string) || n.id, name: (n.data?.label as string) || n.id, type: (n.data?.type as string) || 'unknown' })),
    [nodes, entityTypes])

  const properties = useMemo(() => {
    const p: Record<string, unknown> = { ...fieldValues }
    if (description.trim()) p.description = description.trim()
    if (layerId) p.layerAssignment = layerId
    return p
  }, [fieldValues, description, layerId])

  const validation = useMemo(
    () => validateEntityDraft(selectedTypeId || null, displayName, properties, entityTypes),
    [selectedTypeId, displayName, properties, entityTypes],
  )

  const doStage = useCallback(() => {
    if (!validation.ok) { setShowErrors(true); return }
    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
    onCommit(
      { entityType: selectedTypeId, displayName: displayName.trim(), parentUrn: effectiveParentUrn, tags, properties },
      { keepOpen: true, layerId },
    )
    setSuccess(`Staged '${displayName.trim()}' — Save to commit`)
    setDisplayName(''); setDescription(''); setTagsInput(''); setFieldValues({}); setShowErrors(false)
    setTimeout(() => setSuccess(null), 1600)
    setTimeout(() => nameRef.current?.focus(), 50)
  }, [validation.ok, tagsInput, onCommit, selectedTypeId, displayName, effectiveParentUrn, properties, layerId])

  const extraFields = useMemo(
    () => (selectedType?.fields ?? []).filter((f) => f.showInPanel && !['name', 'description', 'urn'].includes(f.id)).sort((a, b) => a.displayOrder - b.displayOrder),
    [selectedType],
  )

  return (
    <AnimatePresence>
      <motion.div
        key="create-entity-panel"
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: 400 }}
        exit={{ opacity: 0, width: 0 }}
        className="relative h-full flex-shrink-0 overflow-hidden glass-panel border-l border-glass-border shadow-lg"
      >
        <div className="w-[400px] h-full flex flex-col">
          <div className="flex-shrink-0 px-5 py-4 border-b border-glass-border bg-canvas-elevated/95 flex items-center justify-between">
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

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            <AnimatePresence>
              {success && (
                <motion.div key="ok" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                  className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400 text-sm flex items-center gap-2">
                  <LucideIcons.CheckCircle className="w-4 h-4 flex-shrink-0" />{success}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Parent */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Parent Container (Optional)</label>
              <select value={parentSel} onChange={(e) => { setParentSel(e.target.value); setSelectedTypeId('') }} className="input w-full">
                <option value="">— No Parent (Root Level) —</option>
                {potentialParents.map((p) => <option key={p.urn} value={p.urn}>{p.name} ({p.type})</option>)}
              </select>
            </div>

            {/* Type */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Entity Type <span className="text-red-400">*</span></label>
              <div className="grid grid-cols-2 gap-2">
                {availableTypes.map((t) => (
                  <button key={t.id} type="button" onClick={() => setSelectedTypeId(t.id)}
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
                  <LucideIcons.AlertTriangle className="w-3 h-3" />No entity types allowed for this parent
                </p>
              )}
              {showErrors && validation.errors.entityType && <p className="text-xs text-red-400">{validation.errors.entityType}</p>}
            </div>

            {/* Name */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Display Name <span className="text-red-400">*</span></label>
              <input ref={nameRef} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doStage() } }}
                placeholder="Enter display name..." className="input w-full" />
              {showErrors && validation.errors.displayName && <p className="text-xs text-red-400">{validation.errors.displayName}</p>}
            </div>

            {/* Description */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Enter description..." className="input w-full resize-none" />
            </div>

            {/* Tags */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ink-muted uppercase tracking-wider">Tags</label>
              <input type="text" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="tag1, tag2, tag3..." className="input w-full" />
            </div>

            {/* Required + optional custom fields */}
            {extraFields.length > 0 && (
              <div className="space-y-3">
                <div className="text-xs font-medium text-ink-muted uppercase tracking-wider">Fields</div>
                {extraFields.map((field) => (
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
                    {showErrors && validation.errors[field.id] && <p className="text-xs text-red-400">{validation.errors[field.id]}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex-shrink-0 px-5 py-4 border-t border-glass-border bg-canvas-elevated/95 flex items-center justify-between gap-3">
            <span className="text-[10px] text-ink-muted">Press <kbd className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono">↵</kbd> to stage another</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors">Done</button>
              <button type="button" onClick={doStage} disabled={!validation.ok}
                className={cn('px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2',
                  validation.ok ? 'bg-green-500 text-white hover:bg-green-600 shadow-sm' : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed')}>
                <LucideIcons.Plus className="w-4 h-4" />Stage Entity
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

export default CreateEntityPanel

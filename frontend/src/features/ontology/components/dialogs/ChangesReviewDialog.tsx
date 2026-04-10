/**
 * ChangesReviewDialog — modal that shows a visual diff of schema changes
 * before saving. Compares server state vs working copies so the user can
 * review exactly what will be persisted.
 */
import { useMemo } from 'react'
import { Plus, Minus, PenLine, X, Save, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { humanizeId } from '../../lib/ontology-parsers'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ChangesReviewDialogProps {
  /** The current saved state from the server. */
  ontology: OntologyDefinitionResponse
  /** Working copy of entity type definitions (keyed by type ID). */
  workingEntityDefs: Record<string, unknown>
  /** Working copy of relationship type definitions (keyed by type ID). */
  workingRelDefs: Record<string, unknown>
  /** Working copy of containment edge type IDs. */
  workingContainment: string[]
  /** Working copy of lineage edge type IDs. */
  workingLineage: string[]
  /** Working copy of settings (name, description, evolution policy). Null = no settings changes. */
  workingDetails?: { name: string; description: string; evolutionPolicy: string } | null
  /** True while the save request is in flight. */
  isSaving: boolean
  /** Callback to persist all changes. */
  onSave: () => void
  /** Callback to close the dialog without saving. */
  onClose: () => void
}

/* ------------------------------------------------------------------ */
/*  Diff helpers                                                       */
/* ------------------------------------------------------------------ */

interface DiffItem {
  id: string
  label: string
  /** For modified items, the list of fields that changed. */
  changedFields?: string[]
}

interface DiffResult {
  added: DiffItem[]
  modified: DiffItem[]
  removed: DiffItem[]
}

/**
 * Compute a simple diff between two Record<string, unknown> maps.
 * - Added:    IDs present in `working` but absent in `server`.
 * - Removed:  IDs present in `server` but absent in `working`.
 * - Modified: IDs present in both but with different JSON representations.
 */
function diffRecords(
  server: Record<string, unknown>,
  working: Record<string, unknown>,
): DiffResult {
  const serverIds = new Set(Object.keys(server))
  const workingIds = new Set(Object.keys(working))

  const added: DiffItem[] = []
  const removed: DiffItem[] = []
  const modified: DiffItem[] = []

  // Added — in working but not server
  for (const id of workingIds) {
    if (!serverIds.has(id)) {
      added.push({ id, label: humanizeId(id) })
    }
  }

  // Removed — in server but not working
  for (const id of serverIds) {
    if (!workingIds.has(id)) {
      removed.push({ id, label: humanizeId(id) })
    }
  }

  // Modified — in both but different
  for (const id of workingIds) {
    if (!serverIds.has(id)) continue
    const serverJson = JSON.stringify(server[id])
    const workingJson = JSON.stringify(working[id])
    if (serverJson !== workingJson) {
      // Identify which top-level fields changed
      const serverObj = (server[id] ?? {}) as Record<string, unknown>
      const workingObj = (working[id] ?? {}) as Record<string, unknown>
      const allKeys = new Set([...Object.keys(serverObj), ...Object.keys(workingObj)])
      const changedFields: string[] = []
      for (const key of allKeys) {
        if (JSON.stringify(serverObj[key]) !== JSON.stringify(workingObj[key])) {
          changedFields.push(key)
        }
      }
      modified.push({ id, label: humanizeId(id), changedFields })
    }
  }

  return { added, modified, removed }
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

/** A single row inside a diff section. */
function DiffRow({ item }: { item: DiffItem }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="font-medium text-sm text-ink">{item.label}</span>
      {item.changedFields && item.changedFields.length > 0 && (
        <span className="text-xs text-ink-muted mt-0.5">
          ({item.changedFields.map(f => humanizeId(f)).join(', ')})
        </span>
      )}
    </div>
  )
}

/** Collapsible section for a diff category (added / modified / removed). */
function DiffSection({
  icon: Icon,
  title,
  items,
  colorClasses,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  items: DiffItem[]
  /** Tailwind classes for the section background, icon colour, etc. */
  colorClasses: { bg: string; icon: string; border: string }
}) {
  if (items.length === 0) return null
  return (
    <div className={cn('rounded-xl border px-4 py-3', colorClasses.bg, colorClasses.border)}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn('w-4 h-4', colorClasses.icon)} />
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {title} ({items.length})
        </span>
      </div>
      <div className="space-y-0.5">
        {items.map(item => (
          <DiffRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function ChangesReviewDialog({
  ontology,
  workingEntityDefs,
  workingRelDefs,
  workingContainment,
  workingLineage,
  workingDetails,
  isSaving,
  onSave,
  onClose,
}: ChangesReviewDialogProps) {
  // --- compute diffs ---------------------------------------------------

  const entityDiff = useMemo(
    () =>
      diffRecords(
        (ontology.entityTypeDefinitions ?? {}) as Record<string, unknown>,
        workingEntityDefs,
      ),
    [ontology.entityTypeDefinitions, workingEntityDefs],
  )

  const relDiff = useMemo(
    () =>
      diffRecords(
        (ontology.relationshipTypeDefinitions ?? {}) as Record<string, unknown>,
        workingRelDefs,
      ),
    [ontology.relationshipTypeDefinitions, workingRelDefs],
  )

  // Check whether containment or lineage arrays changed
  const containmentChanged = useMemo(
    () => JSON.stringify([...(ontology.containmentEdgeTypes ?? [])].sort()) !==
          JSON.stringify([...workingContainment].sort()),
    [ontology.containmentEdgeTypes, workingContainment],
  )

  const lineageChanged = useMemo(
    () => JSON.stringify([...(ontology.lineageEdgeTypes ?? [])].sort()) !==
          JSON.stringify([...workingLineage].sort()),
    [ontology.lineageEdgeTypes, workingLineage],
  )

  // Check for settings changes (name, description, evolution policy)
  const settingsChanges = useMemo(() => {
    if (!workingDetails) return []
    const changes: string[] = []
    if (workingDetails.name !== ontology.name) changes.push(`Name: "${ontology.name}" → "${workingDetails.name}"`)
    if (workingDetails.description !== (ontology.description ?? '')) changes.push('Description updated')
    if (workingDetails.evolutionPolicy !== (ontology.evolutionPolicy ?? 'reject')) changes.push(`Evolution policy: ${ontology.evolutionPolicy ?? 'reject'} → ${workingDetails.evolutionPolicy}`)
    return changes
  }, [workingDetails, ontology])

  // --- aggregate summary counts ----------------------------------------

  const totalAdded = entityDiff.added.length + relDiff.added.length
  const totalModified =
    entityDiff.modified.length +
    relDiff.modified.length +
    (containmentChanged ? 1 : 0) +
    (lineageChanged ? 1 : 0) +
    (settingsChanges.length > 0 ? 1 : 0)
  const totalRemoved = entityDiff.removed.length + relDiff.removed.length

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-canvas-elevated rounded-2xl shadow-2xl border border-glass-border w-full max-w-lg mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-center gap-3 flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-5 h-5 text-indigo-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ink">Review Changes</h3>
            <p className="text-sm text-ink-muted mt-0.5">
              {totalAdded} added, {totalModified} modified, {totalRemoved} removed
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-ink-muted" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="px-6 pb-4 overflow-y-auto flex-1 space-y-3">
          {/* ---- Entity type diffs ---- */}
          {(entityDiff.added.length > 0 ||
            entityDiff.modified.length > 0 ||
            entityDiff.removed.length > 0) && (
            <div>
              <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
                Entity Types
              </p>
              <div className="space-y-2">
                <DiffSection
                  icon={Plus}
                  title="Added"
                  items={entityDiff.added}
                  colorClasses={{
                    bg: 'bg-emerald-500/5',
                    icon: 'text-emerald-500',
                    border: 'border-emerald-500/10',
                  }}
                />
                <DiffSection
                  icon={PenLine}
                  title="Modified"
                  items={entityDiff.modified}
                  colorClasses={{
                    bg: 'bg-amber-500/5',
                    icon: 'text-amber-500',
                    border: 'border-amber-500/10',
                  }}
                />
                <DiffSection
                  icon={Minus}
                  title="Removed"
                  items={entityDiff.removed}
                  colorClasses={{
                    bg: 'bg-red-500/5',
                    icon: 'text-red-500',
                    border: 'border-red-500/10',
                  }}
                />
              </div>
            </div>
          )}

          {/* ---- Relationship type diffs ---- */}
          {(relDiff.added.length > 0 ||
            relDiff.modified.length > 0 ||
            relDiff.removed.length > 0) && (
            <div>
              <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
                Relationship Types
              </p>
              <div className="space-y-2">
                <DiffSection
                  icon={Plus}
                  title="Added"
                  items={relDiff.added}
                  colorClasses={{
                    bg: 'bg-emerald-500/5',
                    icon: 'text-emerald-500',
                    border: 'border-emerald-500/10',
                  }}
                />
                <DiffSection
                  icon={PenLine}
                  title="Modified"
                  items={relDiff.modified}
                  colorClasses={{
                    bg: 'bg-amber-500/5',
                    icon: 'text-amber-500',
                    border: 'border-amber-500/10',
                  }}
                />
                <DiffSection
                  icon={Minus}
                  title="Removed"
                  items={relDiff.removed}
                  colorClasses={{
                    bg: 'bg-red-500/5',
                    icon: 'text-red-500',
                    border: 'border-red-500/10',
                  }}
                />
              </div>
            </div>
          )}

          {/* ---- Edge classification changes ---- */}
          {(containmentChanged || lineageChanged) && (
            <div>
              <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
                Edge Classification
              </p>
              <div className="space-y-2">
                {containmentChanged && (
                  <div className="rounded-xl border bg-amber-500/5 border-amber-500/10 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <PenLine className="w-4 h-4 text-amber-500" />
                      <span className="text-sm font-medium text-ink">Containment hierarchy updated</span>
                    </div>
                  </div>
                )}
                {lineageChanged && (
                  <div className="rounded-xl border bg-amber-500/5 border-amber-500/10 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <PenLine className="w-4 h-4 text-amber-500" />
                      <span className="text-sm font-medium text-ink">Lineage configuration updated</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ---- Settings changes ---- */}
          {settingsChanges.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
                Settings
              </p>
              <div className="rounded-xl border bg-amber-500/5 border-amber-500/10 px-4 py-3 space-y-1">
                {settingsChanges.map((change, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <PenLine className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    <span className="text-sm text-ink">{change}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty state — nothing changed */}
          {totalAdded === 0 && totalModified === 0 && totalRemoved === 0 && (
            <p className="text-sm text-ink-muted text-center py-6">
              No changes detected.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Continue Editing
          </button>
          <button
            onClick={onSave}
            disabled={isSaving || (totalAdded === 0 && totalModified === 0 && totalRemoved === 0)}
            className={cn(
              'flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors shadow-sm disabled:opacity-50',
              'bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700',
              'shadow-emerald-500/20',
            )}
          >
            {isSaving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                Save All Changes
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

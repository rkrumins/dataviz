/**
 * VersionDiffDialog — compare two versions of a semantic layer.
 *
 * Runs the shared diff engine over both versions' definitions and renders the
 * same added/modified/removed sections the pre-save review uses, plus edge
 * classification and name/description rows. Optionally offers "Restore this
 * version" (delegated to the caller — nothing here writes).
 */
import { useMemo } from 'react'
import { Plus, Minus, PenLine, X, GitCompareArrows, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { diffRecords } from '../../lib/ontology-diff'
import { DiffSection } from './ChangesReviewDialog'

interface VersionDiffDialogProps {
  /** The reference version (usually the one currently being viewed). */
  base: OntologyDefinitionResponse
  /** The version being compared against the base. */
  target: OntologyDefinitionResponse
  /** Offer "Restore this version" (creates a draft from `target`). */
  onRestore?: () => void
  onClose: () => void
}

const GREEN = { bg: 'bg-emerald-500/5', icon: 'text-emerald-500', border: 'border-emerald-500/10' }
const AMBER = { bg: 'bg-amber-500/5', icon: 'text-amber-500', border: 'border-amber-500/10' }
const RED = { bg: 'bg-red-500/5', icon: 'text-red-500', border: 'border-red-500/10' }

export function VersionDiffDialog({ base, target, onRestore, onClose }: VersionDiffDialogProps) {
  // Diff direction: "what changes if you go from base to target".
  const entityDiff = useMemo(
    () => diffRecords(
      (base.entityTypeDefinitions ?? {}) as Record<string, unknown>,
      (target.entityTypeDefinitions ?? {}) as Record<string, unknown>,
    ),
    [base.entityTypeDefinitions, target.entityTypeDefinitions],
  )
  const relDiff = useMemo(
    () => diffRecords(
      (base.relationshipTypeDefinitions ?? {}) as Record<string, unknown>,
      (target.relationshipTypeDefinitions ?? {}) as Record<string, unknown>,
    ),
    [base.relationshipTypeDefinitions, target.relationshipTypeDefinitions],
  )

  const containmentChanged =
    JSON.stringify([...(base.containmentEdgeTypes ?? [])].sort()) !==
    JSON.stringify([...(target.containmentEdgeTypes ?? [])].sort())
  const lineageChanged =
    JSON.stringify([...(base.lineageEdgeTypes ?? [])].sort()) !==
    JSON.stringify([...(target.lineageEdgeTypes ?? [])].sort())
  const nameChanged = base.name !== target.name
  const descriptionChanged = (base.description ?? '') !== (target.description ?? '')

  const totalChanges =
    entityDiff.added.length + entityDiff.modified.length + entityDiff.removed.length +
    relDiff.added.length + relDiff.modified.length + relDiff.removed.length +
    (containmentChanged ? 1 : 0) + (lineageChanged ? 1 : 0) +
    (nameChanged ? 1 : 0) + (descriptionChanged ? 1 : 0)

  return (
    <>
      <Backdrop open={true} onClick={onClose} zClassName="z-[100]" className="bg-black/40" />
      <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
      <div className="relative pointer-events-auto bg-canvas-elevated rounded-2xl shadow-lg border border-glass-border w-full max-w-lg mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-center gap-3 flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
            <GitCompareArrows className="w-5 h-5 text-indigo-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ink">
              v{base.version} → v{target.version}
            </h3>
            <p className="text-sm text-ink-muted mt-0.5">
              {totalChanges === 0
                ? 'The two versions are identical in content.'
                : `${totalChanges} difference${totalChanges !== 1 ? 's' : ''} — what changes going from v${base.version} to v${target.version}`}
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

        {/* Body */}
        <div className="px-6 pb-4 overflow-y-auto flex-1 space-y-3">
          {(entityDiff.added.length > 0 || entityDiff.modified.length > 0 || entityDiff.removed.length > 0) && (
            <div>
              <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">Entity Types</p>
              <div className="space-y-2">
                <DiffSection icon={Plus} title="Added" items={entityDiff.added} colorClasses={GREEN} />
                <DiffSection icon={PenLine} title="Modified" items={entityDiff.modified} colorClasses={AMBER} />
                <DiffSection icon={Minus} title="Removed" items={entityDiff.removed} colorClasses={RED} />
              </div>
            </div>
          )}

          {(relDiff.added.length > 0 || relDiff.modified.length > 0 || relDiff.removed.length > 0) && (
            <div>
              <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">Relationship Types</p>
              <div className="space-y-2">
                <DiffSection icon={Plus} title="Added" items={relDiff.added} colorClasses={GREEN} />
                <DiffSection icon={PenLine} title="Modified" items={relDiff.modified} colorClasses={AMBER} />
                <DiffSection icon={Minus} title="Removed" items={relDiff.removed} colorClasses={RED} />
              </div>
            </div>
          )}

          {(containmentChanged || lineageChanged || nameChanged || descriptionChanged) && (
            <div>
              <p className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">Other</p>
              <div className="rounded-xl border bg-amber-500/5 border-amber-500/10 px-4 py-3 space-y-1">
                {nameChanged && (
                  <p className="text-sm text-ink flex items-center gap-2">
                    <PenLine className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    Name: &ldquo;{base.name}&rdquo; → &ldquo;{target.name}&rdquo;
                  </p>
                )}
                {descriptionChanged && (
                  <p className="text-sm text-ink flex items-center gap-2">
                    <PenLine className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    Description differs
                  </p>
                )}
                {containmentChanged && (
                  <p className="text-sm text-ink flex items-center gap-2">
                    <PenLine className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    Containment classification differs
                  </p>
                )}
                {lineageChanged && (
                  <p className="text-sm text-ink flex items-center gap-2">
                    <PenLine className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    Lineage classification differs
                  </p>
                )}
              </div>
            </div>
          )}

          {totalChanges === 0 && (
            <p className="text-sm text-ink-muted text-center py-6">No content differences.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Close
          </button>
          {onRestore && (
            <button
              onClick={onRestore}
              className={cn(
                'flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors shadow-sm',
                'bg-indigo-500 hover:bg-indigo-600 shadow-indigo-500/20',
              )}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Restore v{target.version} as new draft
            </button>
          )}
        </div>
      </div>
      </div>
    </>
  )
}

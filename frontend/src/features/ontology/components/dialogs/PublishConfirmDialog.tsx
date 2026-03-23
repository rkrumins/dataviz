import { X, AlertTriangle, Plus, Minus, Lock, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse, OntologyImpactResponse } from '@/services/ontologyDefinitionService'

interface PublishConfirmDialogProps {
  ontology: OntologyDefinitionResponse
  impact: OntologyImpactResponse
  isPublishing?: boolean
  onConfirm: () => void
  onClose: () => void
}

function TypeDiffList({ types, variant }: { types: string[]; variant: 'added' | 'removed' }) {
  if (types.length === 0) return null

  const isAdded = variant === 'added'
  return (
    <div className="flex flex-wrap gap-1.5">
      {types.map(t => (
        <span
          key={t}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium',
            isAdded
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400'
              : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
          )}
        >
          {isAdded ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
          {t}
        </span>
      ))}
    </div>
  )
}

const POLICY_LABELS: Record<string, string> = {
  reject: 'Reject',
  deprecate: 'Deprecate',
  migrate: 'Migrate',
}

export function PublishConfirmDialog({
  ontology,
  impact,
  isPublishing,
  onConfirm,
  onClose,
}: PublishConfirmDialogProps) {
  const hasChanges =
    impact.addedEntityTypes.length > 0 ||
    impact.removedEntityTypes.length > 0 ||
    impact.addedRelationshipTypes.length > 0 ||
    impact.removedRelationshipTypes.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/50 dark:border-indigo-800/50 flex items-center justify-center flex-shrink-0">
                <Shield className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h3 className="text-base font-bold text-ink">
                  Publish &ldquo;{ontology.name}&rdquo;
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">Version {ontology.version}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Irreversibility warning — prominent */}
        <div className="mx-6 mb-4">
          <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50">
            <Lock className="w-4.5 h-4.5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                This action is permanent
              </p>
              <p className="text-xs text-amber-700/80 dark:text-amber-400/70 mt-1 leading-relaxed">
                Once published, this version becomes <strong>immutable</strong> — you will not be able to edit, rename, or modify it. All assigned data sources will immediately use this version.
                To make further changes, you will need to <strong>clone</strong> it first.
              </p>
            </div>
          </div>
        </div>

        {/* Impact section */}
        {hasChanges && (
          <div className="mx-6 mb-4 space-y-3">
            <p className="text-xs font-bold text-ink-muted uppercase tracking-wider">Impact Preview</p>
            {impact.addedEntityTypes.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-ink-muted mb-1.5">Added Entity Types</p>
                <TypeDiffList types={impact.addedEntityTypes} variant="added" />
              </div>
            )}
            {impact.removedEntityTypes.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-ink-muted mb-1.5">Removed Entity Types</p>
                <TypeDiffList types={impact.removedEntityTypes} variant="removed" />
              </div>
            )}
            {impact.addedRelationshipTypes.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-ink-muted mb-1.5">Added Relationship Types</p>
                <TypeDiffList types={impact.addedRelationshipTypes} variant="added" />
              </div>
            )}
            {impact.removedRelationshipTypes.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-ink-muted mb-1.5">Removed Relationship Types</p>
                <TypeDiffList types={impact.removedRelationshipTypes} variant="removed" />
              </div>
            )}
          </div>
        )}

        {!hasChanges && (
          <p className="text-sm text-ink-muted mx-6 mb-4">No type changes detected compared to the previous published version.</p>
        )}

        {/* Blocked warning */}
        {!impact.allowed && impact.reason && (
          <div className="flex items-start gap-2.5 mx-6 mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/50">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700 dark:text-red-400">{impact.reason}</p>
          </div>
        )}

        {/* Evolution policy badge */}
        <div className="flex items-center gap-2 mx-6 mb-4">
          <span className="text-xs text-ink-muted">Evolution policy:</span>
          <span className="inline-flex px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/5 text-xs font-semibold text-ink">
            {POLICY_LABELS[impact.evolutionPolicy] ?? impact.evolutionPolicy}
          </span>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-glass-border bg-black/[0.01] dark:bg-white/[0.01]">
          <button
            onClick={onClose}
            autoFocus
            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!impact.allowed || isPublishing}
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold transition-all shadow-md',
              impact.allowed && !isPublishing
                ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:from-indigo-600 hover:to-purple-600 shadow-indigo-500/25'
                : 'bg-indigo-500/40 text-white/60 cursor-not-allowed shadow-none',
            )}
          >
            <Shield className="w-4 h-4" />
            {isPublishing ? 'Publishing...' : 'Publish Now'}
          </button>
        </div>
      </div>
    </div>
  )
}

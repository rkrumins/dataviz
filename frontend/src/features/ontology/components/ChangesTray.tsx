/**
 * ChangesTray — staged changes as first-class objects.
 *
 * A persistent, collapsible bar pinned above the content while edits are
 * staged: one chip per changed type (added / modified with the changed fields /
 * removed), each with per-change revert and click-to-jump, plus Review and
 * Save All. Complements the pre-save ChangesReviewDialog — the tray is the
 * live running total, the dialog the final confirmation.
 */
import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronDown, ChevronUp, Plus, Minus, PenLine, Undo2, Eye, Save, Loader2,
  GitBranch, Box, Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { diffRecords, type DiffItem } from '../lib/ontology-diff'
import { humanizeId } from '../lib/ontology-parsers'

type ChangeKind = 'added' | 'modified' | 'removed'

interface TrayChange {
  key: string
  kind: ChangeKind
  scope: 'entity' | 'rel' | 'classification' | 'details'
  id: string
  label: string
  detail?: string
}

interface ChangesTrayProps {
  ontology: OntologyDefinitionResponse
  workingEntityDefs: Record<string, unknown> | null
  workingRelDefs: Record<string, unknown> | null
  workingContainment: string[] | null
  workingLineage: string[] | null
  workingDetails: { name: string; description: string; evolutionPolicy: string } | null
  isSaving: boolean
  /** Revert one type's staged change back to the server state. */
  onRevertEntity: (id: string) => void
  onRevertRel: (id: string) => void
  onRevertClassification: () => void
  onRevertDetails: () => void
  /** Jump to the type's card (schema tab). */
  onJumpToType: (scope: 'entity' | 'rel', id: string) => void
  onReview: () => void
  onSaveAll: () => void
}

const KIND_STYLES: Record<ChangeKind, { icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  added: { icon: Plus, cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
  modified: { icon: PenLine, cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
  removed: { icon: Minus, cls: 'bg-red-500/10 text-red-500 border-red-500/20' },
}

export function ChangesTray({
  ontology,
  workingEntityDefs,
  workingRelDefs,
  workingContainment,
  workingLineage,
  workingDetails,
  isSaving,
  onRevertEntity,
  onRevertRel,
  onRevertClassification,
  onRevertDetails,
  onJumpToType,
  onReview,
  onSaveAll,
}: ChangesTrayProps) {
  const [expanded, setExpanded] = useState(true)

  const changes = useMemo((): TrayChange[] => {
    const out: TrayChange[] = []

    const collect = (
      scope: 'entity' | 'rel',
      serverDefs: Record<string, unknown>,
      working: Record<string, unknown> | null,
    ) => {
      if (!working) return
      const diff = diffRecords(serverDefs, working)
      const push = (kind: ChangeKind) => (item: DiffItem) => out.push({
        key: `${scope}:${kind}:${item.id}`,
        kind,
        scope,
        id: item.id,
        label: item.label,
        detail: kind === 'modified' && item.changedFields?.length
          ? item.changedFields.map(f => humanizeId(f).toLowerCase()).join(', ')
          : undefined,
      })
      diff.added.forEach(push('added'))
      diff.modified.forEach(push('modified'))
      diff.removed.forEach(push('removed'))
    }

    collect('entity', (ontology.entityTypeDefinitions ?? {}) as Record<string, unknown>, workingEntityDefs)
    collect('rel', (ontology.relationshipTypeDefinitions ?? {}) as Record<string, unknown>, workingRelDefs)

    const containmentChanged = workingContainment &&
      JSON.stringify([...workingContainment].sort()) !== JSON.stringify([...(ontology.containmentEdgeTypes ?? [])].sort())
    const lineageChanged = workingLineage &&
      JSON.stringify([...workingLineage].sort()) !== JSON.stringify([...(ontology.lineageEdgeTypes ?? [])].sort())
    if (containmentChanged || lineageChanged) {
      out.push({
        key: 'classification',
        kind: 'modified',
        scope: 'classification',
        id: 'classification',
        label: 'Edge classification',
        detail: [containmentChanged && 'containment', lineageChanged && 'lineage'].filter(Boolean).join(', '),
      })
    }

    if (workingDetails) {
      const detailFields: string[] = []
      if (workingDetails.name !== ontology.name) detailFields.push('name')
      if (workingDetails.description !== (ontology.description ?? '')) detailFields.push('description')
      if (workingDetails.evolutionPolicy !== (ontology.evolutionPolicy ?? 'reject')) detailFields.push('policy')
      if (detailFields.length > 0) {
        out.push({
          key: 'details',
          kind: 'modified',
          scope: 'details',
          id: 'details',
          label: 'Details',
          detail: detailFields.join(', '),
        })
      }
    }

    return out
  }, [ontology, workingEntityDefs, workingRelDefs, workingContainment, workingLineage, workingDetails])

  if (changes.length === 0) return null

  function revert(change: TrayChange) {
    if (change.scope === 'entity') onRevertEntity(change.id)
    else if (change.scope === 'rel') onRevertRel(change.id)
    else if (change.scope === 'classification') onRevertClassification()
    else onRevertDetails()
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.04] overflow-hidden"
    >
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-2 text-left flex-1 min-w-0"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-amber-500" /> : <ChevronDown className="w-3.5 h-3.5 text-amber-500" />}
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
          <span className="text-xs font-semibold text-ink">
            {changes.length} staged change{changes.length !== 1 ? 's' : ''}
          </span>
          <span className="text-[11px] text-ink-muted truncate">— nothing is saved until Save All</span>
        </button>
        <button
          onClick={onReview}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-indigo-600 hover:bg-indigo-500/[0.06] transition-colors"
        >
          <Eye className="w-3 h-3" /> Review
        </button>
        <button
          onClick={onSaveAll}
          disabled={isSaving}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-500 text-white hover:bg-emerald-600 shadow-sm shadow-emerald-500/25 transition-colors disabled:opacity-60"
        >
          {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          {isSaving ? 'Saving…' : 'Save All'}
        </button>
      </div>

      {/* Chips */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
              {changes.map(change => {
                const style = KIND_STYLES[change.kind]
                const Icon = style.icon
                const ScopeIcon = change.scope === 'rel' ? GitBranch : change.scope === 'entity' ? Box : Settings
                const canJump = change.scope === 'entity' || change.scope === 'rel'
                return (
                  <span
                    key={change.key}
                    className={cn('inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg border text-[11px] font-medium', style.cls)}
                  >
                    <Icon className="w-3 h-3 flex-shrink-0" />
                    <ScopeIcon className="w-3 h-3 flex-shrink-0 opacity-60" />
                    {canJump ? (
                      <button
                        onClick={() => onJumpToType(change.scope as 'entity' | 'rel', change.id)}
                        className="hover:underline underline-offset-2 max-w-[160px] truncate"
                        title={`Jump to ${change.label}`}
                      >
                        {change.label}
                      </button>
                    ) : (
                      <span className="max-w-[160px] truncate">{change.label}</span>
                    )}
                    {change.detail && (
                      <span className="opacity-70 max-w-[140px] truncate">({change.detail})</span>
                    )}
                    <button
                      onClick={() => revert(change)}
                      title="Revert this change"
                      aria-label={`Revert ${change.label}`}
                      className="ml-0.5 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                    >
                      <Undo2 className="w-3 h-3" />
                    </button>
                  </span>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/**
 * BlankCanvasEmptyState — the full-canvas hero a brand-new blank model opens onto.
 * Rendered by ContextViewCanvas only when hydration is complete, the canvas has zero
 * nodes, and the resolved graph is a `kind === 'blank'` model.
 *
 * Three states, per the premium non-technical UI principle (edit affordances only in
 * Edit mode):
 * - In a draft: primary "Add your first entity" CTA, the ontology's root types shown
 *   as orientation chips (what a model typically starts with), plus keyboard hints.
 * - Not in a draft but can manage: a single "Start building" CTA that opens a draft.
 * - Read-only: a descriptive card with no edit controls.
 */
import { useMemo, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { motion } from 'framer-motion'
import { PenLine, Plus, Shapes, Info, ChevronDown } from 'lucide-react'
import { useEntityTypes, useRootEntityTypes } from '@/store/schema'
import type { EntityTypeSchema } from '@/types/schema'
import { DeclaredVsPhysical } from '@/features/ontology/components/DeclaredVsPhysical'
import { useFeature } from '@/store/features'
import { cn } from '@/lib/utils'

const MAX_QUICK_TYPES = 4

function typeIcon(et: EntityTypeSchema | undefined) {
  const name = et?.visual?.icon
  const Icon = (name && (LucideIcons as Record<string, unknown>)[name]) as
    | React.ComponentType<{ className?: string; style?: React.CSSProperties }>
    | undefined
  return Icon ?? Shapes
}

interface BlankCanvasEmptyStateProps {
  modelName: string | null
  ontologyName?: string | null
  isDraft: boolean
  canManage: boolean
  /** Open the create panel. */
  onAddEntity: () => void
  /** Open (or resume) the caller's draft — the not-in-draft CTA. */
  onStartBuilding: () => void
}

export function BlankCanvasEmptyState({
  modelName, ontologyName, isDraft, canManage, onAddEntity, onStartBuilding,
}: BlankCanvasEmptyStateProps) {
  const entityTypes = useEntityTypes()
  const rootTypeIds = useRootEntityTypes()
  const [showBlueprint, setShowBlueprint] = useState(false)

  // A blank model IS a versioned model — it exists as nothing but drafts and commits. With
  // version control off it cannot be built AT ALL: `ensureDraftOpen()` returns null and the
  // server refuses the writes. Offering "Start building" anyway produced a button that did
  // nothing at all when clicked, and said nothing about why. Permission and availability are
  // different reasons to be read-only, and the user is owed the one that is actually true.
  const versioningEnabled = useFeature('versioningEnabled')
  // The provenance switch. A hand-drawn model looks exactly like a discovered one on the canvas,
  // and once it's in the estate nobody downstream can tell which is which.
  const blankModelsEnabled = useFeature('blankModelsEnabled')
  const canBuild = canManage && versioningEnabled && blankModelsEnabled

  // Root types first (the natural tops of the containment tree); pad with the
  // lowest-level types when the ontology declares no explicit roots.
  const quickTypes = useMemo(() => {
    const byId = new Map(entityTypes.map((et) => [et.id, et]))
    const roots = rootTypeIds.map((id) => byId.get(id)).filter(Boolean) as EntityTypeSchema[]
    const pool = roots.length > 0
      ? roots
      : [...entityTypes].sort((a, b) => (a.hierarchy?.level ?? 0) - (b.hierarchy?.level ?? 0))
    return pool.slice(0, MAX_QUICK_TYPES)
  }, [entityTypes, rootTypeIds])

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="pointer-events-auto w-[420px] max-w-[calc(100%-3rem)] rounded-3xl border border-glass-border bg-canvas-elevated/95 backdrop-blur-xl shadow-xl p-7 text-center"
      >
        <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-accent-lineage/15 to-violet-500/10 border border-accent-lineage/20 mb-4">
          <PenLine className="w-7 h-7 text-accent-lineage" />
        </span>
        <h2 className="text-lg font-bold text-ink leading-tight">
          {canBuild
            ? (modelName ? `Start building ${modelName}` : 'Start building your model')
            : (modelName ? `${modelName} is empty` : 'This model is empty')}
        </h2>
        <p className="text-sm text-ink-muted mt-1.5">
          {!canBuild
            ? (ontologyName
              ? <>This blank model follows the <span className="font-medium text-ink">{ontologyName}</span> blueprint. Nothing has been added to it yet.</>
              : 'Nothing has been added to this model yet.')
            : ontologyName
              ? <>This blank model follows the <span className="font-medium text-ink">{ontologyName}</span> blueprint — it guides which entities can go where, so everything you add stays consistent.</>
              : 'Add entities, nest them into a hierarchy, and connect them to map your data flows.'}
        </p>

        {ontologyName && (
          <div className="mt-3">
            <button
              onClick={() => setShowBlueprint(v => !v)}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
            >
              <Info className="w-3.5 h-3.5" />
              What does this blueprint mean?
              <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showBlueprint && 'rotate-180')} />
            </button>
            {showBlueprint && (
              <div className="mt-2 text-left animate-in fade-in slide-in-from-top-1 duration-200">
                <p className="text-[11px] text-ink-muted leading-relaxed mb-2">
                  Everything you add here is written to the graph using the blueprint's own types — entity types become node labels,
                  relationships become edge types:
                </p>
                <DeclaredVsPhysical entityExample={quickTypes[0]?.id || 'Customer'} />
              </div>
            )}
          </div>
        )}

        {isDraft && canBuild ? (
          <>
            <button
              onClick={() => onAddEntity()}
              className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <Plus className="w-4 h-4" />
              Add your first entity
            </button>
            {quickTypes.length > 0 && (
              <div className="mt-4">
                <p className="text-[10px] uppercase tracking-wide text-ink-muted/70 mb-2">Models like this usually start with</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {quickTypes.map((et) => {
                    const Icon = typeIcon(et)
                    return (
                      <span
                        key={et.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-glass-border bg-canvas-overlay/60 text-xs font-medium text-ink"
                      >
                        <Icon className="w-3.5 h-3.5" style={{ color: et.visual?.color }} />
                        {et.name}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}
            <p className="mt-5 text-[11px] text-ink-muted/80">
              Tip: press <kbd className="px-1.5 py-0.5 rounded border border-glass-border bg-canvas-overlay text-[10px] font-semibold">N</kbd> to
              add an entity, <kbd className="px-1.5 py-0.5 rounded border border-glass-border bg-canvas-overlay text-[10px] font-semibold">C</kbd> to connect two.
            </p>
          </>
        ) : canBuild ? (
          <button
            onClick={onStartBuilding}
            className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <PenLine className="w-4 h-4" />
            Start building
          </button>
        ) : !versioningEnabled ? (
          // Not a permissions problem, and saying it is would send the user to ask the wrong
          // person. Nobody can build here — the capability itself is switched off.
          <p className="mt-4 text-xs text-ink-muted">
            Editing is turned off for this workspace, so this model is view-only.
            An administrator can turn it back on.
          </p>
        ) : (
          <p className="mt-4 text-xs text-ink-muted">
            Nothing has been added yet. Someone with edit access can start building this model.
          </p>
        )}
      </motion.div>
    </div>
  )
}

/**
 * ViewVersionsDrawer — the history of a view's DESIGN: its layers, placements and settings.
 *
 * Not graph version control. Drafts, commits and review requests version the graph's data and
 * live in the versioning panel; these versions exist for every view, version-controlled source
 * or not, are numbered v1, v2…, and never borrow that vocabulary (no commits, no publishing, no
 * reverting). Restoring says so outright: the graph data isn't touched.
 *
 *   ┌ unsaved changes since vN (what changed) · Save version ┐
 *   ├ where it came from, when it was imported ┤
 *   └ timeline: each version with where it came from, who, when, what changed in size;
 *     compare it with now or with the one before, restore it, or export it ┘
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  ArrowLeft, ArrowUpFromLine, Camera, FileDown, FileUp, Flag, GitCompareArrows, History, Loader2, RotateCcw,
  Save, Sparkles, Wand2, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { MOTION } from '@/lib/motion'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { useSchemaStore } from '@/store/schema'
import { useFeature } from '@/store/features'
import { viewToViewConfig } from '@/services/viewApiService'
import type { ViewDefinitionDiff, ViewVersionSource, ViewVersionSummary } from '@/services/viewVersionsApiService'
import {
  useCompareViewVersions, useRestoreViewVersion, useSaveViewVersion, useViewVersionHistory, useViewVersionStatus,
} from '@/hooks/useViewVersions'
import { ExportViewDialog } from '@/features/view-transfer/ExportViewDialog'
import { VERSION_SOURCE_LABEL, pluralize, shortHash } from '@/features/view-transfer/format'
import { VersionDiffView } from './VersionDiffView'

const SOURCE_ICON: Record<ViewVersionSource, typeof Flag> = {
  baseline: Flag, create: Sparkles, wizard: Wand2, import: FileDown, restore: RotateCcw,
  promote: ArrowUpFromLine, export: FileUp, manual: Save, snapshot: Camera,
}

type Comparison = { from: number; to: number | 'working'; label: string }

export function ViewVersionsDrawer({ viewId, viewName, isOpen, onClose, canEdit }: {
  viewId: string
  viewName: string
  isOpen: boolean
  onClose: () => void
  /** Saving and restoring need edit access; reading the history needs only read. */
  canEdit: boolean
}) {
  const history = useViewVersionHistory(viewId, isOpen)
  const status = useViewVersionStatus(viewId, isOpen)
  const exportEnabled = useFeature('viewExportEnabled')
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [restoring, setRestoring] = useState<ViewVersionSummary | null>(null)
  const [exporting, setExporting] = useState<number | null>(null)

  // Escape closes it, Tab stays inside it, and focus goes back afterwards; a dialog opened on top
  // (restore, export) answers for itself. The callback stays stable: the hook re-focuses the panel
  // whenever it changes, which would pull the cursor out of the note field on a parent re-render.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  const close = useCallback(() => onCloseRef.current(), [])
  const panelRef = useModalA11y(isOpen && !restoring && exporting === null, close)

  const pages = history.data?.pages
  const versions = useMemo(() => (pages ?? []).flatMap(p => p.items), [pages])
  const working = pages?.[0]?.workingCopy
  const origin = status.data?.origin

  if (!isOpen) return null

  return createPortal(
    <>
      <Backdrop open onClick={onClose} zClassName="z-[70]" />
      <motion.aside
        ref={panelRef}
        tabIndex={-1}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        transition={MOTION.drawerSlide}
        role="dialog"
        aria-modal="true"
        aria-label={`Versions of ${viewName}`}
        className="fixed right-0 top-0 bottom-0 z-[71] w-full max-w-xl bg-canvas-elevated border-l border-glass-border shadow-2xl flex flex-col outline-none"
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-glass-border shrink-0">
          {comparison ? (
            <button type="button" onClick={() => setComparison(null)} aria-label="Back to versions"
              className="w-9 h-9 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted flex items-center justify-center shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </button>
          ) : (
            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
              <History className="w-4 h-4" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-ink truncate">{comparison ? comparison.label : 'Versions'}</h2>
            <p className="text-xs text-ink-muted truncate">{viewName}</p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 space-y-4">
          {comparison ? (
            <ComparisonPanel viewId={viewId} comparison={comparison} />
          ) : (
            <>
              <p className="text-[11px] text-ink-muted leading-relaxed">
                Versions of this view’s <span className="font-semibold text-ink-secondary">design</span>: its layers,
                placements and settings. Not the graph data, which drafts and reviews look after.
              </p>

              {working && versions.length > 0 && (
                <WorkingCopyCard viewId={viewId} dirty={working.dirty} head={versions[0]}
                  summary={working.summary ?? null} canEdit={canEdit}
                  onCompare={() => setComparison({ from: versions[0].version, to: 'working', label: `Since v${versions[0].version}` })} />
              )}

              {origin && (
                <div className="flex items-center gap-2 rounded-xl border border-indigo-200/70 dark:border-indigo-900/60 bg-indigo-50/40 dark:bg-indigo-950/20 px-3 py-2 text-[11px] text-ink-secondary">
                  <FileDown className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                  <span className="min-w-0 truncate">
                    Came from {origin.version ? <>v{origin.version} in </> : null}
                    <span className="font-semibold">{origin.environment || 'another environment'}</span>
                    {' '}as v{origin.importedAsVersion} here, {timeAgo(origin.importedAt)}
                  </span>
                </div>
              )}

              {history.isLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-ink-muted">
                  <Loader2 className="w-4 h-4 animate-spin" /> Reading the history…
                </div>
              ) : history.error ? (
                <p className="text-xs text-rose-500">Couldn’t read the history: {history.error.message}</p>
              ) : (
                <ol className="relative space-y-1">
                  <span aria-hidden className="absolute left-[15px] top-3 bottom-3 w-px bg-glass-border" />
                  {versions.map((v, i) => (
                    <VersionRow key={v.version} version={v} previous={versions[i + 1]} isHead={i === 0}
                      canEdit={canEdit} canExport={exportEnabled}
                      onCompare={(to) => setComparison(to === 'working'
                        ? { from: v.version, to: 'working', label: `v${v.version} → now` }
                        : { from: to, to: v.version, label: `v${to} → v${v.version}` })}
                      onRestore={() => setRestoring(v)}
                      onExport={() => setExporting(v.version)} />
                  ))}
                </ol>
              )}

              {history.hasNextPage && (
                <button type="button" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}
                  className="w-full py-2 rounded-xl text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                  {history.isFetchingNextPage ? 'Loading…' : 'Show older versions'}
                </button>
              )}
            </>
          )}
        </div>
      </motion.aside>

      {restoring && (
        <RestoreConfirm viewId={viewId} version={restoring} head={versions[0]?.version ?? restoring.version}
          dirty={!!working?.dirty} onClose={() => setRestoring(null)} />
      )}
      {exporting !== null && (
        <ExportViewDialog views={[{ id: viewId, name: viewName }]} initialVersion={exporting} onClose={() => setExporting(null)} />
      )}
    </>,
    document.body,
  )
}

function WorkingCopyCard({ viewId, dirty, head, summary, canEdit, onCompare }: {
  viewId: string
  dirty: boolean
  head: ViewVersionSummary
  summary: ViewDefinitionDiff | null
  canEdit: boolean
  onCompare: () => void
}) {
  const [note, setNote] = useState('')
  const save = useSaveViewVersion(viewId)
  const { notify } = useAppNotifications()
  if (!dirty) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-glass-border px-3 py-2.5 text-xs text-ink-secondary">
        <span className="w-2 h-2 rounded-full bg-emerald-500" />
        No changes since <span className="font-semibold">v{head.version}</span>
      </div>
    )
  }
  const a = summary?.assignments
  const changes = [
    summary?.layers.added.length ? pluralize(summary.layers.added.length, 'layer') + ' added' : '',
    summary?.layers.removed.length ? pluralize(summary.layers.removed.length, 'layer') + ' removed' : '',
    summary?.layers.changed.length ? pluralize(summary.layers.changed.length, 'layer') + ' changed' : '',
    a?.added ? `${a.added.toLocaleString()} placed` : '',
    a?.removed ? `${a.removed.toLocaleString()} unplaced` : '',
    a?.moved ? `${a.moved.toLocaleString()} moved` : '',
    summary?.metadata.length ? 'details changed' : '',
    summary?.settings.length ? pluralize(summary.settings.length, 'setting') + ' changed' : '',
  ].filter(Boolean)
  return (
    <div className="rounded-2xl border border-amber-300/60 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/15 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <span className="w-2 h-2 mt-1.5 rounded-full bg-amber-500 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-ink">Changes since v{head.version}</p>
          <p className="text-[11px] text-ink-muted mt-0.5">{changes.length ? changes.join(', ') : 'The design has changed.'}</p>
        </div>
        <button type="button" onClick={onCompare} className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">
          See changes
        </button>
      </div>
      {canEdit && (
        <form className="flex items-center gap-2" onSubmit={(e) => {
          e.preventDefault()
          save.mutate(note.trim() || undefined, {
            onSuccess: (r) => { setNote(''); notify('success', r.created ? `Saved as v${r.version.version}` : 'Nothing new to save') },
            onError: (err) => notify('error', err instanceof Error ? err.message : 'Could not save the version'),
          })
        }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-label="Note for this version"
            placeholder={`Note for v${head.version + 1} (optional)`}
            className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-glass-border bg-canvas-elevated text-ink placeholder:text-ink-muted outline-none focus:border-indigo-500" />
          <button type="submit" disabled={save.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-60 shrink-0">
            {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save version
          </button>
        </form>
      )}
    </div>
  )
}

function VersionRow({ version: v, previous, isHead, canEdit, canExport, onCompare, onRestore, onExport }: {
  version: ViewVersionSummary
  previous?: ViewVersionSummary
  isHead: boolean
  canEdit: boolean
  canExport: boolean
  onCompare: (to: number | 'working') => void
  onRestore: () => void
  onExport: () => void
}) {
  const Icon = SOURCE_ICON[v.source] ?? Save
  const placements = v.stats.assignments ?? 0
  const delta = previous ? placements - (previous.stats.assignments ?? 0) : 0
  const provenance = (v.provenance ?? {}) as { origin?: { environment?: string; version?: number }; restoredFrom?: number }
  return (
    <li className="relative flex gap-3 rounded-xl px-1 py-2 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] group">
      <span className={cn('relative z-10 w-8 h-8 rounded-full border flex items-center justify-center shrink-0 bg-canvas-elevated',
        isHead ? 'border-indigo-400 text-indigo-500' : 'border-glass-border text-ink-muted')}>
        <Icon className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('text-xs font-bold tabular-nums', isHead ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink')}>v{v.version}</span>
          <span className="text-xs text-ink-secondary truncate">{VERSION_SOURCE_LABEL[v.source]}</span>
          {provenance.origin?.environment && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 shrink-0">
              from {provenance.origin.environment}{provenance.origin.version ? ` v${provenance.origin.version}` : ''}
            </span>
          )}
          {provenance.restoredFrom && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary shrink-0">
              as of v{provenance.restoredFrom}
            </span>
          )}
          <span className="ml-auto text-[11px] text-ink-muted shrink-0">{timeAgo(v.createdAt)}</span>
        </div>
        <p className="text-[11px] text-ink-muted mt-0.5 truncate">
          {v.createdByName ?? 'Someone'}{v.message ? <> · <span className="text-ink-secondary">“{v.message}”</span></> : null}
        </p>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-ink-muted">
          <span>{pluralize(v.stats.layers ?? 0, 'layer')} · {pluralize(placements, 'placement')}</span>
          {delta !== 0 && <span className={delta > 0 ? 'text-emerald-600' : 'text-rose-600'}>{delta > 0 ? `+${delta}` : delta}</span>}
          <span className="font-mono" title={v.contentHash}>#{shortHash(v.contentHash)}</span>
        </div>
        <div className="flex items-center gap-1 mt-1.5 opacity-70 group-hover:opacity-100 transition-opacity">
          <RowAction icon={<GitCompareArrows className="w-3 h-3" />} onClick={() => onCompare('working')}>Compare with now</RowAction>
          {previous && <RowAction onClick={() => onCompare(previous.version)}>with v{previous.version}</RowAction>}
          {canEdit && !isHead && <RowAction icon={<RotateCcw className="w-3 h-3" />} onClick={onRestore}>Restore</RowAction>}
          {canExport && <RowAction icon={<FileUp className="w-3 h-3" />} onClick={onExport}>Export</RowAction>}
        </div>
      </div>
    </li>
  )
}

function RowAction({ icon, onClick, children }: { icon?: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
      {icon}{children}
    </button>
  )
}

function ComparisonPanel({ viewId, comparison }: { viewId: string; comparison: Comparison }) {
  const { data, isLoading, error } = useCompareViewVersions(viewId, comparison.from, comparison.to)
  if (isLoading) {
    return <div className="flex items-center justify-center gap-2 py-10 text-xs text-ink-muted"><Loader2 className="w-4 h-4 animate-spin" /> Comparing…</div>
  }
  if (error || !data) return <p className="text-xs text-rose-500">Couldn’t compare: {error?.message}</p>
  return <VersionDiffView diff={data.diff} />
}

function RestoreConfirm({ viewId, version, head, dirty, onClose }: {
  viewId: string
  version: ViewVersionSummary
  head: number
  dirty: boolean
  onClose: () => void
}) {
  const restore = useRestoreViewVersion(viewId)
  const { notify } = useAppNotifications()
  const becomes = head + (dirty ? 2 : 1)
  // Escape cancels, unless the restore is already under way.
  const pendingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    pendingRef.current = restore.isPending
    onCloseRef.current = onClose
  })
  const cancel = useCallback(() => { if (!pendingRef.current) onCloseRef.current() }, [])
  const dialogRef = useModalA11y(true, cancel)
  return (
    <>
      <Backdrop open onClick={restore.isPending ? undefined : onClose} zClassName="z-[80]" className="bg-black/40" />
      <div className="fixed inset-0 z-[81] flex items-center justify-center p-4 pointer-events-none">
        <div ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="restore-title"
          className="pointer-events-auto w-full max-w-md rounded-2xl bg-canvas-elevated border border-glass-border shadow-2xl p-6 space-y-4 outline-none">
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0"><RotateCcw className="w-5 h-5" /></span>
            <div>
              <h3 id="restore-title" className="text-base font-bold text-ink">Restore v{version.version}?</h3>
              <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                The view’s design becomes what it was at v{version.version}, saved as <span className="font-semibold text-ink-secondary">v{becomes}</span>.
                Nothing is rewritten: every version stays in the history.
                {dirty ? <> Your unsaved changes are saved first, as v{head + 1}.</> : null}
              </p>
              <p className="text-xs text-ink-muted mt-2">The graph data isn’t affected, and who can see the view doesn’t change.</p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} disabled={restore.isPending}
              className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40">Cancel</button>
            <button type="button" disabled={restore.isPending}
              onClick={() => restore.mutate(version.version, {
                onSuccess: (r) => {
                  // The canvas reads the view from the schema store; hand it the restored design.
                  useSchemaStore.getState().addOrUpdateView(viewToViewConfig(r.view))
                  notify('success', `Restored v${version.version} as v${r.version.version}`)
                  onClose()
                },
                onError: (err) => notify('error', err instanceof Error ? err.message : 'Could not restore that version'),
              })}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-60">
              {restore.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              Restore v{version.version}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

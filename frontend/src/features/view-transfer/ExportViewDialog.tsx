/**
 * ExportViewDialog — download one or more views as a file another environment can import.
 *
 * A view file carries the view's DESIGN (layers, placements, rules, settings, name) and its
 * version history, never the graph data. Every export is a real version: the one picked, or the
 * current design, which is saved as a new version first when it has unsaved changes, so the file
 * always names a version this view can be compared and updated against later. Only someone who
 * may edit the view saves that version; anyone else exports its latest version as it stands.
 *
 * What each view would go out as comes from one request (`previewExport`) however many views
 * are selected.
 *
 * "View + data" packages the views WITH their graph data (a .view-package.zip), for a data
 * source under version control: the view's own entities or the whole source, as published or as
 * in the person's draft. An export job builds it on the server; the dialog follows it.
 *
 * Two columns, like the graph ExportDialog: what travels (and what doesn't) on the left, the
 * version choice and a preview of the file on the right.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, Check, CheckCircle2, Copy, Database, Download, EyeOff, FileJson2, Fingerprint,
  GitPullRequestDraft, History, Layers, Loader2, Package, RefreshCw, Tag, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { invalidateViewVersions, useViewVersions } from '@/hooks/useViewVersions'
import {
  exportViewPackage, exportViews, previewExport, type ExportedFile, type ExportedPackage, type ExportPreview,
  type PackageDataVersion, type PackageScope,
} from '@/services/viewTransferApiService'
import type { ViewVersionSummary } from '@/services/viewVersionsApiService'
import type { Job } from '@/services/importExportApiService'
import { recordEvent } from '@/services/telemetryService'
import { useFeature } from '@/store/features'
import { usePermission } from '@/store/auth'
import { onRadioGroupKeyDown } from '@/lib/radioGroupKeys'
import { useResolveGraph } from '@/features/versioning/hooks/useVersioning'
import { VERSION_SOURCE_LABEL, fileSize, pluralize, shortHash, viewFileName, viewPackageName } from './format'

export interface ExportViewDialogProps {
  /** One view, or several (the Explorer's bulk bar). */
  views: Array<{ id: string; name: string }>
  /** Pre-select an earlier version (single view only), e.g. "Export v6" from the history. */
  initialVersion?: number
  /** Open on "View + data" (the canvas's "Export view + data…"); it explains itself when the
   *  data can't come along. */
  initialContent?: 'view' | 'data'
  onClose: () => void
}

type Phase = 'choose' | 'running' | 'done' | 'failed'

/** The server's cap on views in one file (`view_transfer.limits.MAX_VIEWS_PER_BUNDLE`). */
export const MAX_VIEWS_PER_FILE = 200

export const EXPORT_PREVIEW_QUERY_KEY = 'view-export-preview'

/** What each view would go out as: one request however many views are selected. */
function useExportPreview(views: Array<{ id: string }>, enabled: boolean) {
  const ids = views.map((v) => v.id)
  return useQuery({
    queryKey: [EXPORT_PREVIEW_QUERY_KEY, ids],
    queryFn: () => previewExport(ids),
    enabled,
    staleTime: 15_000,
  })
}

/** Whether these views can be packaged with their data, and if not, why not. */
function usePackageOption(views: Array<{ id: string }>, preview: ExportPreview[] | undefined) {
  const loaded = !!preview
  const scopes = new Set((preview ?? []).map((p) => `${p.workspaceId}|${p.dataSourceId ?? ''}`))
  const first = preview?.[0]
  const oneSource = loaded && scopes.size === 1 && !!first?.dataSourceId
  const graphExport = useFeature('graphExportEnabled')
  const canRead = usePermission('workspace:datasource:read', first?.workspaceId)
  const resolved = useResolveGraph(
    oneSource && graphExport ? first?.workspaceId : undefined,
    oneSource && graphExport ? first?.dataSourceId : null,
    views.length === 1 ? views[0].id : null,
  )
  const reason = !loaded ? null
    : !oneSource ? 'A package holds views from one data source.'
      : !graphExport ? 'Exporting graph data is turned off here.'
        : !canRead ? 'Packaging data needs permission to read this data source.'
          : resolved.isLoading ? null
            : !resolved.data?.graphId ? 'Only a data source under version control can be packaged with its data.'
              : null
  return {
    available: loaded && !reason && !!resolved.data?.graphId,
    reason,
    hasDraft: !!resolved.data?.myDraft?.branchId,
  }
}

export function ExportViewDialog({ views, initialVersion, initialContent = 'view', onClose }: ExportViewDialogProps) {
  const single = views.length === 1
  const [phase, setPhase] = useState<Phase>('choose')
  const [pick, setPick] = useState<'current' | number>(initialVersion ?? 'current')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<ExportedFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState<'view' | 'data'>(initialContent)
  const [scope, setScope] = useState<PackageScope>(single ? 'view' : 'source')
  const [dataVersion, setDataVersion] = useState<PackageDataVersion>('published')
  const [packaged, setPackaged] = useState<ExportedPackage | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const tooMany = views.length > MAX_VIEWS_PER_FILE
  const preview = useExportPreview(views, !tooMany && phase === 'choose')
  const packageOption = usePackageOption(views, preview.data?.views)
  const withData = content === 'data' && packageOption.available
  const queryClient = useQueryClient()
  // Stable for the dialog's whole life: the a11y hook re-focuses the panel whenever its callback
  // changes, which would pull the cursor out of the note field on any parent re-render.
  const runningRef = useRef(false)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    runningRef.current = phase === 'running'
    onCloseRef.current = onClose
  })
  const close = useCallback(() => { if (!runningRef.current) onCloseRef.current() }, [])
  const panelRef = useModalA11y(true, close)

  async function run() {
    setPhase('running')
    setError(null)
    setJob(null)
    try {
      if (withData) {
        const done = await exportViewPackage(
          views.map((v) => ({ viewId: v.id, version: single && pick !== 'current' ? pick : null })),
          { scope: single ? scope : 'source', dataVersion: single ? dataVersion : 'published', message: note.trim() || undefined },
          setJob,
        )
        setPackaged(done)
        setPhase('done')
        views.forEach((v) => invalidateViewVersions(queryClient, v.id))
        void queryClient.invalidateQueries({ queryKey: [EXPORT_PREVIEW_QUERY_KEY] })
        recordEvent('view.export', { views: views.length, withData: true, scope, dataVersion })
        return
      }
      const file = await exportViews(
        views.map((v) => ({ viewId: v.id, version: single && pick !== 'current' ? pick : null })),
        note.trim() || undefined,
      )
      setResult(file)
      setPhase('done')
      // Exporting unsaved changes saved them as a version: the history and header chip moved.
      views.forEach((v) => invalidateViewVersions(queryClient, v.id))
      void queryClient.invalidateQueries({ queryKey: [EXPORT_PREVIEW_QUERY_KEY] })
      recordEvent('view.export', { views: views.length, version: single && pick !== 'current' ? 'earlier' : 'current' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export could not be completed.')
      setPhase('failed')
    }
  }

  const title = withData
    ? (single ? 'Export view with its data' : `Export ${views.length} views with their data`)
    : single ? 'Export view' : `Export ${views.length} views`

  // Portaled, and clicks stop here: hosts include clickable cards and menus, which must not
  // react to a click that was meant for the dialog.
  return createPortal(
    <div onClick={(e) => e.stopPropagation()}>
      <Backdrop open onClick={phase === 'running' ? undefined : onClose} zClassName="z-50" className="bg-black/50 backdrop-blur-sm" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-view-title"
          tabIndex={-1}
          className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col animate-in zoom-in-95 fade-in duration-200 overflow-hidden pointer-events-auto outline-none"
        >
          <div className="border-b border-glass-border px-8 py-5 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/20 flex-shrink-0">
                {withData ? <Package className="w-6 h-6" /> : <FileJson2 className="w-6 h-6" />}
              </div>
              <div className="min-w-0">
                <h3 id="export-view-title" className="text-xl font-bold text-ink">{title}</h3>
                <p className="text-xs text-ink-muted mt-0.5 truncate">
                  {single ? <>A file of <span className="font-medium text-ink-secondary">{views[0].name}</span> to import into another environment</>
                    : 'One file with every view, to import into another environment'}
                </p>
              </div>
            </div>
            {phase !== 'running' && (
              <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {phase === 'choose' && (
              <div className="grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
                <WhatTravels withData={withData} />
                <div className="px-8 py-6 space-y-5">
                  <ContentChoice content={withData ? 'data' : 'view'} onChange={setContent} reason={packageOption.reason} />
                  {withData && (
                    <DataChoice single={single} scope={scope} setScope={setScope} dataVersion={dataVersion}
                      setDataVersion={setDataVersion} hasDraft={packageOption.hasDraft} />
                  )}
                  {single
                    ? <SingleViewChoice view={views[0]} preview={preview.data?.views[0]} pick={pick} setPick={setPick}
                      note={note} setNote={setNote} withData={withData} />
                    : <ManyViewsChoice views={views} preview={preview} note={note} setNote={setNote} withData={withData} />}
                </div>
              </div>
            )}
            {phase === 'running' && (
              <div className="px-8 py-16 flex flex-col items-center gap-4">
                <div className="relative w-16 h-16">
                  <div className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping" />
                  <div className="relative w-16 h-16 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center">
                    <Loader2 className="w-7 h-7 text-indigo-500 animate-spin" />
                  </div>
                </div>
                <p className="text-sm font-semibold text-ink">{withData ? 'Packaging the view with its data…' : 'Preparing the file…'}</p>
                <p className="text-[11px] text-ink-muted">
                  {withData
                    ? (job?.status === 'running' ? 'Writing the graph data and packing it with the view. Large sources take a while.'
                      : 'Recording the version and starting the export.')
                    : 'Recording the version and naming every entity it places.'} The download starts by itself.
                </p>
              </div>
            )}
            {phase === 'done' && packaged && <PackageDone result={packaged} />}
            {phase === 'done' && result && !packaged && <Done result={result} count={views.length} />}
            {phase === 'failed' && (
              <div className="px-8 py-10 max-w-2xl mx-auto flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-500 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-ink">The export didn't complete</h3>
                  <p className="text-sm text-ink-muted mt-1 break-words">{error}</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-8 py-4 border-t border-glass-border bg-black/[0.01] dark:bg-white/[0.01] flex-shrink-0">
            <button onClick={onClose} disabled={phase === 'running'} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40">
              {phase === 'done' ? 'Done' : 'Cancel'}
            </button>
            {phase === 'choose' && tooMany && (
              <p className="mr-auto text-[11px] text-amber-600 dark:text-amber-400">
                A file holds up to {MAX_VIEWS_PER_FILE} views. Select fewer and export them in groups.
              </p>
            )}
            {phase === 'choose' && (
              <button onClick={run} disabled={tooMany} className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20 disabled:opacity-40 disabled:cursor-not-allowed">
                <Download className="w-4 h-4" /> Download
              </button>
            )}
            {phase === 'failed' && (
              <button onClick={run} className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                <RefreshCw className="w-4 h-4" /> Try again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Left column ──────────────────────────────────────────────────────────────

function WhatTravels({ withData = false }: { withData?: boolean }) {
  return (
    <div className="px-8 py-6 border-b md:border-b-0 md:border-r border-glass-border bg-gradient-to-br from-indigo-50/40 to-transparent dark:from-indigo-950/15 space-y-5">
      <div>
        <h4 className="text-sm font-bold text-ink">{withData ? 'What’s in the package' : 'What’s in the file'}</h4>
        <p className="text-[11px] text-ink-muted mt-0.5">
          {withData ? 'The view file, and the graph data it shows: everything to bring both to another environment.'
            : 'Everything needed to rebuild the view where the same data source is onboarded.'}
        </p>
      </div>
      <ul className="space-y-3">
        {withData && (
          <>
            <Feature icon={<Database className="w-4 h-4" />} title="Its graph data"
              body="Entities and relationships with all their properties, in the data source's own export format, which also imports on its own." />
            <Feature icon={<GitPullRequestDraft className="w-4 h-4" />} title="Imported through a draft"
              body="There, data and view land in a draft together, for review. It only adds and updates: a package never deletes anything." />
          </>
        )}
        <Feature icon={<Layers className="w-4 h-4" />} title="Its design, exactly"
          body="Layers, placements, rules, display rules and settings — including any this environment doesn't know about yet." />
        <Feature icon={<Tag className="w-4 h-4" />} title="Name, description, icon and tags"
          body="Kept as they are. Whoever imports it can rename it on the way in." />
        <Feature icon={<History className="w-4 h-4" />} title="Its version history"
          body="So importing a newer file later updates the view there instead of making a second one." />
        <Feature icon={<Fingerprint className="w-4 h-4" />} title="A fingerprint"
          body="The import checks it, and says so if the file was edited after it left." />
      </ul>
      <div className="rounded-xl bg-black/[0.03] dark:bg-white/[0.04] px-3.5 py-3 flex items-start gap-2.5">
        <EyeOff className="w-4 h-4 text-ink-muted flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-ink-muted leading-relaxed">
          <span className="font-semibold text-ink-secondary">Not included:</span>{' '}
          {withData ? '' : 'the graph data itself, '}who the view is shared with, favourites, draft changes to the view,
          its saved queries (the Property Manager's Rules &amp; saved queries export takes those),
          and anyone's email address.{withData ? '' : ' Entities are named so the import can show what it didn\'t find.'}
        </p>
      </div>
    </div>
  )
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="w-7 h-7 rounded-lg bg-indigo-100/70 dark:bg-indigo-900/40 text-indigo-500 flex items-center justify-center flex-shrink-0">{icon}</span>
      <div>
        <p className="text-xs font-semibold text-ink">{title}</p>
        <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">{body}</p>
      </div>
    </li>
  )
}

// ── Right column: one view ───────────────────────────────────────────────────

function SingleViewChoice({ view, preview, pick, setPick, note, setNote, withData = false }: {
  view: { id: string; name: string }
  /** What exporting the current design would write; `maySeal` is false for someone who can't edit. */
  preview?: ExportPreview
  pick: 'current' | number
  setPick: (p: 'current' | number) => void
  note: string
  setNote: (n: string) => void
  withData?: boolean
}) {
  const { data, isLoading, error } = useViewVersions(view.id)
  const versions = data?.items ?? []
  const working = data?.workingCopy
  const head = versions[0]
  const dirty = !!working?.dirty
  // Unsaved changes are sealed into the file only by someone who may edit the view.
  const seals = dirty && (preview?.maySeal ?? true)
  const exportsAs = pick === 'current' ? (seals ? (head?.version ?? 0) + 1 : head?.version ?? null) : pick
  const chosen: ViewVersionSummary | undefined = pick === 'current' ? head : versions.find((v) => v.version === pick)
  const earlier = versions.slice(dirty ? 0 : 1)

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-ink-muted py-10 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Reading this view's versions…</div>
  }
  if (error) {
    return <p className="text-xs text-rose-500 py-6">Couldn't read this view's versions: {error.message}</p>
  }

  return (
    <>
      <div>
        <label className="block text-xs font-medium text-ink-secondary mb-2">Which version</label>
        <div className="space-y-2">
          <Choice active={pick === 'current'} onClick={() => setPick('current')}
            title={seals ? `The current design, as v${exportsAs}`
              : dirty ? `The latest version${head ? ` · v${head.version}` : ''}`
                : `The current design${head ? ` · v${head.version}` : ''}`}
            desc={seals ? 'It has unsaved changes. They are saved as a new version first, so the file names a version this view has.'
              : dirty ? `Changes made since v${head?.version} aren’t saved as a version yet, so they aren’t in the file. Only someone who can edit this view can save them.`
                : head ? `${VERSION_SOURCE_LABEL[head.source]} ${timeAgo(head.createdAt)}${head.createdByName ? ` by ${head.createdByName}` : ''}` : ''} />
          {pick === 'current' && seals && (
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              placeholder={`Note for v${exportsAs} (optional) — e.g. "For the UAT release"`}
              className="w-full px-3 py-2 rounded-xl border border-glass-border bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:border-indigo-500 transition-colors" />
          )}
          {earlier.length > 0 && (
            <Choice active={pick !== 'current'} onClick={() => setPick(earlier[0].version)}
              title="An earlier version" desc="Export the view as it was at a version in its history." />
          )}
          {pick !== 'current' && (
            <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Version to export"
              className="w-full px-3 py-2 rounded-xl border border-glass-border bg-canvas-elevated text-sm text-ink focus:outline-none focus:border-indigo-500">
              {earlier.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {VERSION_SOURCE_LABEL[v.source]} · {timeAgo(v.createdAt)}{v.message ? ` · ${v.message}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <FilePreview filename={withData ? viewPackageName(view.name, exportsAs) : viewFileName(view.name, exportsAs)}
        stats={pick === 'current' && preview ? preview.stats : chosen?.stats} withData={withData}
        bytes={pick === 'current' && !withData ? preview?.estimatedBytes : undefined} />
    </>
  )
}

function Choice({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('w-full text-left px-3.5 py-3 rounded-xl border-2 transition-colors duration-150',
        active ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
          : 'border-glass-border hover:border-glass-border-hover')}>
      <p className={cn('text-xs font-semibold', active ? 'text-ink' : 'text-ink-secondary')}>{title}</p>
      {desc && <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">{desc}</p>}
    </button>
  )
}

function FilePreview({ filename, stats, bytes, withData = false }: {
  filename: string
  stats?: Record<string, number>
  /** Roughly how big the file is, when known. */
  bytes?: number
  withData?: boolean
}) {
  const rows: Array<[string, number | undefined]> = [
    ['layers', stats?.layers], ['placements', stats?.assignments], ['rules', stats?.rules],
    ['display rules', stats?.displayRules],
  ]
  return (
    <div className="rounded-xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] p-4">
      <div className="flex items-center gap-2.5">
        {withData ? <Package className="w-4 h-4 text-indigo-500 flex-shrink-0" /> : <FileJson2 className="w-4 h-4 text-indigo-500 flex-shrink-0" />}
        <span className="text-xs font-mono text-ink truncate" title={filename}>{filename}</span>
        {withData && <span className="ml-auto text-[10px] font-semibold text-ink-muted shrink-0">+ graph data</span>}
        {!withData && bytes !== undefined && (
          <span className="ml-auto text-[10px] font-semibold text-ink-muted shrink-0">about {fileSize(bytes)}</span>
        )}
      </div>
      {stats && (
        <div className="grid grid-cols-4 gap-2 mt-3">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded-lg bg-canvas-elevated border border-glass-border px-2 py-1.5 text-center">
              <p className="text-sm font-bold text-ink tabular-nums">{(value ?? 0).toLocaleString()}</p>
              <p className="text-[10px] text-ink-muted">{label}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Right column: several views ──────────────────────────────────────────────

function ManyViewsChoice({ views, preview, note, setNote, withData = false }: {
  views: Array<{ id: string; name: string }>
  preview: ReturnType<typeof useExportPreview>
  note: string
  setNote: (n: string) => void
  withData?: boolean
}) {
  const byId = useMemo(() => new Map((preview.data?.views ?? []).map((p) => [p.viewId, p])), [preview.data])
  const sealing = (preview.data?.views ?? []).filter((p) => p.includesUnsaved).length
  const totals = useMemo(() => {
    const all = preview.data?.views
    if (!all) return undefined
    const stats: Record<string, number> = {}
    for (const p of all) for (const [k, v] of Object.entries(p.stats ?? {})) stats[k] = (stats[k] ?? 0) + (v ?? 0)
    return { stats, bytes: all.reduce((n, p) => n + p.estimatedBytes, 0) }
  }, [preview.data])

  return (
    <>
      <div>
        <label className="block text-xs font-medium text-ink-secondary mb-2">{pluralize(views.length, 'view')}, each at its current design</label>
        <ul className="rounded-xl border border-glass-border divide-y divide-glass-border max-h-72 overflow-y-auto">
          {views.map((view) => {
            const p = byId.get(view.id)
            return (
              <li key={view.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="text-xs font-medium text-ink truncate flex-1" title={view.name}>{view.name}</span>
                {!p ? (preview.isError ? <span className="text-[10px] text-rose-500">couldn’t be read</span>
                  : <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" />)
                  : p.includesUnsaved ? (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                      title="Unsaved changes are saved as a new version first">
                      {p.headVersion ? `v${p.headVersion} + changes → v${p.exportsAs}` : 'saved as v1'}
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                      title={p.dirty ? `Changes since v${p.exportsAs} aren’t saved as a version yet, so they aren’t in the file. Only someone who can edit this view can save them.` : undefined}>
                      v{p.exportsAs}{p.dirty ? ' · changes not included' : ''}
                    </span>
                  )}
              </li>
            )
          })}
        </ul>
        {preview.isError && (
          <p className="text-[11px] text-rose-500 mt-2">These views couldn’t be read: {preview.error.message}</p>
        )}
      </div>
      {sealing > 0 && (
        <div>
          <label className="block text-xs font-medium text-ink-secondary mb-1.5">
            Note for the {pluralize(sealing, 'new version')} <span className="text-ink-muted font-normal">(optional)</span>
          </label>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder='e.g. "For the UAT release"'
            className="w-full px-3 py-2 rounded-xl border border-glass-border bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:border-indigo-500 transition-colors" />
        </div>
      )}
      <FilePreview filename={withData ? `${views.length}-views.view-package.zip` : `${views.length}-views.view.json`} withData={withData}
        stats={totals?.stats} bytes={withData ? undefined : totals?.bytes} />
    </>
  )
}

// ── Right column: view only, or view + data ─────────────────────────────────

function ContentChoice({ content, onChange, reason }: {
  content: 'view' | 'data'
  onChange: (c: 'view' | 'data') => void
  /** Why the data can't come too, when it can't. */
  reason: string | null
}) {
  const options = [
    { id: 'view' as const, icon: FileJson2, title: 'View only', desc: 'Its design and history, as a .view.json file.' },
    { id: 'data' as const, icon: Package, title: 'View + data', desc: 'With the graph data it shows, as a package.' },
  ]
  return (
    <div>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="What to export" onKeyDown={onRadioGroupKeyDown}>
        {options.map((o) => {
          const disabled = o.id === 'data' && !!reason
          const Icon = o.icon
          return (
            <button key={o.id} type="button" role="radio" aria-checked={content === o.id} disabled={disabled}
              tabIndex={content === o.id ? 0 : -1} onClick={() => onChange(o.id)}
              className={cn('text-left px-3.5 py-2.5 rounded-xl border-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                content === o.id ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20' : 'border-glass-border hover:border-glass-border-hover')}>
              <span className="flex items-center gap-2 text-xs font-semibold text-ink">
                <Icon className={cn('w-3.5 h-3.5', content === o.id ? 'text-indigo-500' : 'text-ink-muted')} /> {o.title}
              </span>
              <span className="block text-[11px] text-ink-muted mt-0.5">{o.desc}</span>
            </button>
          )
        })}
      </div>
      {reason && <p className="text-[11px] text-ink-muted mt-1.5">{reason}</p>}
    </div>
  )
}

function DataChoice({ single, scope, setScope, dataVersion, setDataVersion, hasDraft }: {
  single: boolean
  scope: PackageScope
  setScope: (s: PackageScope) => void
  dataVersion: PackageDataVersion
  setDataVersion: (v: PackageDataVersion) => void
  hasDraft: boolean
}) {
  if (!single) {
    return (
      <p className="rounded-xl bg-black/[0.03] dark:bg-white/[0.04] px-3.5 py-2.5 text-[11px] text-ink-muted">
        Several views share one package of the <span className="font-semibold text-ink-secondary">whole data source</span>, as published.
      </p>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="block text-xs font-medium text-ink-secondary mb-2">Which data</label>
        <div className="space-y-2">
          <Choice active={scope === 'view'} onClick={() => setScope('view')} title="This view's entities" desc="What the view shows, and how it connects." />
          <Choice active={scope === 'source'} onClick={() => setScope('source')} title="The whole data source" desc="Every entity and relationship in it." />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-ink-secondary mb-2">As it is</label>
        <div className="space-y-2">
          <Choice active={dataVersion === 'published'} onClick={() => setDataVersion('published')} title="Published" desc="The version everyone sees." />
          {hasDraft && (
            <Choice active={dataVersion === 'draft'} onClick={() => setDataVersion('draft')} title="In your draft" desc="With the changes you haven't published yet." />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Done ─────────────────────────────────────────────────────────────────────

function PackageDone({ result }: { result: ExportedPackage }) {
  return (
    <div className="px-8 py-10 max-w-2xl mx-auto flex items-start gap-4">
      <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500 flex items-center justify-center flex-shrink-0">
        <CheckCircle2 className="w-6 h-6" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-bold text-ink">Packaged</h3>
        <p className="text-sm text-ink-muted mt-1">
          Downloading <span className="font-medium text-ink break-all">{result.fileName}</span>
          {result.bytes ? <> ({fileSize(result.bytes)})</> : null}
          {result.nodes !== null ? <>, with {result.nodes.toLocaleString()} entities and {(result.edges ?? 0).toLocaleString()} relationships</> : null}.
          To bring it into another environment, open the View wizard there and choose <span className="font-medium text-ink">Import a view</span>:
          it goes into a draft there, data and view together.
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-glass-border px-3 py-2">
          <Fingerprint className="w-4 h-4 text-indigo-500 flex-shrink-0" />
          <span className="text-[11px] text-ink-muted">Views fingerprint</span>
          <span className="text-xs font-mono text-ink truncate" title={result.bundleHash}>{shortHash(result.bundleHash, 16)}</span>
        </div>
      </div>
    </div>
  )
}

function Done({ result, count }: { result: ExportedFile; count: number }) {
  const [copied, setCopied] = useState(false)
  const fingerprint = result.definitionHash ?? result.bundleHash
  const copy = async () => {
    if (!fingerprint) return
    try {
      await navigator.clipboard.writeText(fingerprint)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable — the hash is still on screen */ }
  }
  return (
    <div className="px-8 py-10 max-w-2xl mx-auto flex items-start gap-4">
      <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500 flex items-center justify-center flex-shrink-0">
        <CheckCircle2 className="w-6 h-6" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-bold text-ink">Downloaded</h3>
        <p className="text-sm text-ink-muted mt-1">
          Saved <span className="font-medium text-ink break-all">{result.filename}</span> ({fileSize(result.bytes)})
          {result.version ? <>, the view at <span className="font-medium text-ink">v{result.version}</span></> : count > 1 ? <>, {pluralize(count, 'view')}</> : null}.
          To bring it into another environment, open the View wizard there and choose <span className="font-medium text-ink">Import a view</span>.
        </p>
        {fingerprint && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-glass-border px-3 py-2">
            <Fingerprint className="w-4 h-4 text-indigo-500 flex-shrink-0" />
            <span className="text-[11px] text-ink-muted">Fingerprint</span>
            <span className="text-xs font-mono text-ink truncate" title={fingerprint}>{shortHash(fingerprint, 16)}</span>
            <button onClick={copy} className="ml-auto flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline">
              {copied ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

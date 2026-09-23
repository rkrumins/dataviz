/**
 * The Data step of importing a view with its data: the package's graph data goes into a new draft
 * of the target data source, before the view is checked against it.
 *
 * It starts when the person says so (it opens a draft and writes into it), then follows the
 * import job and shows what it did: new, updated, unchanged, and anything it couldn't apply. A
 * package's data only ever adds and updates; nothing here is deleted, and nothing is live until
 * the draft is published. The data goes with that one job, so taking it somewhere else afterwards
 * needs the file again.
 */
import type { ReactNode } from 'react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, DatabaseZap, Equal, FileUp, GitPullRequestDraft, Loader2, Lock,
  Pencil, Plus, RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImportPreviewRow } from '@/services/importExportApiService'
import { pluralize } from '@/features/view-transfer/format'
import { sameDataTarget, useImportSession, type PackageDataTarget } from './importSession'
import { useDraftStaging } from './useDraftStaging'

export function PackageDataStep({ target, targetLabel, onChooseFileAgain }: {
  target: PackageDataTarget
  targetLabel: string
  /** Back to the File step, the file set aside: a fresh upload of it can go anywhere. */
  onChooseFileAgain: () => void
}) {
  const session = useImportSession()!
  const staging = useDraftStaging(target.workspaceId, target.dataSourceId)
  const { data, pkg, view } = session
  const info = pkg?.info
  const nodes = info?.data?.nodes ?? null
  const edges = info?.data?.edges ?? null
  const draftName = `Import: ${view?.metadata.name ?? 'view'}`
  // What's shown is only ever about this target: a try elsewhere (the person went back and chose
  // another) doesn't count here.
  const mine = data.target && sameDataTarget(data.target, target) ? data : null
  const start = () => void session.startData({ ...target, draftName })

  const heading = (
    <div>
      <h3 className="text-xl font-bold text-ink">Bring in the data</h3>
      <p className="text-sm text-ink-muted mt-0.5">
        The package’s data goes into a new draft of {targetLabel}. The view follows it there, and nothing is live until the draft is published.
      </p>
    </div>
  )

  if (data.started && !mine) {
    return (
      <div className="space-y-5">
        {heading}
        <Notice tone="amber" icon={<AlertTriangle className="w-5 h-5" />} title="The data already went into another draft">
          <p>
            It went into “{data.started.draftName}”, with the view it was brought in for. To bring it in here instead,
            choose the file again. That draft is yours: abandon it from its data source if nothing in it is needed.
          </p>
          <ActionButton icon={<FileUp className="w-4 h-4" />} onClick={onChooseFileAgain}>Choose the file again</ActionButton>
        </Notice>
      </div>
    )
  }

  if (!mine && !staging.checking && (!staging.versioned || !staging.allowed)) {
    return (
      <div className="space-y-5">
        {heading}
        <Notice tone="slate" icon={<Lock className="w-5 h-5" />}
          title={staging.versioned ? 'You can’t open drafts on this data source' : 'This data source isn’t under version control'}>
          <p>
            {staging.versioned
              ? 'Bringing data into a draft of it needs permission to manage it. Ask a workspace admin, or go back and choose another data source.'
              : 'A package’s data can only arrive through a draft, so it needs a data source under version control. Go back and choose another, or import just the view from the File step.'}
          </p>
        </Notice>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {heading}

      <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="w-9 h-9 rounded-xl bg-violet-500/10 text-violet-500 flex items-center justify-center shrink-0">
            <DatabaseZap className="w-4.5 h-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">
              {nodes !== null && edges !== null
                ? `${pluralize(nodes, 'entity', 'entities')} and ${pluralize(edges, 'relationship')}`
                : 'The package’s data'}
            </p>
            <p className="text-[11px] text-ink-muted">
              {info?.scope === 'source' ? 'The whole data source it was exported from' : 'The entities of the view'}
              {info?.data?.version === 'draft' ? ', as it was in a draft there' : ', as published there'}
            </p>
          </div>
          <ArrowRight className="w-4 h-4 text-ink-muted shrink-0" />
          <div className="min-w-0 text-right">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink">
              <GitPullRequestDraft className="w-3.5 h-3.5 text-indigo-500" />
              <span className="truncate max-w-[16rem]" title={mine?.started?.draftName ?? draftName}>{mine?.started?.draftName ?? draftName}</span>
            </p>
            <p className="text-[11px] text-ink-muted truncate max-w-[18rem]">A new draft of {targetLabel}</p>
          </div>
        </div>
      </div>

      {mine?.preview ? (
        <DataImported />
      ) : mine?.running ? (
        <div className="py-10 flex flex-col items-center gap-4 text-center">
          <div className="relative w-16 h-16">
            <div className="absolute inset-0 rounded-full bg-violet-500/10 animate-ping" />
            <div className="relative w-16 h-16 rounded-full bg-violet-50 dark:bg-violet-950/40 flex items-center justify-center">
              <Loader2 className="w-7 h-7 text-violet-500 animate-spin" />
            </div>
          </div>
          <p className="text-sm font-semibold text-ink">
            {!mine.started ? 'Opening the draft…' : mine.job?.status === 'running' ? 'Bringing in the data…' : 'Waiting to start…'}
          </p>
          <p className="text-[11px] text-ink-muted max-w-sm">
            Each entity is matched to what’s already here: new ones are added, changed ones updated. You can keep this open; it runs on the server.
          </p>
        </div>
      ) : mine?.error ? (
        <Notice tone="rose" icon={<AlertTriangle className="w-5 h-5" />} title="The data couldn’t be brought in">
          <p>{mine.error}</p>
          {mine.started ? (
            <>
              <p>
                It runs again into the same draft, “{mine.started.draftName}”: only adding and updating, so nothing that did arrive is
                brought in twice. If the upload has expired, choose the file again. The draft is yours either way: abandon it from its
                data source if nothing in it is needed.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton icon={<RefreshCw className="w-4 h-4" />} onClick={start}>Try again</ActionButton>
                <ActionButton icon={<FileUp className="w-4 h-4" />} onClick={onChooseFileAgain}>Choose the file again</ActionButton>
              </div>
            </>
          ) : (
            <ActionButton icon={<RefreshCw className="w-4 h-4" />} onClick={start}>Try again</ActionButton>
          )}
        </Notice>
      ) : (
        <div className="rounded-2xl border-2 border-dashed border-violet-200 dark:border-violet-900/60 px-6 py-8 flex flex-col items-center gap-3 text-center">
          <p className="text-sm font-semibold text-ink">Ready to bring the data into a draft</p>
          <p className="text-[11px] text-ink-muted max-w-md leading-relaxed">
            It only adds and updates: nothing here is deleted, and nothing is live until the draft is published.
            The data goes with this draft; to bring it in anywhere else afterwards, you’d choose the file again.
          </p>
          <button type="button" onClick={start}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 shadow-sm shadow-violet-500/20">
            <DatabaseZap className="w-4 h-4" /> Bring the data into a draft
          </button>
        </div>
      )}
    </div>
  )
}

/** What the data import did, as the canvas's own import shows it. */
function DataImported() {
  const session = useImportSession()!
  const { preview, started } = session.data
  const s = preview?.summary ?? null
  const changes = s ? s.new + s.updated : 0
  const rows = (preview?.sample ?? []).slice(0, 8)
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-5 h-5" />
        </span>
        <div>
          <p className="text-sm font-bold text-ink">
            {s && changes === 0 ? 'The data here already matches the package' : 'The data is in the draft'}
          </p>
          <p className="text-[11px] text-ink-muted mt-0.5">
            {s && changes === 0
              ? 'Nothing needed changing. The view is checked against it next.'
              : `In “${started?.draftName}”, and nowhere else yet. Next, the view is checked against it.`}
          </p>
        </div>
      </div>
      {s && (
        <div className="grid grid-cols-4 gap-3">
          <Tile n={s.new} label="New" icon={<Plus className="w-4 h-4" />} tone="emerald" />
          <Tile n={s.updated} label="Updated" icon={<Pencil className="w-4 h-4" />} tone="blue" />
          <Tile n={s.unchanged} label="Unchanged" icon={<Equal className="w-4 h-4" />} tone="slate" />
          <Tile n={s.invalid} label="Needs fixing" icon={<AlertTriangle className="w-4 h-4" />} tone="amber" />
        </div>
      )}
      {s && s.invalid > 0 && (
        <p className="flex items-start gap-2 rounded-xl bg-amber-500/[0.07] border border-amber-500/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
          {pluralize(s.invalid, 'row')} couldn’t be applied; the draft’s import lists why. The view is checked against what did arrive.
        </p>
      )}
      {rows.length > 0 && (
        <div className="rounded-xl border border-glass-border overflow-hidden">
          <p className="px-4 py-2 border-b border-glass-border text-xs font-semibold text-ink bg-black/[0.02] dark:bg-white/[0.02]">A sample of what changed</p>
          <ul className="divide-y divide-glass-border">
            {rows.map(r => <PreviewRow key={r.rowIndex} row={r} />)}
          </ul>
        </div>
      )}
    </div>
  )
}

const ROW_STATUS: Record<string, { label: string; cls: string }> = {
  new: { label: 'New', cls: 'text-emerald-600 dark:text-emerald-400' },
  updated: { label: 'Updated', cls: 'text-blue-600 dark:text-blue-400' },
  unchanged: { label: 'Unchanged', cls: 'text-ink-muted' },
  invalid: { label: 'Skipped', cls: 'text-amber-600 dark:text-amber-400' },
}

function PreviewRow({ row }: { row: ImportPreviewRow }) {
  const status = ROW_STATUS[row.status ?? ''] ?? { label: row.status ?? '', cls: 'text-ink-muted' }
  return (
    <li className="flex items-start gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-ink truncate">{row.label || `Row ${row.rowIndex + 1}`}</span>
          <span className="text-[10px] uppercase tracking-wide text-ink-muted shrink-0">{row.kind === 'edge' ? 'relationship' : 'entity'}</span>
        </div>
        {row.status === 'invalid' && row.reasons?.[0] && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">{row.reasons[0]}</p>
        )}
      </div>
      <span className={cn('text-[10px] font-semibold uppercase tracking-wide shrink-0 mt-0.5', status.cls)}>{status.label}</span>
    </li>
  )
}

function Tile({ n, label, icon, tone }: { n: number; label: string; icon: ReactNode; tone: 'emerald' | 'blue' | 'slate' | 'amber' }) {
  const tones = {
    emerald: 'text-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/20',
    blue: 'text-blue-500 bg-blue-50/60 dark:bg-blue-950/20',
    slate: 'text-ink-muted bg-black/[0.02] dark:bg-white/[0.02]',
    amber: 'text-amber-500 bg-amber-50/60 dark:bg-amber-950/20',
  }
  const muted = n === 0
  return (
    <div className={cn('rounded-xl border border-glass-border p-3.5 flex flex-col gap-1', muted ? 'opacity-50' : tones[tone])}>
      <span className={muted ? 'text-ink-muted' : ''}>{icon}</span>
      <span className={cn('text-xl font-bold tabular-nums', muted ? 'text-ink-muted' : 'text-ink')}>{n.toLocaleString()}</span>
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">{label}</span>
    </div>
  )
}

function Notice({ tone, icon, title, children }: {
  tone: 'amber' | 'rose' | 'slate'
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  const cls = {
    amber: 'border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 text-amber-500',
    rose: 'border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/20 text-rose-500',
    slate: 'border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-ink-muted',
  }[tone]
  return (
    <div className={cn('flex items-start gap-3 rounded-2xl border px-4 py-4', cls)}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 space-y-2 text-xs text-ink-secondary leading-relaxed">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {children}
      </div>
    </div>
  )
}

function ActionButton({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600">
      {icon} {children}
    </button>
  )
}

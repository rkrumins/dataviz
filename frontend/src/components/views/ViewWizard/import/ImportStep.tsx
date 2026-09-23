/**
 * The Import journey's first step: choose the file, see what it holds, and say what to do with it.
 *
 * Two columns. The left says how importing works and what does (and doesn't) come across. The
 * right takes the file, shows what the server found in it (the view, its version, where it came
 * from, and whether it's exactly what was exported), and offers the actions that make sense for
 * it: updating the view here that it already is, a separate copy, a new view, or overwriting a
 * view of your choosing.
 *
 * A view with its data (a `.view-package.zip`) is taken in the same place: it then says what data
 * comes with the view, and that it comes through a draft.
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRightLeft, Check, CopyPlus, DatabaseZap, FileSearch, GitMerge, GitPullRequestDraft, Info, Layers,
  ListChecks, Loader2, PlusCircle, Replace, Search, ShieldAlert, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { listViews } from '@/services/viewApiService'
import type { IdentityMatch } from '@/services/viewTransferApiService'
import { BundleDropzone } from '@/features/view-transfer/BundleDropzone'
import { BundleSummaryCard } from '@/features/view-transfer/BundleSummaryCard'
import { pluralize, TONE_CHIP, UPDATE_STATUS_META } from '@/features/view-transfer/format'
import { useImportSession, type ImportTargetView } from './importSession'

export function ImportStep({ modeToggle }: { modeToggle?: ReactNode }) {
  const session = useImportSession()
  if (!session) return null
  const { inspect, view, pkg, withData } = session
  const environment = inspect?.bundle.generator.environment ?? null
  // A package vouches for itself too: every part it carries must check out.
  const integrity = inspect ? (pkg?.info.integrity === 'modified' ? 'modified' : inspect.integrity) : null

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-xl font-bold text-ink">
          {session.intoViewId ? 'Update this view from a file' : withData ? 'Import a view with its data' : 'Import a view'}
        </h3>
        <p className="text-ink-muted text-sm mt-1">
          {withData
            ? 'Bring in a view and the graph data it was exported with, through a draft of the data source you choose'
            : 'Bring in a view exported from another environment where the same data source is onboarded'}
        </p>
      </div>
      {modeToggle && <div className="flex justify-center">{modeToggle}</div>}

      <div className="grid md:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] gap-6">
        <HowItWorks withData={withData} />
        <div className="space-y-4 min-w-0">
          <BundleDropzone
            fileName={session.fileName}
            size={session.fileSize}
            busy={session.inspecting}
            error={session.inspectError?.message ?? null}
            integrity={integrity}
            environment={environment}
            packaged={!!pkg}
            onFile={(file) => { void session.loadFile(file) }}
          />

          {pkg && inspect && <PackageSummary />}

          {inspect && inspect.notices.length > 0 && (
            <div className="space-y-1.5">
              {inspect.notices.map((n, i) => (
                <p key={i} className="flex items-start gap-2 rounded-xl bg-amber-500/[0.07] border border-amber-500/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
                  <Info className="w-3.5 h-3.5 mt-px shrink-0" /> {n.message}
                </p>
              ))}
            </div>
          )}

          {inspect && inspect.views.length > 1 && !session.intoViewId && !withData && (
            <div className="inline-flex rounded-xl border border-glass-border p-1 bg-black/[0.02] dark:bg-white/[0.02]" role="group" aria-label="How many views to import">
              {([true, false] as const).map(all => (
                <button key={String(all)} type="button" aria-pressed={session.batch === all} onClick={() => session.setBatch(all)}
                  className={cn('px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                    session.batch === all ? 'bg-canvas-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink')}>
                  {all ? `All ${inspect.views.length} views` : 'One of them'}
                </button>
              ))}
            </div>
          )}

          {inspect && inspect.views.length > 1 && session.batch && <CollectionSummary />}

          {inspect && inspect.views.length > 1 && !session.batch && (
            <div>
              <p className="text-xs font-medium text-ink-secondary mb-2">
                {withData
                  ? `This package holds ${inspect.views.length} views. Its data goes into one draft with one of them: choose it. Import the others afterwards from this file, without the data.`
                  : `This file holds ${inspect.views.length} views. Choose the one to import:`}
              </p>
              <div className="rounded-xl border border-glass-border divide-y divide-glass-border max-h-48 overflow-y-auto">
                {inspect.views.map((v, i) => (
                  <button key={v.portableId + i} type="button" onClick={() => session.setViewIndex(i)}
                    className={cn('w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
                      i === session.viewIndex ? 'bg-indigo-50/60 dark:bg-indigo-950/20' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]')}>
                    <span className={cn('w-4 h-4 rounded-full border flex items-center justify-center shrink-0',
                      i === session.viewIndex ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-glass-border')}>
                      {i === session.viewIndex && <Check className="w-2.5 h-2.5" />}
                    </span>
                    <span className="text-xs font-medium text-ink truncate flex-1">{v.metadata.name}</span>
                    <span className="text-[10px] text-ink-muted shrink-0">{(v.manifest.counts?.assignments ?? 0).toLocaleString()} placements</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {view && inspect && !session.batch && <BundleSummaryCard view={view} bundle={inspect.bundle} />}
          {view && !session.batch && <ActionChoice />}
        </div>
      </div>
    </div>
  )
}

function HowItWorks({ withData }: { withData: boolean }) {
  const steps: Array<[ReactNode, string, string]> = withData ? [
    [<FileSearch key="f" className="w-4 h-4" />, 'Choose the package', 'A view with its data, exported from another environment. Every part is checked; nothing is saved yet.'],
    [<ArrowRightLeft key="t" className="w-4 h-4" />, 'Pick where it goes', 'A data source here under version control: the data can only arrive through a draft.'],
    [<DatabaseZap key="d" className="w-4 h-4" />, 'Bring in the data', 'Into a new draft of that data source. It only adds and updates; nothing here is deleted.'],
    [<ListChecks key="m" className="w-4 h-4" />, 'See what matched', 'Checked against the draft, so the entities the data just brought count as found.'],
    [<GitPullRequestDraft key="r" className="w-4 h-4" />, 'Review, then publish', 'The view joins its data in the draft. Publish the draft, or send it for review, and both go live together.'],
  ] : [
    [<FileSearch key="f" className="w-4 h-4" />, 'Choose the file', 'Any view file exported from another environment. It is read here; nothing is saved yet.'],
    [<ArrowRightLeft key="t" className="w-4 h-4" />, 'Pick where it goes', 'We suggest the data source here that holds the same graph, measured on the view’s own entities.'],
    [<ListChecks key="m" className="w-4 h-4" />, 'See what matched', 'Every entity the view places is looked up here. Anything not found is kept, marked, never lost.'],
    [<ShieldCheck key="r" className="w-4 h-4" />, 'Review and import', 'Rename it or change anything. The import is saved as a version you can go back to.'],
  ]
  return (
    <div className="rounded-2xl bg-gradient-to-br from-indigo-50/60 to-transparent dark:from-indigo-950/20 border border-glass-border p-5 space-y-4 h-fit">
      <p className="text-xs font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">How importing works</p>
      <ol className="space-y-3.5">
        {steps.map(([icon, title, body], i) => (
          <li key={title} className="flex items-start gap-3">
            <span className="relative w-7 h-7 rounded-lg bg-indigo-100/80 dark:bg-indigo-900/40 text-indigo-500 flex items-center justify-center shrink-0">
              {icon}
              <span className="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full bg-indigo-500 text-white text-[9px] font-bold flex items-center justify-center">{i + 1}</span>
            </span>
            <div>
              <p className="text-xs font-semibold text-ink">{title}</p>
              <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="rounded-xl bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2.5 text-[11px] text-ink-muted leading-relaxed">
        <span className="font-semibold text-ink-secondary">Comes across:</span> layers, placements, rules, display rules,
        settings, name and history{withData ? ', and the entities and relationships the package holds' : ''}.{' '}
        <span className="font-semibold text-ink-secondary">Doesn’t:</span> {withData ? '' : 'the graph data, '}sharing, favourites and drafts.
      </div>
    </div>
  )
}

// ── A view with its data ────────────────────────────────────────────────────

function PackageSummary() {
  const session = useImportSession()!
  const info = session.pkg!.info
  const nodes = info.data?.nodes ?? null
  const edges = info.data?.edges ?? null
  const unchecked = Object.entries(info.parts).filter(([, part]) => !part.verified).map(([name]) => name)
  const scope = info.scope === 'source' ? 'the whole data source' : 'the entities of the view'
  const version = info.data?.version === 'draft' ? 'as it was in a draft' : 'as published'
  return (
    <div className="rounded-2xl border border-violet-200/70 dark:border-violet-900/60 bg-gradient-to-br from-violet-50/60 to-transparent dark:from-violet-950/20 overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3">
        <span className="w-9 h-9 rounded-xl bg-violet-500/10 text-violet-500 flex items-center justify-center shrink-0">
          <DatabaseZap className="w-4.5 h-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">With its data</p>
          <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
            {nodes !== null && edges !== null
              ? <>{pluralize(nodes, 'entity', 'entities')} and {pluralize(edges, 'relationship')}: {scope}, {version}.</>
              : <>The data of {scope}, {version}.</>}
          </p>
          {unchecked.length > 0 ? (
            <p className="flex items-start gap-1.5 mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0" />
              Changed after it was exported: {unchecked.join(', ')}. It imports as it is now.
            </p>
          ) : (
            <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" /> Every part checks out against the package’s fingerprints
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-violet-200/60 dark:border-violet-900/40 px-4 py-2.5">
        <div className="inline-flex rounded-xl border border-glass-border p-1 bg-canvas-elevated" role="radiogroup" aria-label="What to import">
          {([true, false] as const).map(on => (
            <button key={String(on)} type="button" role="radio" aria-checked={session.withData === on}
              onClick={() => session.setWithData(on)}
              className={cn('px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                session.withData === on ? 'bg-violet-500 text-white shadow-sm' : 'text-ink-muted hover:text-ink')}>
              {on ? 'View and data' : 'View only'}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          {session.withData
            ? 'The data goes into a draft first, and the view follows it there.'
            : 'Just the view, as from a view file: for where the data is already here.'}
        </p>
      </div>
    </div>
  )
}

// ── A file of several views ─────────────────────────────────────────────────

function CollectionSummary() {
  const session = useImportSession()!
  const inspect = session.inspect!
  const environment = inspect.bundle.generator.environment
  const exists = inspect.views.filter(v => (inspect.identityMatches[v.portableId] ?? []).some(m => m.canEdit)).length
  return (
    <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
      <div className="px-4 py-3 border-b border-glass-border">
        <p className="text-sm font-bold text-ink">{inspect.views.length} views{environment ? ` from ${environment}` : ''}</p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          {exists ? `${exists} already here and will be updated; ` : ''}
          {inspect.views.length - exists} new. You choose where each source goes, check them all at once, then review each one.
        </p>
      </div>
      <ul className="max-h-60 overflow-y-auto divide-y divide-glass-border">
        {inspect.views.map(v => {
          const match = (inspect.identityMatches[v.portableId] ?? []).find(m => m.canEdit)
          const status = match ? UPDATE_STATUS_META[match.status] : null
          return (
            <li key={`${v.portableId}-${v.index}`} className="flex items-center gap-3 px-4 py-2">
              <span className="text-xs font-medium text-ink truncate flex-1" title={v.metadata.name}>{v.metadata.name}</span>
              <span className="text-[10px] text-ink-muted shrink-0">{(v.manifest.counts?.assignments ?? 0).toLocaleString()} placements</span>
              {match && status ? (
                <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0', TONE_CHIP[status.tone])}
                  title={`${match.name} in ${match.workspaceName ?? 'a workspace'}: ${status.detail}`}>
                  Here{match.headVersion ? ` · v${match.headVersion}` : ''} · {status.label}
                </span>
              ) : (
                <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0', TONE_CHIP.indigo)}>New</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── What to do with it ──────────────────────────────────────────────────────

function ActionChoice() {
  const session = useImportSession()!
  const { matches, action, targetView, intoViewId } = session
  const editable = matches.filter(m => m.canEdit)
  const readOnly = matches.filter(m => !m.canEdit)
  const [picking, setPicking] = useState(action === 'overwrite' && !targetView)

  const isTarget = (m: IdentityMatch) => action === 'update' && targetView?.viewId === m.viewId
  const pinned = intoViewId !== null

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-ink-secondary">What should happen</p>

      {editable.filter(m => !pinned || m.viewId === intoViewId).map(m => {
        const status = UPDATE_STATUS_META[m.status]
        return (
          <ActionCard key={m.viewId} active={isTarget(m)} recommended={!pinned && m === editable[0]}
            icon={<GitMerge className="w-4 h-4" />}
            title={`Update “${m.name}”`}
            detail={`${m.workspaceName ?? 'A workspace'}${m.dataSourceName ? ` · ${m.dataSourceName}` : ''}${m.headVersion ? ` · v${m.headVersion} here` : ''}. It is this view, so the file becomes its next version.`}
            chip={<span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', TONE_CHIP[status.tone])} title={status.detail}>{status.label}</span>}
            onClick={() => session.choose('update', toTarget(m))} />
        )
      })}

      {readOnly.length > 0 && !pinned && (
        <p className="text-[11px] text-ink-muted px-1">
          Also here, but you can’t edit {readOnly.length === 1 ? 'it' : 'them'}: {readOnly.map(m => `“${m.name}” (${m.workspaceName ?? 'a workspace'})`).join(', ')}.
        </p>
      )}

      {!pinned && (
        <ActionCard active={action === 'create' || action === 'copy'}
          recommended={editable.length === 0}
          icon={matches.length ? <CopyPlus className="w-4 h-4" /> : <PlusCircle className="w-4 h-4" />}
          title={matches.length ? 'Import as a separate copy' : 'Create a new view'}
          detail={matches.length
            ? 'A new view with its own identity. Later files of this view won’t update it.'
            : 'Pick the workspace and data source next. You can rename it on the way in.'}
          onClick={() => session.choose(matches.length ? 'copy' : 'create')} />
      )}

      <ActionCard active={action === 'overwrite'}
        icon={<Replace className="w-4 h-4" />}
        title={pinned && action === 'overwrite' && targetView ? `Overwrite “${targetView.name}”` : 'Overwrite an existing view…'}
        detail={pinned && action === 'overwrite'
          ? 'It isn’t this view, so the file replaces its design. Its current design is kept as a version first.'
          : 'Replace another view’s design with this one. Its current design is kept as a version first.'}
        onClick={() => { if (!pinned) { setPicking(true); session.choose('overwrite', targetView && action === 'overwrite' ? targetView : null) } }} />

      {!pinned && action === 'overwrite' && (picking || !targetView) && (
        <OverwritePicker exclude={matches.map(m => m.viewId)} onPick={(t) => { session.choose('overwrite', t); setPicking(false) }} />
      )}
      {!pinned && action === 'overwrite' && targetView && !picking && (
        <div className="flex items-center gap-2 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/40 dark:bg-indigo-950/20 px-3 py-2">
          <Layers className="w-3.5 h-3.5 text-indigo-500" />
          <span className="text-xs text-ink truncate flex-1">Overwriting <span className="font-semibold">{targetView.name}</span>{targetView.workspaceName ? ` in ${targetView.workspaceName}` : ''}</span>
          <button type="button" onClick={() => setPicking(true)} className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">Change</button>
        </div>
      )}
    </div>
  )
}

function toTarget(m: IdentityMatch): ImportTargetView {
  return {
    viewId: m.viewId, name: m.name, workspaceId: m.workspaceId, workspaceName: m.workspaceName,
    dataSourceId: m.dataSourceId ?? null, dataSourceName: m.dataSourceName, headVersion: m.headVersion, canEdit: m.canEdit,
  }
}

function ActionCard({ active, recommended, icon, title, detail, chip, onClick }: {
  active: boolean
  recommended?: boolean
  icon: ReactNode
  title: string
  detail: string
  chip?: ReactNode
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('w-full text-left flex items-start gap-3 rounded-xl border-2 px-3.5 py-3 transition-colors',
        active ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
          : 'border-glass-border hover:border-glass-border-hover')}>
      <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
        active ? 'bg-indigo-500 text-white' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 min-w-0">
          <span className={cn('text-xs font-semibold truncate', active ? 'text-ink' : 'text-ink-secondary')}>{title}</span>
          {recommended && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Recommended</span>}
          {chip && <span className="ml-auto shrink-0">{chip}</span>}
        </span>
        <span className="block text-[11px] text-ink-muted mt-0.5 leading-relaxed">{detail}</span>
      </span>
    </button>
  )
}

function OverwritePicker({ exclude, onPick }: { exclude: string[]; onPick: (target: ImportTargetView) => void }) {
  const [search, setSearch] = useState('')
  const term = useDebouncedValue(search.trim(), 250)
  const { data, isFetching } = useQuery({
    queryKey: ['import-overwrite-picker', term],
    queryFn: () => listViews({ search: term || undefined, limit: 8, sort: 'updated' }),
    staleTime: 30_000,
  })
  const items = (data?.items ?? []).filter(v => !exclude.includes(v.id))
  return (
    <div className="rounded-xl border border-glass-border overflow-hidden">
      <div className="relative border-b border-glass-border">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
        <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search views you can edit…"
          aria-label="Search views to overwrite"
          className="w-full pl-9 pr-3 py-2 text-xs bg-transparent text-ink placeholder:text-ink-muted outline-none" />
        {isFetching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-ink-muted" />}
      </div>
      <ul className="max-h-52 overflow-y-auto divide-y divide-glass-border">
        {items.map(v => (
          <li key={v.id}>
            <button type="button" onClick={() => onPick({
              viewId: v.id, name: v.name, workspaceId: v.workspaceId, workspaceName: v.workspaceName,
              dataSourceId: v.dataSourceId ?? null, dataSourceName: v.dataSourceName,
            })} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
              <span className="text-xs font-medium text-ink truncate flex-1">{v.name}</span>
              <span className="text-[10px] text-ink-muted truncate max-w-[45%]">{v.workspaceName}{v.dataSourceName ? ` · ${v.dataSourceName}` : ''}</span>
            </button>
          </li>
        ))}
        {!isFetching && items.length === 0 && <li className="px-3 py-3 text-[11px] text-ink-muted">No views match.</li>}
      </ul>
    </div>
  )
}

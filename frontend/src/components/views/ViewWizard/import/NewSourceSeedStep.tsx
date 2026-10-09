/**
 * The Data step of importing a view package into a brand-new data source: the data source is
 * created as the Target step described it, and the package's data is copied into it in full.
 *
 * One request makes it, under a request id kept for the file in this browser (rememberNewSource):
 * a wizard closed meanwhile, or a page reloaded, finds the same data source again — never a second
 * one. The copy is a job on the server (the data source's own "enable version control" job, over
 * the package), followed with the same progress card the data source shows; it carries on when
 * this closes. Once it has checked out, the package's views come next, into the new data source.
 * "Finish importing views" opens here too, on a data source a package already made (`attached`).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowRight, Database, DatabaseZap, FileUp, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { useWorkspacesStore } from '@/store/workspaces'
import { useOntologies } from '@/features/ontology/hooks/useOntologies'
import { useBootstrapStatus } from '@/features/versioning/hooks/useVersioning'
import { BootstrapProgress } from '@/features/versioning/components/BootstrapProgress'
import {
  ViewTransferError, createNewSourceFromPackage, newSourceRequestId, rememberNewSource, rememberedNewSource,
  type NewSourceRequest, type RememberedNewSource,
} from '@/services/viewTransferApiService'
import { pluralize } from '@/features/view-transfer/format'
import { useImportSession, type NewDataTarget } from './importSession'

type Into = { workspaceId: string; dataSourceId: string }

export function NewSourceSeedStep({
  steps, target, providerName, attached, onBack, onClose, onSeeded, onChooseFileAgain, onUseGraphName,
}: {
  steps: WizardStepDef[]
  /** The new data source the Target step described; null when opened on one made already. */
  target: NewDataTarget | null
  providerName?: string | null
  /** "Finish importing views": the data source this package was already copied into. */
  attached?: Into | null
  onBack: () => void
  onClose: () => void
  /** The copy checked out: the package's views go into it next. */
  onSeeded: (into: Into) => void
  /** The package's upload is gone: back to the File step, the file set aside. */
  onChooseFileAgain: () => void
  /** The graph name was taken meanwhile: take the free one the server offered. */
  onUseGraphName: (graphName: string) => void
}) {
  const session = useImportSession()!
  const fileKey = session.fileKey
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const ontologies = useOntologies()
  const [record, setRecord] = useState<RememberedNewSource | null>(() => (fileKey ? rememberedNewSource(fileKey) : null))
  /** A data source made already: by this package before ("upload_consumed"), or from the banner. */
  const [adopted, setAdopted] = useState<Into | null>(attached ?? null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const into: Into | null = adopted
    ?? (record?.started && record.request
      ? { workspaceId: record.request.workspaceId, dataSourceId: record.started.dataSourceId }
      : null)
  const status = useBootstrapStatus(into?.workspaceId, into?.dataSourceId, { enabled: !!into })
  const job = status.data ?? null
  const views = session.inspect?.views.length ?? 0

  /** Ask for the data source, remembered for the file before and after: a refusal leaves nothing
   *  in flight; any other failure may have lost an answer, so it stays `sending`, to ask again. */
  const send = useCallback(async (request: NewSourceRequest) => {
    if (!session.pkg || !fileKey) return
    const keep = (r: RememberedNewSource) => {
      rememberNewSource(fileKey, r)
      if (alive.current) setRecord(r)
    }
    setSending(true)
    setError(null)
    keep({ requestId: request.requestId, request, sending: true })
    try {
      const started = await createNewSourceFromPackage(session.pkg.uploadId, request)
      keep({ requestId: request.requestId, request, started })
    } catch (err) {
      if (err instanceof ViewTransferError) keep({ requestId: request.requestId, request })
      if (alive.current) setError(err)
    } finally {
      if (alive.current) setSending(false)
    }
  }, [session.pkg, fileKey])

  // An answer a closed page never heard: asked again under the same id, it is the same data source.
  // Only what was remembered when this opened — a request sent from here is already being heard.
  const interrupted = useRef(record?.sending && !record.started ? record.request ?? null : null)
  useEffect(() => {
    const request = interrupted.current
    if (!request || adopted || !session.pkg) return
    interrupted.current = null
    void send(request)
  }, [adopted, session.pkg, send])

  /** Given up (the new data source is removed): this file may make one afresh, under a new request
   *  id — the old request's answer is the data source that is gone. */
  const forget = useCallback(() => {
    if (fileKey) rememberNewSource(fileKey, null)
    setRecord(null)
    setAdopted(null)
  }, [fileKey])

  const create = () => {
    if (!target) return
    void send({
      requestId: record?.requestId ?? newSourceRequestId(),
      workspaceId: target.workspaceId,
      providerId: target.providerId,
      label: target.label,
      graphName: target.graphName,
      ontologyId: target.ontologyId,
    })
  }

  const finish = () => {
    if (!into) return
    if (fileKey) rememberNewSource(fileKey, null)
    onSeeded(into)
  }

  const layerName = target?.ontologyId
    ? ontologies.data?.find(o => o.id === target.ontologyId)?.name ?? 'The chosen semantic layer'
    : 'No semantic layer'
  const nodes = session.pkg?.info.data?.nodes ?? null
  const edges = session.pkg?.info.data?.edges ?? null
  const done = job?.status === 'completed'
  const stepIndex = Math.max(0, steps.findIndex(s => s.id === 'data'))

  return (
    <WizardShell
      title="Import View"
      submitLabel="Import View"
      currentStep="data"
      activeSteps={steps}
      currentStepIndex={stepIndex}
      onStepClick={(id) => { if (id === steps[stepIndex - 1]?.id) onBack() }}
      onBack={onBack}
      onNext={finish}
      onClose={onClose}
      canProceed={done && !!session.inspect}
      isLastStep={false}
      isSubmitting={false}
      onSubmit={() => {}}
      wide
    >
      <div className="space-y-5">
        <div>
          <h3 className="text-xl font-bold text-ink">Copy the data into a new data source</h3>
          <p className="text-sm text-ink-muted mt-0.5">
            The data source is created, and the package’s data copied into it in full and checked. Its views follow it there.
          </p>
        </div>

        {into ? (
          <>
            {job?.status === 'cancelled' ? (
              <Notice tone="amber" title="The copy was given up">
                <p>Its data source was removed. Create a new one to copy the package into it.</p>
                <Action icon={<RefreshCw className="w-4 h-4" />} onClick={forget}>Start afresh</Action>
              </Notice>
            ) : job ? (
              <BootstrapProgress job={job} wsId={into.workspaceId} dataSourceId={into.dataSourceId} variant="card"
                onAbandoned={forget} />
            ) : status.isError ? (
              <Notice tone="rose" title="The copy’s progress couldn’t be read">
                <p>{status.error instanceof Error ? status.error.message : 'Try again in a moment.'}</p>
                <p>If its data source was given up meanwhile, start afresh: a new one is created.</p>
                <div className="flex items-center gap-2">
                  <Action icon={<RefreshCw className="w-4 h-4" />} onClick={() => void status.refetch()}>Check again</Action>
                  {target && (
                    <button type="button" onClick={forget}
                      className="px-3 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                      Start afresh
                    </button>
                  )}
                </div>
              </Notice>
            ) : (
              <Waiting text="Starting the copy…" />
            )}
            <p className="text-[11px] text-ink-muted">
              {done
                ? `Next, ${views > 1 ? `its ${pluralize(views, 'view')} go` : 'its view goes'} into it, live.`
                : 'You can close this: the copy carries on on the server, and the data source shows how far it has got. Its views can be imported from there once it’s done.'}
            </p>
          </>
        ) : sending ? (
          <Waiting text="Creating the data source…" />
        ) : (
          <>
            {target && (
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
                    <p className="text-[11px] text-ink-muted">All of it, as the package holds it</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-ink-muted shrink-0" />
                  <div className="min-w-0 text-right">
                    <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink">
                      <Database className="w-3.5 h-3.5 text-indigo-500" />
                      <span className="truncate max-w-[16rem]" title={target.label}>{target.label}</span>
                    </p>
                    <p className="text-[11px] text-ink-muted truncate max-w-[20rem]">
                      <span className="font-mono">{target.graphName}</span>{providerName ? ` on ${providerName}` : ''} · {layerName}
                    </p>
                  </div>
                </div>
              </div>
            )}
            {error ? (
              <Refusal error={error} workspaces={workspaces} onRetry={create} onBack={onBack}
                onChooseFileAgain={onChooseFileAgain}
                onUseGraphName={(name) => { setError(null); onUseGraphName(name) }}
                onAdopt={(found) => { setError(null); setAdopted(found) }} />
            ) : !target ? (
              <Notice tone="amber" title="There is no data source to copy into">
                <p>It was given up and removed. Describe a new one on the Target step to copy the package into it.</p>
                <Action icon={<ArrowRight className="w-4 h-4" />} onClick={onBack}>Back to the target</Action>
              </Notice>
            ) : (
              <div className="rounded-2xl border-2 border-dashed border-violet-200 dark:border-violet-900/60 px-6 py-8 flex flex-col items-center gap-3 text-center">
                <p className="text-sm font-semibold text-ink">Ready to create it</p>
                <p className="text-[11px] text-ink-muted max-w-md leading-relaxed">
                  It becomes a data source of its own, under version control from the start. Nothing here, and nothing where the
                  package was exported from, is changed.
                </p>
                <button type="button" onClick={create}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 shadow-sm shadow-violet-500/20">
                  <DatabaseZap className="w-4 h-4" /> Create the data source and copy the data
                </button>
              </div>
            )}
          </>
        )}

        {attached && session.inspecting && <Waiting text="Reading the package…" />}
        {attached && session.inspectError && (
          <Notice tone="amber" title="The package can’t be read again">
            <p>{session.inspectError.message} Import its views from the file instead.</p>
            <Action icon={<FileUp className="w-4 h-4" />} onClick={onChooseFileAgain}>Choose the file</Action>
          </Notice>
        )}
      </div>
    </WizardShell>
  )
}

/** Why the data source wasn't created, and what can be done about it. */
function Refusal({ error, workspaces, onRetry, onBack, onChooseFileAgain, onUseGraphName, onAdopt }: {
  error: unknown
  workspaces: ReturnType<typeof useWorkspacesStore.getState>['workspaces']
  onRetry: () => void
  onBack: () => void
  onChooseFileAgain: () => void
  onUseGraphName: (name: string) => void
  onAdopt: (into: Into) => void
}) {
  const refusal = error instanceof ViewTransferError ? error : null
  const message = error instanceof Error ? error.message : 'The data source couldn’t be created.'
  const suggestion = typeof refusal?.detail?.suggestion === 'string' ? refusal.detail.suggestion : null
  const consumedId = typeof refusal?.detail?.dataSourceId === 'string' ? refusal.detail.dataSourceId : null
  let consumed: (Into & { name: string }) | null = null
  for (const ws of workspaces) {
    const ds = consumedId ? ws.dataSources?.find(d => d.id === consumedId) : undefined
    if (ds) consumed = { workspaceId: ws.id, dataSourceId: ds.id, name: `${ws.name} · ${ds.label || ds.id}` }
  }

  if (refusal?.status === 410 || refusal?.type === 'upload_expired') {
    return (
      <Notice tone="amber" title="The package’s upload has expired">
        <p>The server keeps an uploaded package for a day, and this one has run out of time. Choose the file again: it goes up afresh.</p>
        <Action icon={<FileUp className="w-4 h-4" />} onClick={onChooseFileAgain}>Choose the file again</Action>
      </Notice>
    )
  }
  if (refusal?.type === 'graph_name_unavailable') {
    return (
      <Notice tone="amber" title="That graph name was taken meanwhile">
        <p>{message}</p>
        {suggestion
          ? <Action icon={<RefreshCw className="w-4 h-4" />} onClick={() => onUseGraphName(suggestion)}>Use {suggestion}</Action>
          : <Action icon={<ArrowRight className="w-4 h-4" />} onClick={onBack}>Choose another name</Action>}
      </Notice>
    )
  }
  if (refusal?.type === 'upload_consumed') {
    return (
      <Notice tone="amber" title="This package already made a data source">
        <p>
          {consumed ? `It went into “${consumed.name}”.` : message} One package makes one new data source; its views can go
          into that one.
        </p>
        {consumed && (
          <Action icon={<ArrowRight className="w-4 h-4" />}
            onClick={() => onAdopt({ workspaceId: consumed.workspaceId, dataSourceId: consumed.dataSourceId })}>
            Continue with it
          </Action>
        )}
      </Notice>
    )
  }
  const fixedOnTarget = ['provider_unsupported', 'provider_unreachable', 'ontology_unknown', 'ds_has_other_job', 'not_inspected']
  return (
    <Notice tone="rose" title="The data source couldn’t be created">
      <p>{message}</p>
      {refusal?.type && fixedOnTarget.includes(refusal.type)
        ? <Action icon={<ArrowRight className="w-4 h-4" />} onClick={onBack}>Back to the target</Action>
        : <Action icon={<RefreshCw className="w-4 h-4" />} onClick={onRetry}>Try again</Action>}
    </Notice>
  )
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="py-8 flex flex-col items-center gap-3 text-center">
      <Loader2 className="w-7 h-7 text-violet-500 animate-spin" />
      <p className="text-sm font-semibold text-ink">{text}</p>
    </div>
  )
}

function Notice({ tone, title, children }: { tone: 'amber' | 'rose'; title: string; children: ReactNode }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-2xl border px-4 py-4',
      tone === 'amber'
        ? 'border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 text-amber-500'
        : 'border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/20 text-rose-500')}>
      <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
      <div className="min-w-0 space-y-2 text-xs text-ink-secondary leading-relaxed">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {children}
      </div>
    </div>
  )
}

function Action({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600">
      {icon} {children}
    </button>
  )
}

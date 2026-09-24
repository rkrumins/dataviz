/**
 * SubsetCreateWizard — the last mile of the Subset Studio: name the subset,
 * choose who sees it, look over what it will hold, and make it.
 *
 * Built on the house wizard chrome (WizardShell) so it reads like every other
 * create in the app, with creating as its terminal step: one server-side
 * write (`POST /views/{id}/subsets`), then the new view opens on its own
 * unless the reader says otherwise. Picking "Everyone" without the right to
 * publish creates the view for the workspace and files the request, exactly
 * as the view wizard does.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Info, Layers, PencilLine, ScissorsLineDashed, Send, Tag, Waypoints, X } from 'lucide-react'

import { WizardShell } from '@/components/wizard/WizardShell'
import {
  CreationBusyFooter, CreationErrorFooter, CreationProgressBody, CreationSuccessBody, CreationSuccessFooter,
  useAutoOpenCountdown, type CreationStage, type CreationSummaryStat,
} from '@/components/views/ViewWizard/CreationPhase'
import { VisibilityImpact } from '@/components/views/VisibilityImpact'
import { useAppNotifications } from '@/components/ui/notifications'
import { usePublishGate } from '@/hooks/usePublishGate'
import { useViewAudience } from '@/hooks/useViewAudience'
import { buildVisibilityOptions, type ViewVisibility } from '@/lib/viewVisibility'
import { cn } from '@/lib/utils'
import { createSubsetView, requestViewPublication, viewToViewConfig, type View } from '@/services/viewApiService'
import { useBrand } from '@/store/branding'
import { useSchemaStore } from '@/store/schema'

import type { LineageBridgesState } from '../hooks/useLineageBridges'
import { summarizeConnectivity } from '../model/connectivity'
import { orderedPicks, useSubsetStudioStore } from '../model/studioStore'
import { subsetRequest } from '../model/subsetRequest'
import { LayerDot, Tile, type StudioLayer } from './studio/atoms'

const NAME_MAX = 200
const TAGS_MAX = 50

export interface SubsetSource {
  id: string
  name: string
  workspaceId?: string
  workspaceName?: string
  dataSourceId?: string | null
}

type Step = 'details' | 'review'

const STEPS = [
  { id: 'details', label: 'Details & audience', icon: <PencilLine className="w-6 h-6" /> },
  { id: 'review', label: 'Review', icon: <ClipboardCheck className="w-6 h-6" /> },
]

export function SubsetCreateWizard({ source, layers, preview, onClose }: {
  source: SubsetSource
  layers: readonly StudioLayer[]
  /** The studio's live preview of how the picks connect. */
  preview: LineageBridgesState
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useAppNotifications()
  const { appName } = useBrand()

  const picks = useSubsetStudioStore((s) => s.picks)
  const order = useSubsetStudioStore((s) => s.order)
  const maxHops = useSubsetStudioStore((s) => s.maxHops)
  const keepGroups = useSubsetStudioStore((s) => s.keepGroups)
  const list = useMemo(() => orderedPicks({ picks, order }), [picks, order])

  const [step, setStep] = useState<Step>('details')
  const [phase, setPhase] = useState<'form' | 'creating' | 'success'>('form')
  const [name, setName] = useState(`${source.name} — subset`)
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [visibility, setVisibility] = useState<ViewVisibility>('private')
  const [publishNote, setPublishNote] = useState('')
  const [stage, setStage] = useState<CreationStage['state']>('pending')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const createdRef = useRef<View | null>(null)
  const [summary, setSummary] = useState<CreationSummaryStat[]>([])

  const gate = usePublishGate(source.workspaceId, source.dataSourceId)
  const options = buildVisibilityOptions({
    canRequestPublish: gate.canRequestPublish,
    canPublish: gate.canPublish,
    restrictedSource: gate.restrictedSource,
    blockedBy: gate.blockedBy,
    enterpriseAvailable: gate.enterpriseAvailable,
    appName,
    workspaceName: source.workspaceName,
  })
  const selectedOption = options.find(o => o.id === visibility)
  const audience = useViewAudience(source.workspaceId)

  const connectivity = useMemo(
    () => summarizeConnectivity(order, preview.links, preview.incomplete),
    [order, preview.links, preview.incomplete],
  )
  const perLayer = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of list) {
      const names = m.get(p.layerId)
      if (names) names.push(p.label)
      else m.set(p.layerId, [p.label])
    }
    return m
  }, [list])

  const trimmedName = name.trim()
  const nameError = trimmedName.length === 0
    ? 'Give the subset a name'
    : trimmedName.length > NAME_MAX ? `At most ${NAME_MAX} characters` : null

  const addTag = () => {
    const t = tagInput.trim()
    if (!t || tags.includes(t) || tags.length >= TAGS_MAX) { setTagInput(''); return }
    setTags([...tags, t])
    setTagInput('')
  }

  const submit = useCallback(async () => {
    if (nameError || list.length === 0) return
    const wantsPublication = visibility === 'enterprise' && !gate.canPublish
    setPhase('creating')
    setStage('active')
    setSubmitError(null)
    try {
      const view = await createSubsetView(source.id, subsetRequest({
        name, description, tags, picks: list, keepGroups, maxHops,
        visibility: wantsPublication ? 'workspace' : visibility,
      }))
      createdRef.current = view
      if (wantsPublication) {
        try {
          await requestViewPublication(view.id, publishNote.trim() || undefined)
          notify('success', 'Subset created — your publication request was sent to your workspace admins')
        } catch {
          notify('error', "Subset created, but the publication request couldn't be sent. You can ask again from Share.")
        }
      }
      useSchemaStore.getState().addOrUpdateView(viewToViewConfig(view))
      void queryClient.invalidateQueries({ queryKey: ['views'] })
      setSummary([
        { label: 'Entities', value: list.length },
        { label: 'Layers', value: perLayer.size },
        { label: 'Virtual hops', value: connectivity.virtual.length },
        { label: 'Visibility', value: wantsPublication ? 'workspace' : visibility },
      ])
      // The picks have become a view: the studio's work is done.
      useSubsetStudioStore.getState().close({ discard: true })
      setStage('done')
      setPhase('success')
    } catch (err) {
      setStage('failed')
      setSubmitError(err instanceof Error ? err.message : 'The subset could not be created. Please try again.')
    }
  }, [nameError, list, visibility, gate.canPublish, source.id, name, description, tags, keepGroups, maxHops, publishNote, notify, queryClient, perLayer.size, connectivity.virtual.length])

  const openNow = useCallback(() => {
    const view = createdRef.current
    if (view) navigate(`/views/${view.id}`)
    onClose()
  }, [navigate, onClose])
  const countdown = useAutoOpenCountdown({ enabled: phase === 'success', onFire: openNow })

  const stepIndex = step === 'details' ? 0 : 1
  const terminal = phase === 'form' ? undefined : phase

  const footer = phase === 'creating'
    ? (submitError
      ? <CreationErrorFooter onBack={() => { setPhase('form'); setStep('review') }} onRetry={() => { void submit() }} />
      : <CreationBusyFooter />)
    : phase === 'success'
      ? <CreationSuccessFooter remaining={countdown.remaining} onOpenNow={openNow} onStayHere={() => { countdown.cancel(); onClose() }} />
      : undefined

  return createPortal(
    <WizardShell
      title="Save as a subset view"
      submitLabel="Create subset"
      currentStep={step}
      activeSteps={STEPS}
      currentStepIndex={stepIndex}
      onStepClick={(id) => setStep(id as Step)}
      onBack={() => setStep('details')}
      onNext={() => setStep('review')}
      onClose={onClose}
      canProceed={!nameError && list.length > 0}
      isLastStep={step === 'review'}
      isSubmitting={phase === 'creating'}
      onSubmit={() => { void submit() }}
      terminalPhase={terminal}
      terminalLabel="Create"
      terminalSubtitle={phase === 'success' ? 'Your subset is ready' : 'Creating the subset'}
      footer={footer}
      hideClose={phase === 'creating' && !submitError}
    >
      {phase === 'creating' && (
        <CreationProgressBody
          viewName={trimmedName}
          error={submitError}
          stages={[{
            id: 'create',
            label: 'Creating the subset view',
            detail: `${list.length.toLocaleString()} entities from ${source.name}, lineage kept connected`,
            state: stage,
          }]}
        />
      )}

      {phase === 'success' && (
        <CreationSuccessBody viewName={trimmedName} scopeLabel={`Subset of ${source.name}`} isBlank={false} stats={summary} />
      )}

      {phase === 'form' && step === 'details' && (
        <div className="max-w-2xl mx-auto space-y-6">
          <div>
            <label htmlFor="subset-name" className="block text-sm font-semibold text-ink mb-1.5">Name</label>
            <input
              id="subset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX + 20}
              aria-invalid={!!nameError}
              aria-describedby="subset-name-hint"
              autoFocus
              className="w-full px-4 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.08] dark:border-white/[0.08] text-[14px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-explore/40 focus:border-accent-explore/50"
            />
            <p id="subset-name-hint" className={cn('mt-1 text-xs', nameError ? 'text-red-600 dark:text-red-400' : 'text-ink-muted')}>
              {nameError ?? 'What your audience will look for it by.'}
            </p>
          </div>

          <div>
            <label htmlFor="subset-description" className="block text-sm font-semibold text-ink mb-1.5">
              Description <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <textarea
              id="subset-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Who is it for, and what does it show?"
              className="w-full px-4 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.08] dark:border-white/[0.08] text-[13px] text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent-explore/40 resize-none"
            />
          </div>

          <div>
            <label htmlFor="subset-tags" className="block text-sm font-semibold text-ink mb-1.5">
              Tags <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.08] dark:border-white/[0.08] focus-within:ring-2 focus-within:ring-accent-explore/40">
              {tags.map(t => (
                <span key={t} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-accent-explore/10 text-accent-explore text-[12px]">
                  <Tag className="w-3 h-3" aria-hidden="true" />{t}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter(x => x !== t))} className="p-0.5 rounded-full hover:bg-accent-explore/15">
                    <X className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              <input
                id="subset-tags"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }}
                onBlur={addTag}
                placeholder={tags.length === 0 ? 'finance, quarterly' : ''}
                className="flex-1 min-w-[120px] bg-transparent text-[13px] text-ink placeholder:text-ink-muted outline-none"
              />
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-sm font-semibold text-ink">Who sees it</p>
            <div role="radiogroup" aria-label="Visibility" className="grid grid-cols-3 gap-3">
              {options.map(({ id, label, description: detail, icon: Icon, disabled, disabledReason, requiresApproval }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={visibility === id}
                  aria-disabled={disabled}
                  onClick={() => { if (!disabled) setVisibility(id) }}
                  className={cn(
                    'flex flex-col items-center gap-1.5 px-4 py-4 rounded-xl border-2 text-center transition-colors',
                    visibility === id
                      ? 'border-accent-explore bg-accent-explore/5 text-accent-explore'
                      : 'border-black/[0.08] dark:border-white/[0.08] text-ink-secondary hover:border-accent-explore/40',
                    disabled && 'opacity-50 cursor-not-allowed hover:border-black/[0.08] dark:hover:border-white/[0.08]',
                  )}
                >
                  <Icon className="w-5 h-5" />
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-2xs text-ink-muted">{detail}</span>
                  {requiresApproval && <span className="text-2xs font-semibold text-amber-600 dark:text-amber-400">Needs approval</span>}
                  {disabled && disabledReason && <span className="text-2xs text-ink-muted">{disabledReason}</span>}
                </button>
              ))}
            </div>
            <VisibilityImpact
              selected={visibility}
              counts={audience}
              workspaceName={source.workspaceName}
              requiresApproval={selectedOption?.requiresApproval}
              approvalHint={selectedOption?.approvalHint}
            />
            {selectedOption?.requiresApproval && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Send className="w-4 h-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  We&rsquo;ll ask an admin to publish this
                </p>
                <p className="mt-1 text-xs text-ink-secondary leading-relaxed">
                  The subset is made for your workspace right away; a request to publish it to everyone goes to
                  the people who can approve it.
                </p>
                <label htmlFor="subset-publish-note" className="mt-3 block text-2xs font-semibold uppercase tracking-wider text-ink-muted mb-1">
                  Note for your admin (optional)
                </label>
                <textarea
                  id="subset-publish-note"
                  value={publishNote}
                  onChange={(e) => setPublishNote(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg bg-canvas-elevated border border-amber-500/25 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-none"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {phase === 'form' && step === 'review' && (
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="flex items-start gap-3 rounded-xl border border-accent-explore/30 bg-accent-explore/5 px-4 py-3">
            <ScissorsLineDashed className="w-5 h-5 mt-0.5 flex-shrink-0 text-accent-explore" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{trimmedName || 'Untitled subset'}</p>
              <p className="text-xs text-ink-muted">Made from <span className="font-medium text-ink-secondary">{source.name}</span> — which stays exactly as it is.</p>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <Tile value={list.length.toLocaleString()} label="Entities" />
            <Tile value={perLayer.size.toLocaleString()} label="Layers" />
            <Tile value={connectivity.virtual.length.toLocaleString()} label="Virtual hops" tone="accent" />
            <Tile value={connectivity.isolated.length.toLocaleString()} label="Isolated" tone={connectivity.isolated.length > 0 ? 'warning' : 'neutral'} />
          </div>

          <section aria-label="Layers in the subset">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink mb-2">
              <Layers className="w-4 h-4 text-ink-muted" aria-hidden="true" /> What it holds
            </p>
            <ul className="rounded-xl border border-black/[0.08] dark:border-white/[0.08] divide-y divide-black/[0.06] dark:divide-white/[0.06] overflow-hidden">
              {layers.filter(l => perLayer.has(l.id)).map(l => {
                const names = perLayer.get(l.id)!
                return (
                  <li key={l.id} className="flex items-start gap-3 px-4 py-2.5">
                    <span className="mt-1"><LayerDot color={l.color} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-ink">{l.name} <span className="text-ink-muted font-normal tabular-nums">· {names.length.toLocaleString()}</span></p>
                      <p className="text-xs text-ink-muted truncate" title={names.join(', ')}>
                        {names.slice(0, 6).join(', ')}{names.length > 6 ? `, +${names.length - 6} more` : ''}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>

          <section aria-label="How lineage stays connected" className="flex items-start gap-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.03] px-4 py-3">
            <Waypoints className="w-4 h-4 mt-0.5 flex-shrink-0 text-accent-explore" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-ink-secondary">
              Lineage between the entities you kept stays connected. Where it runs through ones you left out,
              the subset draws a virtual hop — worked out live from the graph each time it opens, up to{' '}
              {maxHops} steps long, so it never goes stale.
              {preview.status === 'partial' && ' Some connections could not be checked in full just now; the view keeps trying each time it opens.'}
            </p>
          </section>

          <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
            A subset narrows what people see, not what they can open: anyone who can read the data source can
            still find what the subset leaves out.
          </p>
        </div>
      )}
    </WizardShell>,
    document.body,
  )
}

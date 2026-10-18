/**
 * The guided studio for a layout template: where to start, the basics, the
 * layers, who it is for, and a last look before saving. Editing runs the same
 * steps with every one of them open.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
    ArrowRight, Check, Eye, FileText, Layers, LayoutTemplate as TemplateIcon, Share2, Sparkles, Users,
} from 'lucide-react'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { useAppNotifications } from '@/components/ui/notifications'
import { useInvalidateLayoutTemplates, useLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { cn } from '@/lib/utils'
import { listViews } from '@/services/viewApiService'
import {
    layoutTemplateService,
    type LayoutTemplate,
    type TemplateVisibility,
} from '@/services/layoutTemplateService'
import { useAuthStore } from '@/store/auth'
import { useBrand } from '@/store/branding'
import type { ViewLayerConfig } from '@/types/schema'
import { AudiencePicker } from './AudiencePicker'
import { TemplatePreview } from './TemplatePreview'
import { TemplateLayersEditor } from './TemplateLayersEditor'
import { newTemplateLayer } from './newTemplateLayer'
import { AUDIENCE, audienceDescription, audienceOf, categoryLabel } from './templateAudience'
import { layersOfViewConfig, templateLayers } from './fromView'

/** What the studio opens with. `template` → edit it; otherwise a new one,
 *  optionally seeded (a duplicate, a view's layers). */
export interface StudioSeed {
    template?: LayoutTemplate
    name?: string
    description?: string | null
    category?: string | null
    layers?: ViewLayerConfig[]
}

type StepId = 'start' | 'basics' | 'layers' | 'audience' | 'review'

const STEPS: Record<StepId, WizardStepDef> = {
    start: { id: 'start', label: 'Start', icon: <Sparkles className="w-6 h-6" /> },
    basics: { id: 'basics', label: 'Basics', icon: <FileText className="w-6 h-6" /> },
    layers: { id: 'layers', label: 'Layers', icon: <Layers className="w-6 h-6" /> },
    audience: { id: 'audience', label: 'Audience', icon: <Users className="w-6 h-6" /> },
    review: { id: 'review', label: 'Review', icon: <Eye className="w-6 h-6" /> },
}

const BLANK_LAYERS = (): ViewLayerConfig[] => [0, 1, 2].map(newTemplateLayer)

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
    return (
        <div className="mb-6">
            <h3 className="text-xl font-bold text-ink">{title}</h3>
            <p className="text-sm text-ink-muted mt-1">{subtitle}</p>
        </div>
    )
}

function StartOption({ icon, title, detail, active, onClick }: {
    icon: React.ReactNode; title: string; detail: string; active: boolean; onClick: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                'flex flex-col items-start text-left rounded-2xl border-2 p-4 transition-colors',
                active
                    ? 'border-indigo-500 bg-indigo-500/[0.05]'
                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
            )}
        >
            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-2">{icon}</div>
            <div className="text-sm font-bold text-ink">{title}</div>
            <p className="text-xs text-ink-muted mt-0.5 leading-snug">{detail}</p>
        </button>
    )
}

function StartStep({ choose }: { choose: (seed: { name?: string; description?: string | null; category?: string | null; layers: ViewLayerConfig[] }) => void }) {
    const [mode, setMode] = useState<'blank' | 'template' | 'view'>('blank')
    const [picked, setPicked] = useState<string>('blank')
    const meId = useAuthStore(s => s.user?.id)
    const { templates } = useLayoutTemplates()
    const views = useQuery({
        queryKey: ['views', 'mine-for-templates', meId ?? ''],
        queryFn: () => listViews({ createdBy: meId!, viewType: 'reference', limit: 50, sort: 'updated' }),
        enabled: mode === 'view' && !!meId,
        staleTime: 30_000,
    })
    const myViews = (views.data?.items ?? []).filter(v => layersOfViewConfig(v.config).length > 0)

    return (
        <div>
            <StepHeading title="Where would you like to start?" subtitle="Begin from scratch, from a template you can already use, or from the layers of one of your Context Views." />
            <div className="grid gap-3 sm:grid-cols-3">
                <StartOption
                    icon={<Sparkles className="w-4 h-4" />} title="Blank" active={mode === 'blank'}
                    detail="Three empty layers to name and fill."
                    onClick={() => { setMode('blank'); setPicked('blank'); choose({ layers: BLANK_LAYERS() }) }}
                />
                <StartOption
                    icon={<TemplateIcon className="w-4 h-4" />} title="Another template" active={mode === 'template'}
                    detail="Copy one from the library, then make it yours."
                    onClick={() => setMode('template')}
                />
                <StartOption
                    icon={<Layers className="w-4 h-4" />} title="One of my views" active={mode === 'view'}
                    detail="Reuse a Context View's layers — never the entities it placed."
                    onClick={() => setMode('view')}
                />
            </div>

            {mode !== 'blank' && (
                <div className="mt-6 grid gap-3 sm:grid-cols-2 max-h-[340px] overflow-y-auto pr-1">
                    {mode === 'template' && templates.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => {
                                setPicked(t.id)
                                choose({
                                    name: `${t.name} (copy)`, description: t.description, category: t.category,
                                    layers: t.layers,
                                })
                            }}
                            className={cn(
                                'text-left rounded-xl border-2 p-3 transition-colors',
                                picked === t.id ? 'border-indigo-500 bg-indigo-500/[0.05]' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                            )}
                        >
                            <div className="text-sm font-semibold text-ink truncate mb-2">{t.name}</div>
                            <TemplatePreview layers={t.layers} active={picked === t.id} />
                        </button>
                    ))}
                    {mode === 'view' && myViews.map(v => {
                        const layers = templateLayers(layersOfViewConfig(v.config))
                        return (
                            <button
                                key={v.id}
                                type="button"
                                onClick={() => {
                                    setPicked(v.id)
                                    choose({ name: `${v.name} layout`, description: v.description, layers })
                                }}
                                className={cn(
                                    'text-left rounded-xl border-2 p-3 transition-colors',
                                    picked === v.id ? 'border-indigo-500 bg-indigo-500/[0.05]' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                                )}
                            >
                                <div className="text-sm font-semibold text-ink truncate">{v.name}</div>
                                {v.workspaceName && <div className="text-[11px] text-ink-muted truncate mb-2">{v.workspaceName}</div>}
                                <TemplatePreview layers={layers} active={picked === v.id} />
                            </button>
                        )
                    })}
                    {mode === 'view' && views.isLoading && <p className="text-sm text-ink-muted">Loading your views…</p>}
                    {mode === 'view' && !views.isLoading && myViews.length === 0 && (
                        <p className="text-sm text-ink-muted sm:col-span-2">
                            None of your views has layers yet. Context Views you create appear here.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}

export function TemplateStudio({ seed, categories, onClose, onSaved, onShare, onUse }: {
    seed: StudioSeed
    /** Categories already in the library, offered as suggestions. */
    categories: string[]
    onClose: () => void
    onSaved?: (template: LayoutTemplate) => void
    /** After creating: open sharing / start a view from it. */
    onShare?: (template: LayoutTemplate) => void
    onUse?: (template: LayoutTemplate) => void
}) {
    const editing = seed.template
    const { notify } = useAppNotifications()
    const { appName } = useBrand()
    const invalidate = useInvalidateLayoutTemplates()

    const steps: StepId[] = editing || seed.layers
        ? ['basics', 'layers', 'audience', 'review']
        : ['start', 'basics', 'layers', 'audience', 'review']
    const [step, setStep] = useState<StepId>(steps[0])
    const stepIndex = steps.indexOf(step)

    const [name, setName] = useState(editing?.name ?? seed.name ?? '')
    const [description, setDescription] = useState(editing?.description ?? seed.description ?? '')
    const [category, setCategory] = useState(editing?.category ?? seed.category ?? '')
    const [layers, setLayers] = useState<ViewLayerConfig[]>(() => structuredClone(editing?.layers ?? seed.layers ?? BLANK_LAYERS()))
    const [audience, setAudience] = useState<{ visibility: TemplateVisibility; workspaceId: string | null }>({
        visibility: editing?.visibility ?? 'private',
        workspaceId: editing?.workspaceId ?? null,
    })
    const [submitting, setSubmitting] = useState(false)
    const [created, setCreated] = useState<LayoutTemplate | null>(null)
    // A change to an existing template's layers is a new version: say what
    // changed, and whether to tell the people whose views were built from it.
    const [changeNote, setChangeNote] = useState('')
    const [notifyUsers, setNotifyUsers] = useState(() => !!editing && editing.usageCount > 0 && editing.visibility !== 'private')

    const canChangeAudience = !editing || editing.access.canShare
        || (editing.visibility === 'enterprise' && editing.access.canEdit)
    const valid: Record<StepId, boolean> = {
        start: layers.length > 0,
        basics: name.trim().length > 0 && name.trim().length <= 80,
        layers: layers.length > 0 && layers.length <= 30 && layers.every(l => l.name.trim().length > 0),
        audience: audience.visibility !== 'workspace' || !!audience.workspaceId,
        review: true,
    }
    const allValid = steps.every(s => valid[s])
    const categoryOptions = useMemo(
        () => [...new Set(categories)].filter(c => c !== category).slice(0, 8),
        [categories, category],
    )

    const body = {
        name: name.trim(),
        description: description.trim() || null,
        category: category.trim() || null,
        layers: layers.map((l, i) => ({ ...l, name: l.name.trim(), order: i })),
    }
    const newVersion = !!editing
        && JSON.stringify(body.layers) !== JSON.stringify(editing.layers.map((l, i) => ({ ...l, order: i })))
    const tellsPeople = newVersion && audience.visibility !== 'private'

    const submit = async () => {
        setSubmitting(true)
        try {
            if (editing) {
                const moved = audience.visibility !== editing.visibility
                    || (audience.workspaceId ?? null) !== (editing.workspaceId ?? null)
                const saved = await layoutTemplateService.update(editing.id, {
                    ...body, ...(moved && canChangeAudience ? audience : {}),
                    ...(newVersion && { changeNote: changeNote.trim() || null, notifyUsers: tellsPeople && notifyUsers }),
                })
                notify('success', `Saved "${saved.name}"`)
                void invalidate()
                onSaved?.(saved)
                onClose()
            } else {
                const saved = await layoutTemplateService.create({ ...body, ...audience })
                void invalidate()
                onSaved?.(saved)
                setCreated(saved)
            }
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setSubmitting(false)
        }
    }

    const createdAudience = created ? audienceOf(created) : null
    return (
        <WizardShell
            title={editing ? `Edit "${editing.name}"` : 'New layout template'}
            submitLabel={editing ? 'Save changes' : 'Create template'}
            currentStep={step}
            activeSteps={steps.map(s => STEPS[s])}
            currentStepIndex={stepIndex}
            onStepClick={id => setStep(id as StepId)}
            onBack={() => setStep(steps[Math.max(0, stepIndex - 1)])}
            onNext={() => setStep(steps[Math.min(steps.length - 1, stepIndex + 1)])}
            onClose={onClose}
            canProceed={step === 'review' ? allValid : valid[step]}
            isLastStep={step === 'review'}
            isSubmitting={submitting}
            onSubmit={() => void submit()}
            terminalPhase={created ? 'success' : undefined}
            terminalLabel="Created"
            terminalSubtitle={created ? `"${created.name}" is in your library` : undefined}
            helpSlug="creating-views"
            footer={created ? (
                <div className="flex w-full items-center justify-end gap-3">
                    <button type="button" onClick={onClose} className="px-5 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                        Done
                    </button>
                    {onShare && created.access.canShare && (
                        <button
                            type="button"
                            onClick={() => onShare(created)}
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium border border-slate-200 dark:border-slate-700 text-ink-secondary hover:text-ink"
                        >
                            <Share2 className="w-4 h-4" /> Share with people or teams
                        </button>
                    )}
                    {onUse && (
                        <button
                            type="button"
                            onClick={() => onUse(created)}
                            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-md hover:brightness-110"
                        >
                            Use it for a new view <ArrowRight className="w-4 h-4" />
                        </button>
                    )}
                </div>
            ) : undefined}
        >
            {created && createdAudience ? (
                <div className="flex flex-col items-center text-center py-10">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg mb-5">
                        <Check className="w-8 h-8 text-white" />
                    </div>
                    <h3 className="text-xl font-bold text-ink">"{created.name}" is ready</h3>
                    <p className="text-sm text-ink-muted mt-2 max-w-md">
                        {audienceDescription(createdAudience, { workspaceName: created.workspaceName, appName })}
                    </p>
                    <div className="mt-6 w-full max-w-md">
                        <TemplatePreview layers={created.layers} />
                    </div>
                    {createdAudience !== 'organization' && (
                        <p className="text-xs text-ink-muted mt-6 max-w-md">
                            Working with a team? Share it with their group and it appears in their library under "Shared with me".
                        </p>
                    )}
                </div>
            ) : step === 'start' ? (
                <StartStep choose={(s) => {
                    setLayers(structuredClone(s.layers))
                    if (s.name !== undefined) setName(s.name)
                    if (s.description !== undefined) setDescription(s.description ?? '')
                    if (s.category !== undefined) setCategory(s.category ?? '')
                }} />
            ) : step === 'basics' ? (
                <div className="max-w-2xl">
                    <StepHeading title="Name it so others can find it" subtitle="The name and description are what people search and skim in the library." />
                    <div className="space-y-5">
                        <label className="block">
                            <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Name</span>
                            <input
                                autoFocus
                                type="text"
                                value={name}
                                maxLength={80}
                                onChange={e => setName(e.target.value)}
                                placeholder="e.g. Finance reporting flow"
                                className="input border-slate-200 dark:border-slate-700 mt-1.5 h-10 w-full bg-glass-base/40"
                            />
                        </label>
                        <label className="block">
                            <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Description</span>
                            <textarea
                                value={description}
                                maxLength={500}
                                rows={3}
                                onChange={e => setDescription(e.target.value)}
                                placeholder="When to use it, and what each layer is for"
                                className="input border-slate-200 dark:border-slate-700 mt-1.5 w-full py-2 bg-glass-base/40 resize-none"
                            />
                        </label>
                        <div>
                            <label className="block">
                                <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Category</span>
                                <input
                                    type="text"
                                    value={category}
                                    maxLength={40}
                                    onChange={e => setCategory(e.target.value)}
                                    placeholder="e.g. data-engineering"
                                    className="input border-slate-200 dark:border-slate-700 mt-1.5 h-10 w-full bg-glass-base/40"
                                />
                            </label>
                            {categoryOptions.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-2">
                                    {categoryOptions.map(c => (
                                        <button
                                            key={c}
                                            type="button"
                                            onClick={() => setCategory(c)}
                                            className="px-2 py-0.5 rounded-full text-[11px] border border-slate-200 dark:border-slate-700 text-ink-muted hover:text-ink"
                                        >
                                            {categoryLabel(c)}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : step === 'layers' ? (
                <div>
                    <StepHeading
                        title="Shape the layers"
                        subtitle="Each layer is a column of the Context View. Entity types decide what each column collects — they're matched to each view's semantic layer when the template is used."
                    />
                    <div className="mb-5 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 bg-black/[0.015] dark:bg-white/[0.02]">
                        <TemplatePreview layers={layers} />
                    </div>
                    <TemplateLayersEditor layers={layers} onChange={setLayers} />
                </div>
            ) : step === 'audience' ? (
                <div className="max-w-3xl">
                    <StepHeading title="Who is it for?" subtitle="Keep it to yourself, offer it to a workspace, or to the whole organization. You can share it with people and teams once it's saved." />
                    {canChangeAudience ? (
                        <AudiencePicker
                            visibility={audience.visibility}
                            workspaceId={audience.workspaceId}
                            onChange={setAudience}
                        />
                    ) : (
                        <p className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 px-4 py-5 text-sm text-ink-muted">
                            {audienceDescription(audienceOf(editing!), { workspaceName: editing!.workspaceName, appName })}{' '}
                            Only its owner or a workspace admin can change who can use it.
                        </p>
                    )}
                </div>
            ) : (
                <div>
                    <StepHeading title="One last look" subtitle="This is how it will appear in the library." />
                    {newVersion && (
                        <div className="mb-6 rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/[0.04] p-4">
                            <p className="text-sm font-semibold text-ink">This saves version {editing!.version + 1}</p>
                            <p className="text-xs text-ink-muted mt-0.5">
                                Views built from it keep their layers; the people who can edit them are offered the changes.
                            </p>
                            <label className="block mt-3">
                                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">What changed?</span>
                                <textarea
                                    value={changeNote}
                                    maxLength={500}
                                    rows={2}
                                    onChange={e => setChangeNote(e.target.value)}
                                    placeholder="Added a Gold layer for curated tables"
                                    className="input border-slate-200 dark:border-slate-700 mt-1.5 w-full py-2 bg-glass-base/40 resize-none"
                                />
                            </label>
                            {tellsPeople && (
                                <label className="mt-2 flex items-center gap-2 text-xs text-ink-secondary">
                                    <input
                                        type="checkbox"
                                        checked={notifyUsers}
                                        onChange={e => setNotifyUsers(e.target.checked)}
                                        className="rounded border-slate-300 text-fuchsia-600 focus:ring-fuchsia-500"
                                    />
                                    Tell the people whose views were built from it
                                </label>
                            )}
                        </div>
                    )}
                    <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
                        <dl className="space-y-4 text-sm">
                            <div>
                                <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Name</dt>
                                <dd className="text-ink font-semibold mt-0.5">{name.trim() || '—'}</dd>
                            </div>
                            {description.trim() && (
                                <div>
                                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Description</dt>
                                    <dd className="text-ink-secondary mt-0.5">{description.trim()}</dd>
                                </div>
                            )}
                            {category.trim() && (
                                <div>
                                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Category</dt>
                                    <dd className="text-ink-secondary mt-0.5">{categoryLabel(category.trim())}</dd>
                                </div>
                            )}
                            <div>
                                <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Who can use it</dt>
                                <dd className="text-ink-secondary mt-0.5">
                                    <span className="font-semibold text-ink">
                                        {AUDIENCE[audienceOf({ builtIn: false, visibility: audience.visibility })].label}.
                                    </span>{' '}
                                    {audienceDescription(audienceOf({ builtIn: false, visibility: audience.visibility }), { appName })}
                                </dd>
                            </div>
                        </dl>
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-3">
                                {layers.length} layer{layers.length === 1 ? '' : 's'}
                            </div>
                            <TemplatePreview layers={layers} />
                            <ul className="mt-4 space-y-1.5">
                                {layers.map(l => (
                                    <li key={l.id} className="flex items-center gap-2 text-xs">
                                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: l.color }} />
                                        <span className="font-medium text-ink">{l.name}</span>
                                        <span className="text-ink-muted truncate">
                                            {(l.entityTypes ?? []).length ? l.entityTypes.join(', ') : 'filled by hand'}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            )}
        </WizardShell>
    )
}

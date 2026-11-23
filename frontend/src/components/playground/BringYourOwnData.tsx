/**
 * BringYourOwnData — "New data source from a file", in the Playground.
 *
 * A graph of the reader's own, on the pipeline every workspace uses: it is made first, with no
 * rows, on a data model (`POST /playground/graphs`), and its file is then loaded by the standard
 * import — every format, large files, the same row checks against the data model, and the same
 * refused rows and recoveries as the canvas Import. The steps, numbered as they show:
 *
 *  1. Files: the simple templates, and the chosen data model's standard template.
 *  2. Data model: the layers the reader may build on, ranked by how well each fits the file's
 *     types. The best approved one is chosen for them — never one that fits nothing, and nothing
 *     without scores. "Make one from my file" is the last choice.
 *  3. Match types: each of the file's types to one of the data model's, or its rows left out.
 *  4. Canvases: the Context View it opens in, and a Graph view and a Hierarchy if wanted
 *     (`CanvasChoice`) — a Hierarchy only of a data model that nests one type in another.
 *  5. Name, with More options: what existing items are matched by, and keeping the first load
 *     in a draft.
 *
 * Create makes the graph, then loads it. A load that fails is tried again into the same graph:
 * the graph is never made twice.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import {
    AlertTriangle, CheckCircle2, CircleAlert, Download, FileJson, FileSpreadsheet, Loader2, RefreshCw,
    Settings2, Sparkles, UploadCloud, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useCreateGraph, usePlaygroundModels } from '@/hooks/usePlayground'
import { Backdrop } from '@/components/ui/Backdrop'
import { triggerBrowserDownload, type ImportSummary } from '@/services/importExportApiService'
import { playgroundService, type LayerTypesAdded, type NewPlaygroundGraph, type PlaygroundGraphMade } from '@/services/playgroundService'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { workspaceService } from '@/services/workspaceService'
import { useOntology } from '@/features/ontology/hooks/useOntologies'
import { entityDefToSchema, relDefToSchema } from '@/features/ontology/lib/ontology-parsers'
import { caseFold } from '@/features/ontology/lib/caseFold'
import { bestFitId, useOntologyMatches } from '@/components/wizard/useOntologyMatches'
import { OntologyMatchList } from '@/components/wizard/OntologyMatchList'
import { RefusedRowsPanel } from '@/features/import-export/RefusedRowsPanel'
import { matchTypes, toImportFile, whereOf, type TypeMap } from '@/features/import-export/fileRows'
import { downloadSimpleTemplate, useFileIntake } from '@/features/import-export/useFileIntake'
import { byUrnFix, refusedOf, useImportRun } from '@/features/import-export/useImportRun'
import { ImportOptions, matchNote } from '@/features/import-export/ImportOptions'
import { IdentifierStep, useIdentifierChoice } from '@/features/import-export/IdentifierStep'
import { formatIdentifier, parseIdentifier, type Match } from '@/features/import-export/identifier'
import { OWN_DATA_LIMITS, TEMPLATE_FILES } from './ownData'
import { ModelBadge } from './ModelBadge'
import { TypeMatchTable, type ModelTypes, type TypeKind } from './TypeMatchTable'
import { CanvasChoice, hierarchyOfLayer, madeWith, useCanvasChoice, type HierarchyOption } from './CanvasChoice'

/** Rows to fix shown at once; the rest are counted. */
const SHOWN = 8
/** A field that stands out from the dialog it sits on, in either theme. */
const FIELD = 'input bg-canvas border-black/10 dark:border-white/10'
/** The choice of a data model made from the file (OntologyMatchList's "none" card). */
const FROM_FILE = ''
/** No card's id: what the list is told is chosen while nothing is. */
const NOTHING_CHOSEN = '\u0000'
const NO_TYPES: TypeMap = { entity: {}, relationship: {} }

const TEMPLATES: { file: keyof typeof TEMPLATE_FILES; what: string }[] = [
    { file: 'things.csv', what: 'Things' },
    { file: 'connections.csv', what: 'Connections' },
    { file: 'example.json', what: 'Both, as JSON' },
]

const n = (count: number) => count.toLocaleString('en-US')
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
/** "my-things.csv" → "my things": a name to start from. */
const nameFromFile = (fileName: string) => fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, OWN_DATA_LIMITS.name)

/** A data model's types, as its definitions name them. */
function typesOf(layer: OntologyDefinitionResponse): ModelTypes {
    return {
        entity: Object.entries(layer.entityTypeDefinitions ?? {})
            .map(([id, def]) => ({ id, name: entityDefToSchema(id, def as Record<string, unknown>).name })),
        relationship: Object.entries(layer.relationshipTypeDefinitions ?? {}).map(([id, def]) => {
            const rel = relDefToSchema(id, def as Record<string, unknown>)
            return { id, name: rel.name, sourceTypes: rel.sourceTypes, targetTypes: rel.targetTypes }
        }),
    }
}

/** A refusal to make the graph, in words a person can act on. */
function refusal(e: unknown): string {
    const { status, detail } = (e ?? {}) as { status?: number; detail?: { type?: string; message?: string; limit?: number } }
    switch (detail?.type) {
        case 'playground_quota':
        case 'quota_reached': return 'You’ve used all your graphs — delete one you’re done with, then try again.'
        case 'layer_quota': return 'You already keep as many data models of your own as you may. Delete one you no longer use, or choose a data model above.'
        case 'feature_disabled': return 'Making a graph from a file is turned off right now. An administrator turns it on with the Playground, Version control and Build lineage from scratch switches.'
        case 'playground_not_member': return 'Join the Playground first — open it from the sidebar — then try again.'
        case 'unknown_ontology': return 'That data model isn’t here any more. Choose another.'
        case 'ontology_not_published': return 'That data model isn’t published yet. Publish it, or choose another.'
        case 'ontology_not_offered': return 'That data model isn’t offered in the Playground. Choose another.'
        case 'too_large': return `Your file has more types than a data model made from a file may have${detail.limit ? ` (up to ${detail.limit} of each)` : ''}. Choose a data model above instead.`
        case 'invalid_rows': return detail.message || 'Some of your file’s type names can’t be used: each needs 1 to 60 characters.'
    }
    if (status === 413) return refusal({ detail: { type: 'too_large' } })
    return (e instanceof Error && e.message) || 'Couldn’t make the graph. Try again in a moment.'
}

export function BringYourOwnData({ workspaceId, onClose, quotaLeft }: {
    workspaceId: string
    /** Keep it stable: the dialog's focus handling follows it. */
    onClose: () => void
    /** How many more graphs the reader may start, when known. */
    quotaLeft?: number
}) {
    const intake = useFileIntake()
    const run = useImportRun()
    // Not while a file is on its way up: leaving would stop the upload.
    const running = useRef(false)
    running.current = run.phase === 'running'
    const close = useCallback(() => { if (!running.current) onClose() }, [onClose])
    const ref = useModalA11y(true, close)
    const create = useCreateGraph(workspaceId)
    const ids = { title: useId(), input: useId(), name: useId(), description: useId() }

    const modelsQuery = usePlaygroundModels()
    const models = useMemo(() => (modelsQuery.data ?? []).filter(m => m.isPublished), [modelsQuery.data])
    const kindOf = useMemo(() => new Map(models.map(m => [m.id, m.kind])), [models])

    /** A model's id, FROM_FILE, or undefined until one is chosen (the recommendation is chosen then). */
    const [choice, setChoice] = useState<string | undefined>(undefined)
    const [overrides, setOverrides] = useState<TypeMap>(NO_TYPES)
    const [name, setName] = useState('')
    const [nameEdited, setNameEdited] = useState(false)
    const [description, setDescription] = useState('')
    const [more, setMore] = useState(false)
    const [match, setMatch] = useState<Match | null>(null)
    const [keepDraft, setKeepDraft] = useState(false)
    const [made, setMade] = useState<PlaygroundGraphMade | null>(null)
    /** The last load went into a draft, to review: kept there, or into the draft a load left. */
    const [intoDraft, setIntoDraft] = useState(false)
    const [createError, setCreateError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    // The files as the person settles them: each thing identified by the column they chose.
    const identifier = useIdentifierChoice(intake.read)
    const read = identifier.read
    const summary = read && read.format !== 'server' ? read.summary : null
    // A name from the files until the person types one: a JSON file's own, else the first file's.
    const [named, setNamed] = useState(intake.read)
    if (intake.read !== named) {
        setNamed(intake.read)
        if (intake.read && !nameEdited) setName(intake.read.name ?? nameFromFile(intake.files[0]?.name ?? ''))
        if (intake.read?.description && !description) setDescription(intake.read.description.slice(0, OWN_DATA_LIMITS.description))
    }

    // Scored against the layers on offer here, by what the file holds of each type.
    const stats = useMemo(() => (read && summary ? {
        nodeCount: read.things.length, edgeCount: read.connections.length,
        entityTypeCounts: Object.fromEntries(summary.thingTypes), edgeTypeCounts: Object.fromEntries(summary.connectionTypes),
    } : null), [read, summary])
    const matching = useOntologyMatches({ stats, enabled: !!stats && models.length > 0, suggest: playgroundService.matchModels })
    // The recommendation: the best-fitting approved layer — never one that fits nothing.
    const bestApproved = useMemo(
        () => matching.matches.find(m => kindOf.get(m.ontologyId) === 'approved') ?? null,
        [matching.matches, kindOf],
    )
    const recommended = bestFitId({ best: bestApproved })
    useEffect(() => {
        if (choice === undefined && matching.phase === 'ready' && recommended) setChoice(recommended)
    }, [choice, matching.phase, recommended])

    const fromFile = choice === FROM_FILE
    const model = models.find(m => m.id === choice) ?? null
    const layerQuery = useOntology(model?.id)
    const available = useMemo(() => (layerQuery.data ? typesOf(layerQuery.data) : null), [layerQuery.data])
    const auto = useMemo<TypeMap>(() => (summary && available ? {
        entity: matchTypes(summary.thingTypes.map(([t]) => t), available.entity),
        relationship: matchTypes(summary.connectionTypes.map(([t]) => t), available.relationship),
    } : NO_TYPES), [summary, available])
    const typeMap: TypeMap = useMemo(() => ({
        entity: { ...auto.entity, ...overrides.entity },
        relationship: { ...auto.relationship, ...overrides.relationship },
    }), [auto, overrides])
    const unmatched = summary
        ? summary.thingTypes.filter(([t]) => !has(typeMap.entity, t)).length + summary.connectionTypes.filter(([t]) => !has(typeMap.relationship, t)).length
        : 0
    const showMatch = !!model && !!summary && summary.thingTypes.length + summary.connectionTypes.length > 0
    // A Hierarchy as the server makes one: of a containment among the types the graph lays out.
    const hierarchy = useMemo<HierarchyOption>(() => {
        if (fromFile) return { why: 'A data model made from your file connects things; it doesn’t put one inside another, which a hierarchy needs.' }
        if (!model) return { why: 'Choose a data model first.' }
        const layer = layerQuery.data
        if (!layer) return { why: `Checking whether ${model.name} nests one kind of thing in another…` }
        const used = summary ? Object.values(typeMap.entity).filter((t): t is string => !!t) : undefined
        return hierarchyOfLayer(
            Object.entries(layer.entityTypeDefinitions ?? {}).map(([id, def]) => entityDefToSchema(id, def as Record<string, unknown>)),
            Object.entries(layer.relationshipTypeDefinitions ?? {}).map(([id, def]) => relDefToSchema(id, def as Record<string, unknown>)),
            layer.containmentEdgeTypes ?? [], used,
        )
    }, [fromFile, model, layerQuery.data, summary, typeMap])
    const canvases = useCanvasChoice(hierarchy)

    const pick = (id: string) => {
        setChoice(id)
        setOverrides(NO_TYPES)
    }
    const onMap = (kind: TypeKind, typeName: string, target: string | null | undefined) => {
        setOverrides(o => {
            const next = { ...o[kind] }
            if (target === undefined) delete next[typeName]
            else next[typeName] = target
            return { ...o, [kind]: next }
        })
    }
    // Types added to the reader's own data model: a published one is now a new version, which the
    // graph is made on; the added types are matched to the rows that named them.
    const onAdded = (added: LayerTypesAdded) => {
        if (added.ontologyId !== choice) setChoice(added.ontologyId)
        else void layerQuery.refetch()
        setOverrides(o => ({
            entity: { ...o.entity, ...added.entityTypeIds },
            relationship: { ...o.relationship, ...added.relationshipTypeIds },
        }))
    }

    const full = quotaLeft !== undefined && quotaLeft <= 0
    const rowErrors = read?.errors ?? []
    const issues: string[] = []
    if (read && read.format !== 'server' && read.things.length === 0) issues.push('Add at least one thing.')
    if (fromFile && summary) {
        const L = OWN_DATA_LIMITS.types
        if (summary.thingTypes.length > L) issues.push(`${summary.thingTypes.length} kinds of thing — a data model made from a file takes up to ${L}.`)
        if (summary.connectionTypes.length > L) issues.push(`${summary.connectionTypes.length} kinds of connection — a data model made from a file takes up to ${L}.`)
    }
    if (fromFile && read?.format === 'server') {
        issues.push('A data model is made from a CSV or JSON file’s types: this file is read on the server. Choose a data model above, or use a CSV or JSON file.')
    }
    const note = matchNote(match, null)
    const nameOk = name.trim().length > 0 && name.trim().length <= OWN_DATA_LIMITS.name
    const modelReady = fromFile ? !!summary : !!model && (!summary || (!!available && unmatched === 0))
    const ready = !!read && !intake.reading && !intake.warning && !rowErrors.length && !issues.length
        && !!identifier.check?.ok && choice !== undefined && modelReady && nameOk && !full && !note?.block

    /** The new graph's own data model's types, for a model made from the file: read back, so the
     *  rows name them by their ids. Unread, the rows name them as the file does. */
    const typesMadeFor = async (target: PlaygroundGraphMade): Promise<TypeMap> => {
        if (!summary) return NO_TYPES
        // The server says which id each of the file's types got; older servers don't, so read
        // the layer back.
        if (target.typeIds?.entity) {
            return { entity: { ...target.typeIds.entity }, relationship: { ...(target.typeIds.relationship ?? {}) } }
        }
        try {
            const source = (await workspaceService.listDataSources(workspaceId)).find(d => d.id === target.dataSourceId)
            if (!source?.ontologyId) return NO_TYPES
            const types = typesOf(await ontologyDefinitionService.get(source.ontologyId))
            return {
                entity: matchTypes(summary.thingTypes.map(([t]) => t), types.entity),
                relationship: matchTypes(summary.connectionTypes.map(([t]) => t), types.relationship),
            }
        } catch {
            return NO_TYPES
        }
    }

    /** Load the file into `target`. A standard file goes as it is, unless its types are mapped to
     *  others or left out: then as rows, mapped. */
    const load = async (target: PlaygroundGraphMade, past?: { branchId: string; identifier: string }) => {
        if (!read) return
        const map = fromFile ? await typesMadeFor(target) : typeMap
        const remaps = [...Object.entries(map.entity), ...Object.entries(map.relationship)]
            .some(([from, to]) => to === null || caseFold(to) !== caseFold(from))
        const up = read.format === 'standard' && remaps
            ? { file: toImportFile(read, map, intake.files), format: 'ndjson' as const }
            : intake.upload(map, read)
        if (!up) return
        setIntoDraft(!!past || keepDraft)
        await run.start({ wsId: workspaceId, graphId: target.graphId }, up.file, {
            format: up.format,
            identifier: past?.identifier ?? (match ? formatIdentifier(match) : undefined),
            // Into the draft a first load left, its refused rows found by their urn; else a draft of
            // its own, published once it loads unless kept for review.
            ...(past ? { branchId: past.branchId } : { autoPublish: !keepDraft }),
        })
    }

    const submit = async () => {
        if (!ready || busy) return
        setCreateError(null)
        setBusy(true)
        try {
            let target = made
            if (!target) {
                const entityTypes = summary ? [...new Set(Object.values(typeMap.entity).filter((t): t is string => !!t))] : []
                const body: NewPlaygroundGraph = {
                    name: name.trim(),
                    ...(description.trim() ? { description: description.trim() } : {}),
                    model: fromFile
                        ? { infer: {
                            thingTypes: summary!.thingTypes.map(([t]) => t),
                            connectionTypes: summary!.connectionTypes.map(([t]) => ({ name: t, ends: summary!.connectionEnds[t] ?? [] })),
                        } }
                        : { ontologyId: model!.id },
                    ...(!fromFile && entityTypes.length ? { types: entityTypes } : {}),
                    ...(canvases.views.length ? { views: canvases.views } : {}),
                }
                try {
                    target = await create.mutateAsync(body)
                } catch (e) {
                    setCreateError(refusal(e))
                    return
                }
                setMade(target)
            }
            await load(target)
        } finally {
            setBusy(false)
        }
    }

    const retry = () => { if (made) void load(made) }
    const findByUrn = () => {
        const fix = byUrnFix(run.job)
        if (!made || !fix || !run.job?.branchId) return
        setMatch(parseIdentifier(fix))
        void load(made, { branchId: run.job.branchId, identifier: fix })
    }

    const stage = run.phase === 'idle' ? 'setup' : run.phase
    const steps = ['files', ...(read ? ['identifier'] : []), 'model', ...(showMatch ? ['types'] : []), 'canvases', 'name'] as const
    const stepOf = (step: (typeof steps)[number]) => steps.indexOf(step) + 1
    const standardTemplate = (fmt: 'xlsx' | 'csv') => {
        if (!model) return
        const slug = model.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'data-model'
        triggerBrowserDownload(playgroundService.modelTemplateUrl(model.id, fmt), `${slug}-template.${fmt}`)
    }

    return createPortal(
        <>
            <Backdrop open onClick={close} zClassName="z-[60]" />
            <div className="fixed inset-0 z-[61] flex items-center justify-center p-3 sm:p-6 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={ids.title}
                    tabIndex={-1}
                    className="pointer-events-auto flex max-h-full w-full max-w-2xl flex-col rounded-3xl border border-glass-border bg-canvas-elevated shadow-2xl outline-none"
                >
                    <div className="flex items-start gap-3 p-5 pb-3 sm:p-6 sm:pb-4">
                        <span className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500 to-violet-500 text-white flex items-center justify-center shadow-md shadow-sky-500/20 shrink-0">
                            <UploadCloud className="w-5 h-5" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h2 id={ids.title} className="font-display text-lg font-bold text-ink">New data source from a file</h2>
                            <p className="text-sm text-ink-secondary">
                                A graph of your own, versioned like any workspace’s: choose its data model, then your file loads into it.
                            </p>
                        </div>
                        {stage !== 'running' && (
                            <button type="button" onClick={close} aria-label="Close" className="rounded-lg p-1 text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>

                    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-4 sm:px-6 custom-scrollbar">
                        {stage === 'setup' && (
                            <>
                                {full && (
                                    <p className="flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                                        <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden />
                                        You’ve used all your graphs — delete one you’re done with to make room for this one.
                                    </p>
                                )}

                                <Step n={stepOf('files')} title="Your files" hint="Things and connections as two CSV files or one JSON file — or a file in the standard import format, Excel included.">
                                    <ul aria-label="Templates" className="grid gap-2 sm:grid-cols-3">
                                        {TEMPLATES.map(t => (
                                            <li key={t.file}>
                                                <TemplateButton label={t.file} what={t.what} json={t.file.endsWith('.json')} onClick={() => downloadSimpleTemplate(t.file)} />
                                            </li>
                                        ))}
                                    </ul>
                                    {model && (
                                        <p className="mt-2 text-[11px] text-ink-muted">
                                            The standard template for <span className="font-semibold text-ink-secondary">{model.name}</span>, every column it takes:{' '}
                                            <button type="button" onClick={() => standardTemplate('xlsx')} className="font-semibold text-violet-600 dark:text-violet-300 hover:underline">Excel</button>
                                            {' · '}
                                            <button type="button" onClick={() => standardTemplate('csv')} className="font-semibold text-violet-600 dark:text-violet-300 hover:underline">CSV</button>
                                        </p>
                                    )}
                                    <div
                                        onDragOver={(e) => { e.preventDefault(); intake.setDragging(true) }}
                                        onDragLeave={() => intake.setDragging(false)}
                                        onDrop={intake.onDrop}
                                        className={cn(
                                            'mt-3 flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-6 text-center transition',
                                            intake.dragging ? 'border-violet-500 bg-violet-500/[0.06]' : 'border-black/15 dark:border-white/15 bg-canvas/40',
                                        )}
                                    >
                                        <UploadCloud className={cn('w-7 h-7', intake.dragging ? 'text-violet-500' : 'text-ink-muted')} aria-hidden />
                                        <p className="text-sm font-semibold text-ink">Drop your files here</p>
                                        <label
                                            htmlFor={ids.input}
                                            className="inline-flex h-8 cursor-pointer items-center rounded-xl border border-glass-border bg-canvas-elevated px-3 text-xs font-semibold text-ink shadow-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-within:ring-2 focus-within:ring-violet-500/40"
                                        >
                                            or choose them
                                            <input id={ids.input} type="file" multiple aria-label="Choose files" className="sr-only" onChange={intake.onPick} />
                                        </label>
                                        <p className="text-[11px] text-ink-muted">CSV, TSV, JSON, NDJSON or Excel · as large as an import here takes</p>
                                    </div>
                                    {intake.errors.length > 0 && (
                                        <div role="alert" className="mt-2 space-y-1 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                                            {intake.errors.map(e => <p key={e}>{e}</p>)}
                                        </div>
                                    )}
                                    {intake.files.length > 0 && (
                                        <ul aria-label="Your files" className="mt-2 space-y-1.5">
                                            {intake.files.map(f => (
                                                <li key={`${f.name}:${f.lastModified}`} className="flex items-center gap-2.5 rounded-xl border border-glass-border bg-canvas/60 px-3 py-2">
                                                    {/\.json$/i.test(f.name) ? <FileJson className="w-4 h-4 shrink-0 text-violet-500" aria-hidden /> : <FileSpreadsheet className="w-4 h-4 shrink-0 text-violet-500" aria-hidden />}
                                                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{f.name}</span>
                                                    <button type="button" onClick={() => intake.remove(f)} aria-label={`Remove ${f.name}`}
                                                        className="rounded-lg p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                                                        <X className="w-3.5 h-3.5" aria-hidden />
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    {intake.reading && <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-muted"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Reading…</p>}
                                    {intake.warning && <p className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{intake.warning}</p>}
                                    {read?.format === 'server' && !intake.warning && (
                                        <p className="mt-2 text-[11px] text-ink-muted">This file is read on the server as it loads: its rows are checked there against the data model you choose.</p>
                                    )}
                                    {summary && (
                                        <section aria-label="Preview" aria-live="polite" className="mt-3 rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.06] via-transparent to-fuchsia-500/[0.05] p-4">
                                            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                                                <Sparkles className="w-3.5 h-3.5 text-fuchsia-500" aria-hidden /> What you’ll get
                                            </p>
                                            <div className="mt-2 grid grid-cols-3 gap-2">
                                                <Stat value={read!.things.length} label={read!.things.length === 1 ? 'thing' : 'things'} />
                                                <Stat value={read!.connections.length} label={read!.connections.length === 1 ? 'connection' : 'connections'} />
                                                <Stat value={summary.thingTypes.length + summary.connectionTypes.length} label="types" />
                                            </div>
                                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                                <TypeList label="Things by type" rows={summary.thingTypes} tone="bg-violet-500" />
                                                <TypeList label="Connections by type" rows={summary.connectionTypes} tone="bg-fuchsia-500" />
                                            </div>
                                        </section>
                                    )}
                                </Step>

                                {read && (
                                    <Step n={stepOf('identifier')} title="Identifier" hint="What identifies each thing: its connections name it by this, and the next file finds it again by it.">
                                        <IdentifierStep choice={identifier} />
                                    </Step>
                                )}

                                <Step n={stepOf('model')} title="Data model" hint="The types and connections your graph may hold. The best approved fit for your file is chosen for you.">
                                    {matching.phase === 'analyzing' && (
                                        <p className="mb-2 flex items-center gap-1.5 text-[11px] text-ink-muted"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Matching your file against the data models…</p>
                                    )}
                                    {modelsQuery.isLoading ? (
                                        <p className="flex items-center gap-1.5 text-xs text-ink-muted"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Loading the data models…</p>
                                    ) : (
                                        <div className="space-y-3">
                                            <OntologyMatchList
                                                ontologies={models}
                                                matching={{ ...matching, best: bestApproved }}
                                                selectedId={choice ?? NOTHING_CHOSEN}
                                                onPick={pick}
                                                badgeOf={(id) => { const kind = kindOf.get(id); return kind ? <ModelBadge kind={kind} /> : null }}
                                                none={{
                                                    title: 'Make one from my file',
                                                    subtitle: 'A data model just for this graph, used only in the Playground',
                                                    meta: summary ? `${plural(summary.thingTypes.length, 'thing type')} · ${plural(summary.connectionTypes.length, 'connection type')}, from your file` : 'From the types in your file',
                                                }}
                                                noneLast
                                            />
                                        </div>
                                    )}
                                </Step>

                                {showMatch && (
                                    <Step n={stepOf('types')} title="Match types" hint={`Each type in your file, as a type of ${model!.name}. Rows of a type you leave out aren’t loaded.`}>
                                        {!available ? (
                                            <p className="flex items-center gap-1.5 text-xs text-ink-muted"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Reading {model!.name}…</p>
                                        ) : (
                                            <TypeMatchTable summary={summary!} available={available} map={typeMap} onMap={onMap}
                                                addTypes={model!.kind === 'yours' ? { ontologyId: model!.id, onAdded } : undefined} />
                                        )}
                                        {!!available && unmatched > 0 && (
                                            <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
                                                Match {unmatched === 1 ? 'the type' : `the ${unmatched} types`} not found in {model!.name}, or leave {unmatched === 1 ? 'its' : 'their'} rows out.
                                            </p>
                                        )}
                                    </Step>
                                )}

                                {(rowErrors.length > 0 || issues.length > 0) && (
                                    <section aria-label="Rows to fix" className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] p-4">
                                        <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300">
                                            <CircleAlert className="w-3.5 h-3.5" aria-hidden />
                                            {rowErrors.length ? `${plural(rowErrors.length, 'row')} to fix before you create it` : 'Before you create it'}
                                        </p>
                                        <ul className="mt-2 space-y-1 text-xs">
                                            {issues.map(i => <li key={i} className="text-ink">{i}</li>)}
                                            {rowErrors.slice(0, SHOWN).map(e => (
                                                <li key={`${e.section}:${e.index}:${e.field}:${e.message}`} className="flex flex-wrap gap-x-1.5">
                                                    <span className="font-semibold text-ink">{whereOf(e)}</span>
                                                    <span className="text-ink-muted">· {e.field}:</span>
                                                    <span className="text-ink-secondary">{e.message}</span>
                                                </li>
                                            ))}
                                        </ul>
                                        {rowErrors.length > SHOWN && <p className="mt-1 text-[11px] text-ink-muted">…and {n(rowErrors.length - SHOWN)} more.</p>}
                                    </section>
                                )}

                                <Step n={stepOf('canvases')} title="Canvases" hint="It opens in its Context View. Add a Graph view or a Hierarchy beside it if you’d like them.">
                                    <CanvasChoice choice={canvases} />
                                </Step>

                                <Step n={stepOf('name')} title="Name it">
                                    <div className="space-y-3">
                                        <label htmlFor={ids.name} className="block">
                                            <span className="text-xs font-semibold text-ink-secondary">Name</span>
                                            <input id={ids.name} value={name} maxLength={OWN_DATA_LIMITS.name} required
                                                onChange={(e) => { setName(e.target.value); setNameEdited(true) }}
                                                placeholder="e.g. Coffee shop sales" className={cn(FIELD, 'mt-1')} />
                                        </label>
                                        <label htmlFor={ids.description} className="block">
                                            <span className="text-xs font-semibold text-ink-secondary">Description <span className="font-normal text-ink-muted">· optional</span></span>
                                            <textarea id={ids.description} value={description} maxLength={OWN_DATA_LIMITS.description} rows={2}
                                                onChange={(e) => setDescription(e.target.value)}
                                                placeholder="What it shows, and where the data comes from" className={cn(FIELD, 'mt-1 resize-none')} />
                                        </label>
                                        <button type="button" onClick={() => setMore(v => !v)} aria-expanded={more}
                                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-secondary hover:text-violet-600 dark:hover:text-violet-300">
                                            <Settings2 className="w-3.5 h-3.5" aria-hidden /> More options
                                        </button>
                                        {more && (
                                            <div className="space-y-4 rounded-2xl border border-glass-border bg-canvas/60 p-3">
                                                <ImportOptions
                                                    match={match} onMatch={setMatch} graphDefault={null} note={note}
                                                    draft={{
                                                        keep: keepDraft, onChange: setKeepDraft, label: 'Keep the first load in a draft.',
                                                        help: 'It waits for you to review its changes and publish them; otherwise it’s published as soon as it loads.',
                                                    }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                </Step>

                                {createError && (
                                    <p role="alert" className="flex items-start gap-1.5 rounded-xl bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-700 dark:text-rose-300">
                                        <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden /> {createError}
                                    </p>
                                )}
                            </>
                        )}

                        {stage === 'running' && <Loading upload={run.upload} started={!!run.job} />}
                        {stage === 'done' && made && (
                            <Done name={name.trim()} summary={(run.job?.summary as ImportSummary | null | undefined) ?? null} keptInDraft={intoDraft}
                                wsId={workspaceId} graphId={made.graphId} jobId={run.job?.jobId ?? null} views={madeWith(made.viewIds)} />
                        )}
                        {stage === 'failed' && made && (
                            <section aria-label="Load failed" className="space-y-3">
                                <div className="flex items-start gap-3">
                                    <span className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0"><AlertTriangle className="w-5 h-5" aria-hidden /></span>
                                    <div className="min-w-0">
                                        <h3 className="text-sm font-bold text-ink">“{name.trim()}” was made, but your file didn’t load</h3>
                                        <p className="mt-1 text-xs text-ink-secondary break-words">{run.error}</p>
                                        <p className="mt-1 text-[11px] text-ink-muted">The graph is there with no data yet. Try the import again, or add data to it later.</p>
                                    </div>
                                </div>
                                {refusedOf(run.job) && <RefusedRowsPanel report={refusedOf(run.job)!} wsId={workspaceId} graphId={made.graphId} jobId={run.job?.jobId} />}
                            </section>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-glass-border px-5 py-4 sm:px-6">
                        {stage === 'setup' && (
                            <>
                                <p className="mr-auto w-full text-[11px] text-ink-muted sm:w-auto">
                                    Counts as one of your graphs{quotaLeft !== undefined && quotaLeft > 0 ? ` · ${quotaLeft} left` : ''}
                                </p>
                                <FooterButton onClick={close}>Cancel</FooterButton>
                                <button
                                    type="button"
                                    onClick={() => void submit()}
                                    disabled={!ready || busy}
                                    aria-busy={busy || undefined}
                                    className="inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 disabled:opacity-50 disabled:shadow-none disabled:hover:brightness-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
                                >
                                    {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
                                    {busy ? 'Creating…' : 'Create'}
                                </button>
                            </>
                        )}
                        {(stage === 'done' || stage === 'failed') && made && (
                            <>
                                <FooterButton onClick={close} className="mr-auto">Close</FooterButton>
                                {byUrnFix(run.job) && run.job?.branchId && (
                                    <FooterButton onClick={findByUrn}><Sparkles className="w-4 h-4" aria-hidden /> Find them by their urn</FooterButton>
                                )}
                                {stage === 'failed' ? (
                                    <button type="button" onClick={retry}
                                        className="inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50">
                                        <RefreshCw className="w-4 h-4" aria-hidden /> Try the import again
                                    </button>
                                ) : (
                                    <>
                                        <Link to={`/views/${made.viewId}?import=1`} onClick={onClose}
                                            className="inline-flex h-9 items-center rounded-xl border border-glass-border px-3.5 text-sm font-semibold text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                                            Add more data
                                        </Link>
                                        <Link to={`/views/${made.viewId}`} onClick={onClose}
                                            className="inline-flex h-9 items-center rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50">
                                            Open it
                                        </Link>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
        </>,
        document.body,
    )
}

function Step({ n: num, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section aria-label={title}>
            <div className="mb-2 flex items-start gap-2">
                <span className="mt-px inline-flex w-5 h-5 shrink-0 items-center justify-center rounded-full bg-violet-500/10 text-[11px] font-bold text-violet-600 dark:text-violet-300" aria-hidden>{num}</span>
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink">{title}</h3>
                    {hint && <p className="text-[11px] text-ink-muted">{hint}</p>}
                </div>
            </div>
            {children}
        </section>
    )
}

function TemplateButton({ label, what, json, onClick }: { label: string; what: string; json: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex w-full items-center gap-2.5 rounded-2xl border border-glass-border bg-canvas/60 px-3 py-2.5 text-left transition hover:border-violet-500/40 hover:shadow-md hover:shadow-violet-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
        >
            <span className="flex w-8 h-8 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300">
                {json ? <FileJson className="w-4 h-4" aria-hidden /> : <FileSpreadsheet className="w-4 h-4" aria-hidden />}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-ink">{label}</span>
                <span className="block text-[11px] text-ink-muted">{what}</span>
            </span>
            <Download className="w-3.5 h-3.5 shrink-0 text-ink-muted group-hover:text-violet-500" aria-hidden />
        </button>
    )
}

function FooterButton({ onClick, className, children }: { onClick: () => void; className?: string; children: React.ReactNode }) {
    return (
        <button type="button" onClick={onClick}
            className={cn('inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40', className)}>
            {children}
        </button>
    )
}

/** The graph is made; its file is on its way up, then loading. */
function Loading({ upload, started }: { upload: { sent: number; total: number } | null; started: boolean }) {
    const pct = !started && upload && upload.total > 0 ? Math.round((100 * upload.sent) / upload.total) : null
    return (
        <div className="flex flex-col items-center gap-3 py-10 text-center" aria-live="polite">
            <Loader2 className="w-7 h-7 animate-spin text-violet-500" aria-hidden />
            <p className="text-sm font-semibold text-ink">{started ? 'Loading your data…' : 'Sending your file…'}</p>
            {pct != null && (
                <div className="h-1 w-64 overflow-hidden rounded-full bg-black/5 dark:bg-white/5">
                    <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500" style={{ width: `${pct}%` }} />
                </div>
            )}
            <p className="text-[11px] text-ink-muted">Keep this open until it finishes.</p>
        </div>
    )
}

/** What the first load did: its counts, whether it was published, the rows it refused, and the
 *  views it was made with (`views`, in a sentence). */
function Done({ name, summary, keptInDraft, wsId, graphId, jobId, views }: {
    name: string
    summary: ImportSummary | null
    keptInDraft: boolean
    wsId: string
    graphId: string
    jobId: string | null
    views: string
}) {
    const publish = summary?.publish
    // Why its publish was skipped: a sentence, or the publish route's refusal with its message.
    const why = typeof publish?.reason === 'string' ? publish.reason : publish?.reason?.message
    const said = keptInDraft
        ? 'It’s in a draft: open it to review the changes, then publish them.'
        : publish?.state === 'skipped'
            ? `It waits in a draft for you to review: ${why ?? 'it couldn’t be published by itself.'}`
            : publish?.state === 'queued' ? 'It’s being published, and opens as it is in a moment.' : 'It’s published, ready to explore.'
    return (
        <section aria-label="Done" className="space-y-4">
            <div className="flex items-start gap-3">
                <span className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0"><CheckCircle2 className="w-5 h-5" aria-hidden /></span>
                <div className="min-w-0">
                    <h3 className="text-sm font-bold text-ink">“{name}” is ready</h3>
                    <p className="mt-1 text-xs text-ink-secondary">{said}</p>
                </div>
            </div>
            {summary && (
                <div className="grid grid-cols-3 gap-2">
                    <Stat value={summary.new} label="added" />
                    <Stat value={summary.updated} label="updated" />
                    <Stat value={summary.invalid} label="refused" />
                </div>
            )}
            {summary?.refused && <RefusedRowsPanel report={summary.refused} wsId={wsId} graphId={graphId} jobId={jobId} />}
            <p className="text-[11px] text-ink-muted">{views} Add more data any time: it opens the import in a draft.</p>
        </section>
    )
}

function Stat({ value, label }: { value: number; label: string }) {
    return (
        <p className="rounded-xl border border-black/[0.07] bg-canvas-elevated px-3 py-2 dark:border-white/10">
            <span className="block text-lg font-bold tabular-nums leading-tight text-ink">{n(value)}</span>{' '}
            <span className="block text-[11px] text-ink-muted">{label}</span>
        </p>
    )
}

function TypeList({ label, rows, tone }: { label: string; rows: [string, number][]; tone: string }) {
    const top = rows[0]?.[1] ?? 0
    return (
        <div className="min-w-0">
            <p className="mb-1 text-[11px] font-semibold text-ink-secondary">{label}</p>
            {rows.length === 0 ? (
                <p className="text-[11px] text-ink-muted">None yet</p>
            ) : (
                <ul aria-label={label} className="space-y-1">
                    {rows.slice(0, 6).map(([type, count]) => (
                        <li key={type} className="flex items-center gap-2 text-xs">
                            <span className="min-w-0 flex-1 truncate text-ink">{type}</span>
                            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]" aria-hidden>
                                <span className={cn('block h-full rounded-full', tone)} style={{ width: `${Math.max(8, (count / top) * 100)}%` }} />
                            </span>
                            <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-ink-secondary">{n(count)}</span>
                        </li>
                    ))}
                    {rows.length > 6 && <li className="text-[11px] text-ink-muted">and {rows.length - 6} more</li>}
                </ul>
            )}
        </div>
    )
}

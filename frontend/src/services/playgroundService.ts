/**
 * The Playground: one shared sandbox workspace anyone may join to build their own
 * graphs from blank (see backend `endpoints/playground.py`). Off until an
 * administrator turns `playgroundEnabled` on and sets it up.
 */
import { authFetch } from './apiClient'
import type { OntologyDefinitionResponse, OntologySuggestResponse } from './ontologyDefinitionService'

export interface PlaygroundInfo {
    enabled: boolean
    exists: boolean
    workspaceId?: string | null
    name?: string | null
    description?: string | null
    joined: boolean
    graphQuota: number
    graphsUsed: number
    /** A platform administrator: may set it up and change its settings. */
    canSetUp: boolean
    sandboxProviderId?: string | null
    starterOntologyIds?: string[] | null
    /** Most rows one import may carry here (0: no limit). */
    maxImportRows?: number
    /** Most semantic layers of their own a member may keep, and how many the reader has. */
    layerQuota?: number
    layersUsed?: number
}

/** A graph a member may start from a sample: a card in the gallery. */
export interface PlaygroundSample {
    id: string
    title: string
    description: string
    /** A lucide icon name, and a colour name for its tile. */
    icon: string
    color: string
    /** The layout its view opens in. */
    viewType: string
    nodeCount: number
    edgeCount: number
    entityTypes: string[]
}

export interface PlaygroundSamples {
    samples: PlaygroundSample[]
    /** How many more graphs this person may start — a sample is one. */
    quotaLeft: number
}

/** What starting a sample made: a graph of the person's, its views — the Context View
 *  (`viewId`) opens first — and an example change waiting for review on the Graph view. */
export interface StartedSample {
    dataSourceId: string
    viewId: string
    /** Absent from servers that made one view per sample. */
    viewIds?: { context: string; graph: string; hierarchy?: string }
    draftId?: string | null
    reviewId?: string | null
}

export type PropertyValue = string | number | boolean | null

/** One thing of the person's: `key` is how connections name it. */
export interface OwnThing {
    key: string
    type: string
    name: string
    description?: string
    properties?: Record<string, PropertyValue>
    tags?: string[]
}

/** A connection between two things, by their keys. */
export interface OwnConnection {
    from: string
    type: string
    to: string
}

/** A semantic layer a member may build on here (`GET /playground/models`): an approved org-wide
 *  layer, a starter, a sample's, one of their own, or one another member shared. */
export type PlaygroundModelKind = 'approved' | 'starter' | 'sample' | 'yours' | 'shared'

export interface PlaygroundModel {
    id: string
    name: string
    description: string | null
    version: number
    kind: PlaygroundModelKind
    isPublished: boolean
    entityTypeCount: number
    relationshipTypeCount: number
    /** How many of the reader's graphs are built on it. */
    usedBy: number
}

/** A data model made from a file's types: thing types, and connection types with the type pairs
 *  their rows join. */
export interface InferredModel {
    thingTypes: string[]
    connectionTypes: { name: string; ends: [string, string][] }[]
}

/** `POST /playground/graphs`: a new data source, blank graph and views, with no rows yet — they
 *  come through the standard import. `types`: the entity types the file uses, which set the
 *  Context View's layers. */
export interface NewPlaygroundGraph {
    name: string
    description?: string
    model: { ontologyId: string } | { infer: InferredModel }
    types?: string[]
}

export interface PlaygroundGraphMade {
    dataSourceId: string
    graphId: string
    mainBranchId: string
    /** The Context View: open this. */
    viewId: string
    viewIds: { context: string; graph: string }
    /** The semantic layer it is built on. */
    ontologyId?: string
    /** A layer made from the file's types: each type's name → its id there, so the rows can name
     *  them by id. Empty for a layer on offer. */
    typeIds?: { entity?: Record<string, string>; relationship?: Record<string, string> }
}

/** Where a semantic layer of one's own starts from. `layer`: a Semantic Layers export (JSON). */
export type LayerSource =
    | { blank: true }
    | { cloneOf: string }
    | { layer: Record<string, unknown> }
    | { infer: InferredModel }

export interface NewPlaygroundLayer {
    name: string
    description?: string
    from: LayerSource
}

export interface LayerTypesToAdd {
    entityTypes: { name: string }[]
    relationshipTypes: { name: string; ends: [string, string][] }[]
}

/** What adding types made: the layer version now in use (a new one when the layer was published),
 *  how many of the reader's graphs moved to it, and each added name's type id. */
export interface LayerTypesAdded {
    ontologyId: string
    version: number
    movedGraphs: number
    entityTypeIds: Record<string, string>
    relationshipTypeIds: Record<string, string>
}

export interface PlaygroundSetup {
    name: string
    description?: string
    sandboxProviderId: string
    starterOntologyIds: string[]
    graphQuota: number
}

const BASE = '/api/v1/playground'
const json = (body: unknown): RequestInit => ({
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const post = (body: unknown): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

export const playgroundService = {
    get: () => authFetch<PlaygroundInfo>(BASE, { silent403: true }),
    join: () => authFetch<PlaygroundInfo>(`${BASE}/join`, { method: 'POST' }),
    leave: () => authFetch<void>(`${BASE}/leave`, { method: 'POST' }),
    setUp: (body: PlaygroundSetup) => authFetch<PlaygroundInfo>(BASE, json(body)),
    samples: () => authFetch<PlaygroundSamples>(`${BASE}/samples`, { silent403: true }),
    startSample: (sampleId: string) => authFetch<StartedSample>(
        `${BASE}/samples/${encodeURIComponent(sampleId)}`, { method: 'POST' }),
    /** The semantic layers the reader may build on here. */
    listModels: () => authFetch<PlaygroundModel[]>(`${BASE}/models`, { silent403: true }),
    /** The standard import template for a layer (csv | ndjson | xlsx), as a download URL. */
    modelTemplateUrl: (ontologyId: string, format: 'csv' | 'ndjson' | 'xlsx' = 'csv') =>
        `${BASE}/models/${encodeURIComponent(ontologyId)}/template?format=${format}`,
    /** How well each layer the reader may build on here fits a graph's types: the body and answer
     *  of `/admin/ontologies/suggest`, scoring only the layers on offer, for members. */
    matchModels: (stats: Record<string, unknown>, minScore = 0) => authFetch<OntologySuggestResponse>(
        `${BASE}/models/match?min_score=${minScore}`, post(stats)),
    createGraph: (body: NewPlaygroundGraph) => authFetch<PlaygroundGraphMade>(`${BASE}/graphs`, post(body)),
    createLayer: (body: NewPlaygroundLayer) => authFetch<OntologyDefinitionResponse>(`${BASE}/layers`, post(body)),
    shareLayer: (ontologyId: string, shared: boolean) => authFetch<OntologyDefinitionResponse>(
        `${BASE}/layers/${encodeURIComponent(ontologyId)}/share`, post({ shared })),
    addLayerTypes: (ontologyId: string, body: LayerTypesToAdd) => authFetch<LayerTypesAdded>(
        `${BASE}/layers/${encodeURIComponent(ontologyId)}/types`, post(body)),
}

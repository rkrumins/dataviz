/**
 * The Playground: one shared sandbox workspace anyone may join to build their own
 * graphs from blank (see backend `endpoints/playground.py`). Off until an
 * administrator turns `playgroundEnabled` on and sets it up.
 */
import { authFetch } from './apiClient'

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

/** A graph made from the person's own files (`POST /playground/imports`): parsed in the browser. */
export interface OwnDataImport {
    name: string
    description?: string
    things: OwnThing[]
    connections: OwnConnection[]
}

/** What an import made: a graph, its Context View (`viewId`, opened first) and a Graph view. */
export interface ImportedGraph {
    dataSourceId: string
    viewId: string
    viewIds: { context: string; graph: string }
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

export const playgroundService = {
    get: () => authFetch<PlaygroundInfo>(BASE, { silent403: true }),
    join: () => authFetch<PlaygroundInfo>(`${BASE}/join`, { method: 'POST' }),
    leave: () => authFetch<void>(`${BASE}/leave`, { method: 'POST' }),
    setUp: (body: PlaygroundSetup) => authFetch<PlaygroundInfo>(BASE, json(body)),
    samples: () => authFetch<PlaygroundSamples>(`${BASE}/samples`, { silent403: true }),
    startSample: (sampleId: string) => authFetch<StartedSample>(
        `${BASE}/samples/${encodeURIComponent(sampleId)}`, { method: 'POST' }),
    importOwnData: (body: OwnDataImport) => authFetch<ImportedGraph>(`${BASE}/imports`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
}

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

/** What starting a sample made: a graph of the person's, and a view on it. */
export interface StartedSample {
    dataSourceId: string
    viewId: string
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
}

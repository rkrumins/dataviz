/**
 * What a question about an entity is anchored to: the entity's name, the containers it sits in
 * (top first) and its type, besides its urn. A name alone can't tell two `amount` columns apart,
 * and an id alone tells a reader nothing, so a question keeps all of them, as they were when it
 * was asked.
 *
 * `anchorOf` reads what the canvas has loaded, at once; `completeAnchorPath` then asks the data
 * source for the containers it hasn't, and updates the drawer if they differ.
 */
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'
import { nodeIndexOf, containmentIndexOf } from '@/lib/storeIndex'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import type { ThreadSummary } from '@/services/discussionsService'
import { useDiscussionsDrawer, type DrawerEntity } from './drawerStore'

/** As many containers as the server keeps. */
export const ENTITY_PATH_MAX = 32

/** The name a canvas node goes by for the reader's persona; '' when it has none. */
function nameOf(node: LineageNode): string {
    return resolveEntityName(node.data, usePersonaStore.getState().mode).trim()
}

/** The nearest containers, kept when there are more than the server keeps. */
const capped = (path: string[]) => path.slice(-ENTITY_PATH_MAX)

/**
 * The entity `urnOrId` names, as the canvas has it: its urn, its name for the reader's persona,
 * its type, and the containers it sits in — its loaded parents, then, above the topmost of them,
 * the containers its feed named. `resolve` finds a node the store doesn't hold (a Context View
 * trace card); `label` names an entity neither knows.
 */
export function anchorOf(urnOrId: string, { label, resolve }: {
    label?: string | null
    resolve?: (id: string) => LineageNode | null
} = {}): DrawerEntity {
    const { nodes, edges } = useCanvasStore.getState()
    const index = nodeIndexOf(nodes)
    const node = index.get(urnOrId) ?? resolve?.(urnOrId) ?? undefined
    const urn = (node?.data?.urn as string | undefined) || urnOrId
    const name = (node && nameOf(node)) || label?.trim() || urn
    if (!node) return { id: urn, label: name }

    const parents = containmentIndexOf(edges, useSchemaStore.getState().schema?.containmentEdgeTypes ?? []).parentEdgeOf
    const path: string[] = []
    const seen = new Set([node.id])
    let top = node
    for (let edge = parents.get(top.id); edge && !seen.has(edge.source);) {
        const parent = index.get(edge.source)
        if (!parent) break
        seen.add(parent.id)
        path.unshift(nameOf(parent) || (parent.data?.urn as string) || parent.id)
        top = parent
        edge = parents.get(top.id)
    }
    const above = (top.data?.ancestorPath ?? []).map((a) => a.displayName?.trim() || a.urn)
    const type = (node.data?.type as string | undefined) || null
    return { id: urn, label: name, path: capped([...above, ...path]), type }
}

/** Ancestors from the data source (parent first) as names, top first: as the canvas names them where loaded. */
function namesFrom(ancestors: readonly GraphNode[]): string[] {
    const index = nodeIndexOf(useCanvasStore.getState().nodes)
    return [...ancestors].reverse().map((a) => {
        const loaded = index.get(a.urn)
        return (loaded && nameOf(loaded)) || a.displayName?.trim() || a.urn
    })
}

const samePath = (a: readonly string[] | undefined, b: readonly string[]) =>
    (a?.length ?? 0) === b.length && b.every((n, i) => a?.[i] === n)

/**
 * The containers the canvas hasn't loaded, from the data source: the drawer's entity takes the
 * whole path if it is still on `entity` and the path differs. Kept as it was when the source
 * can't say.
 */
export function completeAnchorPath(entity: DrawerEntity, provider: GraphDataProvider | null): void {
    if (!provider) return
    provider.getAncestors(entity.id).then((ancestors) => {
        const path = capped(namesFrom(ancestors))
        const drawer = useDiscussionsDrawer.getState()
        const now = drawer.target?.entity
        if (!now || now.id !== entity.id || samePath(now.path, path)) return
        drawer.setEntity({ ...now, path })
    }, () => undefined)
}

/** An entity a question is about, as a thread or the drawer has it. */
export interface AnchorEntity {
    id: string
    label?: string | null
    path?: readonly string[] | null
    type?: string | null
}

export const PATH_SEP = ' › '

export function anchorOfThread(thread: Pick<ThreadSummary, 'entityId' | 'entityLabel' | 'entityPath' | 'entityType'>): AnchorEntity {
    return { id: thread.entityId ?? '', label: thread.entityLabel, path: thread.entityPath, type: thread.entityType }
}

/** Its own name: none when it was kept without one, or with its ID standing in. */
export function ownName(entity: AnchorEntity): string | null {
    const label = entity.label?.trim()
    return label && label !== entity.id ? label : null
}

/** What it is, where it sits, and its ID, spelled out in full — for an accessible name. */
export function anchorWords(name: string | null, path: readonly string[], id: string): string {
    return `${name ?? id}${path.length ? `, in ${path.join(PATH_SEP)}` : ''}${name ? `, ID ${id}` : ''}`
}

export const describeAnchor = (entity: AnchorEntity) => anchorWords(ownName(entity), entity.path ?? [], entity.id)

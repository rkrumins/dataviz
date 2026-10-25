/**
 * edgeTypeOptions — the edge types a query can name: every relationship type
 * the ontology declares, each with what it connects ("Data job → Dataset"),
 * the ones this data source holds first, and any the graph holds that the
 * ontology doesn't name. The Form's picker and Code mode's completion both
 * read them here.
 */
import { useMemo } from 'react'

import { edgeTypeCopy } from '@/lib/relationshipLabel'
import { useContainmentEdgeTypes, useEntityTypes, useRelationshipTypes } from '@/store/schema'

import { edgeTypeName } from './vocabulary/edgeWords'


export interface EdgeTypeOption {
    id: string
    name: string
    /** "Data job → Dataset", when the ontology says. */
    ends: string
    /** Whether this data source holds any. */
    seen: boolean
    /** One of the hierarchy's: a connection never walks it. */
    containment: boolean
}

/** The edge types, those in ``seen`` (this data source's) first. */
export function useEdgeTypeOptions(seen: readonly string[] | undefined): EdgeTypeOption[] {
    const relationshipTypes = useRelationshipTypes()
    const entityTypes = useEntityTypes()
    const containment = useContainmentEdgeTypes()
    return useMemo(() => {
        const typeName = (id: string) => entityTypes.find((e) => e.id === id)?.name ?? id
        const held = new Set((seen ?? []).map((t) => t.toUpperCase()))
        const contains = new Set(containment.map((t) => t.toUpperCase()))
        const byId = new Map<string, EdgeTypeOption>()
        for (const rt of relationshipTypes) {
            const from = rt.sourceTypes.map(typeName).join(', ')
            const to = rt.targetTypes.map(typeName).join(', ')
            byId.set(rt.id.toUpperCase(), {
                id: rt.id, name: edgeTypeCopy(rt.id)?.label ?? (rt.name || edgeTypeName(rt.id)),
                // An end the ontology leaves open takes anything.
                ends: from || to ? `${from || 'Anything'} → ${to || 'anything'}` : '',
                seen: held.has(rt.id.toUpperCase()),
                containment: !!rt.isContainment || contains.has(rt.id.toUpperCase()),
            })
        }
        for (const id of seen ?? []) {
            const key = id.toUpperCase()
            if (byId.has(key)) continue
            byId.set(key, { id, name: edgeTypeName(id), ends: '', seen: true, containment: contains.has(key) })
        }
        return [...byId.values()].sort((a, b) =>
            Number(b.seen) - Number(a.seen) || a.name.localeCompare(b.name))
    }, [relationshipTypes, entityTypes, containment, seen])
}

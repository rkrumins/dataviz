/**
 * The physical graph name a new graph is stored under on a connection, checked live as it's
 * typed. Extracted from BasicsStep (a blank model's graph name) so a data source copied from a
 * view package names its graph the same way.
 *
 * This name IS the FalkorDB key the graph is stored under, and a projection seed WIPES that key —
 * so a collision is destructive, not cosmetic. The server refuses to provision onto an existing
 * key (validated under a per-(provider, name) advisory lock, across every workspace, plus a live
 * GRAPH.LIST check), so someone else's data can never be overwritten.
 *
 * What we owe the user on top of that guarantee is not making them solve it: the name is derived
 * (from the view's name, say), so two people naming a view "Data Lineage" collide by construction.
 * When the derived name is taken we adopt the server's free alternative (data_lineage →
 * data_lineage_2) automatically and say so. A name the user typed themselves is never silently
 * changed — they get the same alternative as a one-click fix instead.
 */
import { useEffect, useRef, useState } from 'react'
import { checkBlankGraphName } from '@/services/versioningApiService'
import { GRAPH_NAME_RE } from '../blankModel'

/** Where the name and what is known of it are kept (the wizard's form, or a new data source's). */
export interface GraphNameFields {
    graphName?: string
    /** False once the user edits the name by hand: their choice then survives a change of what
     *  it's derived from (and we stop silently re-deriving it under them). */
    graphNameIsAuto?: boolean
    /** Last known availability — false blocks going on; the server re-validates at submit. */
    graphNameAvailable?: boolean
}

export type GraphNameCheck =
    | { state: 'idle' | 'checking' | 'available' }
    | { state: 'unavailable'; reason: string; suggestion: string | null }

export function useGraphNameCheck({ scope, derivedName, fields, update }: {
    /** The connection the graph goes on; none, no check. */
    scope?: { workspaceId: string; providerId: string } | null
    /** The name while it's derived (a slug of what it's named after). */
    derivedName: string
    fields: GraphNameFields
    update: (patch: GraphNameFields) => void
}) {
    const isAutoName = fields.graphNameIsAuto !== false
    const effectiveName = fields.graphName ?? derivedName

    const [nameCheck, setNameCheck] = useState<GraphNameCheck>({ state: 'idle' })
    /** Set when we auto-moved off a taken name, so the UI can explain itself. */
    const [autoUniquifiedFrom, setAutoUniquifiedFrom] = useState<string | null>(null)
    const checkSeq = useRef(0)

    // Keep the auto-derived name in step with what it's derived from (until the user takes the
    // wheel). Writing it into the fields — rather than deriving it at submit — is what lets the
    // uniquified name actually be the one we provision.
    useEffect(() => {
        if (!scope || !isAutoName) return
        if (autoUniquifiedFrom === derivedName) return   // already handled this base
        if (fields.graphName === derivedName) return
        setAutoUniquifiedFrom(null)
        update({ graphName: derivedName, graphNameAvailable: undefined })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope, isAutoName, derivedName])

    useEffect(() => {
        if (!scope) return
        const name = effectiveName
        if (!name || !GRAPH_NAME_RE.test(name)) {
            setNameCheck(name
                ? { state: 'unavailable', reason: "Use 3–64 characters: lowercase letters, numbers, '-' or '_'.", suggestion: null }
                : { state: 'idle' })
            update({ graphNameAvailable: name ? false : undefined })
            return
        }
        const seq = ++checkSeq.current
        setNameCheck({ state: 'checking' })
        const t = setTimeout(() => {
            checkBlankGraphName(scope.workspaceId, scope.providerId, name)
                .then((res) => {
                    if (checkSeq.current !== seq) return
                    if (res.available) {
                        setNameCheck({ state: 'available' })
                        update({ graphNameAvailable: true })
                        return
                    }
                    // Taken. If WE picked this name, pick a better one — don't hand
                    // the user an error they didn't cause.
                    if (isAutoName && res.suggestion) {
                        setAutoUniquifiedFrom(name)
                        setNameCheck({ state: 'checking' })
                        update({ graphName: res.suggestion, graphNameAvailable: undefined })
                        return
                    }
                    setNameCheck({
                        state: 'unavailable',
                        reason: res.reason ?? 'This name is taken.',
                        suggestion: res.suggestion ?? null,
                    })
                    update({ graphNameAvailable: false })
                })
                .catch(() => {
                    // Check unavailable (offline, transient) — don't block; the
                    // provisioning endpoint re-validates authoritatively.
                    if (checkSeq.current !== seq) return
                    setNameCheck({ state: 'idle' })
                    update({ graphNameAvailable: undefined })
                })
        }, 400)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope?.workspaceId, scope?.providerId, effectiveName, isAutoName])

    return {
        nameCheck,
        effectiveName,
        derivedName,
        autoUniquifiedFrom,
        isAutoName,
        /** The user typed a name: theirs from now on. */
        edit: (value: string) => {
            setAutoUniquifiedFrom(null)
            update({ graphName: value.toLowerCase(), graphNameIsAuto: false, graphNameAvailable: undefined })
        },
        /** Take the free name the server offered for a taken one. */
        acceptSuggestion: () => {
            if (nameCheck.state !== 'unavailable' || !nameCheck.suggestion) return
            setAutoUniquifiedFrom(null)
            update({ graphName: nameCheck.suggestion, graphNameIsAuto: false, graphNameAvailable: undefined })
        },
        /** Back to the derived name, kept in step again. */
        resetToDerived: () => {
            setAutoUniquifiedFrom(null)
            update({ graphName: derivedName, graphNameIsAuto: true, graphNameAvailable: undefined })
        },
    }
}

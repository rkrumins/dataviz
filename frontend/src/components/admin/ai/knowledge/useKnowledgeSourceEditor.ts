/**
 * State for the knowledge-source editor — the same idiom as the connection
 * editor: a draft diffed against what it opened with, problems as you type,
 * and secrets never sent back as the marker.
 */
import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
    aiAdminService, AI_ADMIN_KEYS,
    type AuthTypeFields, type KnowledgeSource, type KnowledgeSourceInput,
} from '@/services/aiAdminService'
import { authDraftFrom, authErrors, authInput, emptyAuth, type AuthDraft } from '../auth/authFields'
import { objectFrom, pairsFrom, type Pair } from '../ui/pairs'

/** Who asks a source. */
export const PERSONAS: { value: string; label: string }[] = [
    { value: 'help', label: 'Help & docs' },
    { value: 'data', label: 'Ask about data' },
]

export interface SourceDraft {
    name: string
    url: string
    auth: AuthDraft
    toolName: string
    argumentMap: Pair[]
    resultMap: { items: string; title: string; text: string; url: string }
    personas: string[]
    timeoutMs: string
    trustLabel: string
    enabled: boolean
}

export function emptySource(): SourceDraft {
    return {
        name: '', url: '', auth: emptyAuth('none'), toolName: '',
        argumentMap: [{ key: 'query', value: 'query' }],
        resultMap: { items: 'results', title: 'title', text: 'content', url: 'url' },
        personas: ['help'], timeoutMs: '4000', trustLabel: '', enabled: true,
    }
}

export function draftFromSource(s: KnowledgeSource): SourceDraft {
    return {
        name: s.name,
        url: s.url,
        auth: authDraftFrom(s.authType, s.authConfig, s.secrets),
        toolName: s.toolName,
        argumentMap: pairsFrom(s.argumentMap),
        resultMap: {
            items: s.resultMap?.items ?? '', title: s.resultMap?.title ?? '',
            text: s.resultMap?.text ?? '', url: s.resultMap?.url ?? '',
        },
        personas: [...(s.personas ?? [])],
        timeoutMs: String(s.timeoutMs ?? ''),
        trustLabel: s.trustLabel ?? '',
        enabled: s.enabled,
    }
}

export type SourceErrors = Partial<Record<'name' | 'url' | 'toolName' | 'timeoutMs' | 'text', string>> & {
    auth?: Record<string, string>
}

export function sourceErrors(d: SourceDraft, fields: AuthTypeFields | undefined): SourceErrors {
    const e: SourceErrors = {}
    if (!d.name.trim()) e.name = 'A source needs a name; answers are labelled with it.'
    if (!/^https?:\/\/[^/\s?#]+/i.test(d.url.trim())) e.url = 'Enter the MCP endpoint’s http(s) URL.'
    if (!d.toolName.trim()) e.toolName = 'Name the tool to call.'
    if (!d.resultMap.text.trim()) e.text = 'Say where each result’s text is.'
    const t = Number(d.timeoutMs)
    if (!Number.isInteger(t) || t < 100) e.timeoutMs = 'A whole number of milliseconds, at least 100.'
    const auth = authErrors(d.auth, fields)
    if (Object.keys(auth).length) e.auth = auth
    return e
}

export function toSourceInput(d: SourceDraft, fields: AuthTypeFields | undefined): KnowledgeSourceInput {
    const resultMap = Object.fromEntries(
        Object.entries(d.resultMap).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
    )
    return {
        name: d.name.trim(),
        url: d.url.trim(),
        ...authInput(d.auth, fields),
        toolName: d.toolName.trim(),
        argumentMap: objectFrom(d.argumentMap),
        resultMap,
        personas: d.personas,
        timeoutMs: Number(d.timeoutMs),
        trustLabel: d.trustLabel.trim() || null,
        enabled: d.enabled,
    }
}

export function useKnowledgeSourceEditor(source: KnowledgeSource | null, fields: AuthTypeFields | undefined) {
    const original = useMemo(() => (source ? draftFromSource(source) : emptySource()), [source])
    const [draft, setDraft] = useState<SourceDraft>(original)
    const qc = useQueryClient()
    const set = useCallback(<K extends keyof SourceDraft>(k: K, v: SourceDraft[K]) => {
        setDraft(d => ({ ...d, [k]: v }))
    }, [])
    const changed = useMemo(
        () => (Object.keys(original) as (keyof SourceDraft)[])
            .filter(k => JSON.stringify(original[k]) !== JSON.stringify(draft[k])),
        [original, draft],
    )
    const errors = useMemo(() => sourceErrors(draft, fields), [draft, fields])
    const valid = Object.keys(errors).length === 0 && Boolean(fields)
    const mutation = useMutation({
        mutationFn: (body: KnowledgeSourceInput) => (source
            ? aiAdminService.updateKnowledgeSource(source.id, body)
            : aiAdminService.createKnowledgeSource(body)),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.sources }) },
    })
    const save = useCallback(async (): Promise<KnowledgeSource | null> => {
        if (!valid) return null
        try {
            return await mutation.mutateAsync(toSourceInput(draft, fields))
        } catch {
            return null
        }
    }, [valid, mutation, draft, fields])

    return {
        draft, set,
        dirty: changed.length > 0,
        changedCount: changed.length,
        errors, valid,
        saving: mutation.isPending,
        saveError: mutation.error ? (mutation.error as Error).message : null,
        save,
    }
}

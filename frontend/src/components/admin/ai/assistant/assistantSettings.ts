/**
 * The assistant's settings as a form: a flat draft, its validation, the
 * patch it saves, what changes on save, and — in words — what it lets leave
 * the platform. Pure, so the tests can pin each.
 */
import type { AiSettings, AiSettingsPatch, Connection } from '@/services/aiAdminService'

export interface SettingsDraft {
    chatConnectionId: string
    fastConnectionId: string
    embeddingConnectionId: string
    personaData: boolean
    personaHelp: boolean
    sendDescriptions: boolean
    sendPropertyValues: boolean
    sendSampleValues: boolean
    maxResultRows: string
    redactPatterns: string[]
    maxStepsPerTurn: string
    dailyTokensPerUser: string
    maxConcurrentTurnsPerUser: string
    retentionDays: string
}

type NumberField = 'maxResultRows' | 'maxStepsPerTurn' | 'dailyTokensPerUser' | 'maxConcurrentTurnsPerUser' | 'retentionDays'

/** The server's ranges (`settings_store._validate_patch`). */
export const RANGES: Record<NumberField, [number, number]> = {
    maxResultRows: [1, 200],
    maxStepsPerTurn: [1, 16],
    dailyTokensPerUser: [1_000, 50_000_000],
    maxConcurrentTurnsPerUser: [1, 8],
    retentionDays: [1, 3650],
}

export const MAX_PATTERNS = 32

export function draftFromSettings(s: AiSettings): SettingsDraft {
    return {
        chatConnectionId: s.chatConnectionId ?? '',
        fastConnectionId: s.fastConnectionId ?? '',
        embeddingConnectionId: s.embeddingConnectionId ?? '',
        personaData: s.personas.data,
        personaHelp: s.personas.help,
        sendDescriptions: s.dataPolicy.sendDescriptions,
        sendPropertyValues: s.dataPolicy.sendPropertyValues,
        sendSampleValues: s.dataPolicy.sendSampleValues,
        maxResultRows: String(s.dataPolicy.maxResultRows),
        redactPatterns: [...s.dataPolicy.redactPatterns],
        maxStepsPerTurn: String(s.limits.maxStepsPerTurn),
        dailyTokensPerUser: String(s.limits.dailyTokensPerUser),
        maxConcurrentTurnsPerUser: String(s.limits.maxConcurrentTurnsPerUser),
        retentionDays: String(s.retentionDays),
    }
}

/**
 * Why a redaction pattern would be refused, or null.
 *
 * The server compiles them as Python regular expressions; the browser checks
 * them as JavaScript ones, after translating the Python-only spellings people
 * actually write — a leading `(?i)` and named groups — so a valid pattern is
 * never flagged here. The server checks again on save.
 */
export function patternError(pattern: string): string | null {
    if (!pattern.trim()) return 'Enter a pattern, or remove this row.'
    const flags = /^\(\?([aiLmsux]+)\)/.exec(pattern)?.[1] ?? ''
    const js = pattern
        .replace(/^\(\?[aiLmsux]+\)/, '')
        .replace(/\(\?P</g, '(?<')
        .replace(/\(\?P=(\w+)\)/g, '\\k<$1>')
    try {
        new RegExp(js, ['i', 'm', 's'].filter(f => flags.includes(f)).join(''))
        return null
    } catch (e) {
        return `Not a valid pattern: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}`
    }
}

export type SettingsErrors = Partial<Record<NumberField | 'redactPatterns', string>> & {
    patterns?: Record<number, string>
}

export function settingsErrors(d: SettingsDraft): SettingsErrors {
    const e: SettingsErrors = {}
    for (const [field, [min, max]] of Object.entries(RANGES) as [NumberField, [number, number]][]) {
        const n = Number(d[field])
        if (d[field].trim() === '' || !Number.isInteger(n) || n < min || n > max) {
            e[field] = `A whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`
        }
    }
    const patterns: Record<number, string> = {}
    d.redactPatterns.forEach((p, i) => {
        const err = patternError(p)
        if (err) patterns[i] = err
    })
    if (Object.keys(patterns).length) e.patterns = patterns
    if (d.redactPatterns.length > MAX_PATTERNS) e.redactPatterns = `At most ${MAX_PATTERNS} patterns.`
    return e
}

export function settingsPatch(d: SettingsDraft): AiSettingsPatch {
    return {
        chatConnectionId: d.chatConnectionId || null,
        fastConnectionId: d.fastConnectionId || null,
        embeddingConnectionId: d.embeddingConnectionId || null,
        personas: { data: d.personaData, help: d.personaHelp },
        dataPolicy: {
            sendDescriptions: d.sendDescriptions,
            sendPropertyValues: d.sendPropertyValues,
            sendSampleValues: d.sendSampleValues,
            maxResultRows: Number(d.maxResultRows),
            redactPatterns: d.redactPatterns,
        },
        limits: {
            maxStepsPerTurn: Number(d.maxStepsPerTurn),
            dailyTokensPerUser: Number(d.dailyTokensPerUser),
            maxConcurrentTurnsPerUser: Number(d.maxConcurrentTurnsPerUser),
        },
        retentionDays: Number(d.retentionDays),
    }
}

export interface SettingsChange {
    label: string
    from: string
    to: string
    /** Lets more leave the platform, or keeps it for longer. */
    widens?: boolean
}

/** Each difference between what is saved and the draft, in words. */
export function settingsChanges(saved: SettingsDraft, d: SettingsDraft, connections: Connection[]): SettingsChange[] {
    const name = (id: string, none: string) => (id ? connections.find(c => c.id === id)?.name ?? id : none)
    const onOff = (v: boolean) => (v ? 'on' : 'off')
    const sent = (v: boolean) => (v ? 'sent' : 'not sent')
    const out: SettingsChange[] = []
    const add = (changed: boolean, c: SettingsChange) => { if (changed) out.push(c) }

    add(saved.chatConnectionId !== d.chatConnectionId, {
        label: 'Chat connection', from: name(saved.chatConnectionId, 'none'), to: name(d.chatConnectionId, 'none'),
        widens: Boolean(d.chatConnectionId),
    })
    add(saved.fastConnectionId !== d.fastConnectionId, {
        label: 'Fast connection', from: name(saved.fastConnectionId, 'the chat connection'), to: name(d.fastConnectionId, 'the chat connection'),
    })
    add(saved.embeddingConnectionId !== d.embeddingConnectionId, {
        label: 'Embedding connection', from: name(saved.embeddingConnectionId, 'none'), to: name(d.embeddingConnectionId, 'none'),
    })
    add(saved.personaData !== d.personaData, { label: 'Ask about data', from: onOff(saved.personaData), to: onOff(d.personaData) })
    add(saved.personaHelp !== d.personaHelp, { label: 'Help & docs', from: onOff(saved.personaHelp), to: onOff(d.personaHelp) })
    for (const [key, label] of [
        ['sendDescriptions', 'Descriptions'],
        ['sendPropertyValues', 'Property values'],
        ['sendSampleValues', 'Sample values'],
    ] as const) {
        add(saved[key] !== d[key], { label, from: sent(saved[key]), to: sent(d[key]), widens: d[key] })
    }
    add(saved.maxResultRows !== d.maxResultRows, {
        label: 'Rows of a result sent', from: saved.maxResultRows, to: d.maxResultRows,
        widens: Number(d.maxResultRows) > Number(saved.maxResultRows),
    })
    const removed = saved.redactPatterns.filter(p => !d.redactPatterns.includes(p))
    const addedPatterns = d.redactPatterns.filter(p => !saved.redactPatterns.includes(p))
    add(removed.length > 0 || addedPatterns.length > 0, {
        label: 'Redaction patterns',
        from: `${saved.redactPatterns.length}`,
        to: `${d.redactPatterns.length}${addedPatterns.length ? ` (${addedPatterns.length} new)` : ''}${removed.length ? ` (${removed.length} removed)` : ''}`,
        widens: removed.length > 0,
    })
    for (const [key, label] of [
        ['maxStepsPerTurn', 'Steps per answer'],
        ['dailyTokensPerUser', 'Tokens per person per day'],
        ['maxConcurrentTurnsPerUser', 'Questions at once per person'],
    ] as const) {
        add(saved[key] !== d[key], { label, from: Number(saved[key]).toLocaleString(), to: Number(d[key]).toLocaleString() })
    }
    add(saved.retentionDays !== d.retentionDays, {
        label: 'Conversations kept for', from: `${saved.retentionDays} days`, to: `${d.retentionDays} days`,
        widens: Number(d.retentionDays) > Number(saved.retentionDays),
    })
    return out
}

/** What a policy sends to the model, and what it never sends, in plain words. */
export function whatLeaves(d: SettingsDraft): { sent: string[]; withheld: string[] } {
    const sent = [
        'The question, the conversation so far, and the names, types and locations of the assets needed to answer it.',
    ]
    const withheld: string[] = []
    ;(d.sendDescriptions ? sent : withheld).push('Descriptions written on assets and views.')
    ;(d.sendPropertyValues ? sent : withheld).push('Property values such as owner, classification and tags.')
    ;(d.sendSampleValues ? sent : withheld).push('Sample values from columns.')
    const rows = Number(d.maxResultRows)
    if (Number.isInteger(rows) && rows > 0) sent.push(`At most ${rows.toLocaleString()} rows of any result.`)
    const n = d.redactPatterns.filter(p => p.trim()).length
    if (n) sent.push(`Text matching ${n === 1 ? 'the redaction pattern is' : `any of ${n} redaction patterns is`} replaced by [redacted] first.`)
    withheld.push('Anything the person asking cannot open: the assistant reads with their own access.')
    return { sent, withheld }
}

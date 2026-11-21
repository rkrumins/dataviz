/**
 * A conversation as the panel shows it: the person's questions and the assistant's answers, each
 * answer built up event by event as it streams (`applyFrame`), or read back whole from a stored
 * conversation (`turnsFromConversation`). Pure: the same frames always build the same answer.
 */
import type {
    AssistantAction, Block, Clarification, Conversation, Step, StoredMessage, TurnError,
} from '../api/types'
import type { SseFrame } from './sseStream'

export type TurnStatus = 'streaming' | 'ok' | 'clarify' | 'error' | 'stopped'

export interface UserTurn {
    role: 'user'
    id: string
    text: string
}

export interface AssistantTurn {
    role: 'assistant'
    /** Local id while streaming; the stored message's once known. */
    id: string
    /** The stored message (`meta.messageId`) — what feedback is about. */
    messageId: string | null
    text: string
    blocks: Block[]
    steps: Step[]
    actions: AssistantAction[]
    followups: string[]
    status: TurnStatus
    error: TurnError | null
    feedback: 1 | -1 | null
    /** Set from the `done` frame: the stream finished, rather than being cut off. */
    finished: boolean
}

export type Turn = UserTurn | AssistantTurn

let seq = 0
export const localId = (prefix: string) => `${prefix}_local_${Date.now().toString(36)}_${(seq++).toString(36)}`

export function emptyAssistantTurn(id = localId('msg')): AssistantTurn {
    return {
        role: 'assistant', id, messageId: null, text: '', blocks: [], steps: [], actions: [], followups: [],
        status: 'streaming', error: null, feedback: null, finished: false,
    }
}

function parse(data: string): unknown {
    try { return JSON.parse(data) } catch { return undefined }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function upsertStep(steps: Step[], step: Step): Step[] {
    const at = steps.findIndex((s) => s.id === step.id)
    if (at === -1) return [...steps, step]
    const next = steps.slice()
    next[at] = { ...steps[at], ...step }
    return next
}

/** Steps still "running" when the answer ends, settled the way the answer did. */
function settleSteps(steps: Step[], status: TurnStatus): Step[] {
    if (!steps.some((s) => s.status === 'running')) return steps
    const to = status === 'error' ? 'error' : 'done'
    return steps.map((s) => (s.status === 'running' ? { ...s, status: to } : s))
}

/** One event of the stream, applied to the answer it belongs to. Unknown events change nothing. */
export function applyFrame(turn: AssistantTurn, frame: SseFrame): AssistantTurn {
    const data = parse(frame.data)
    switch (frame.event) {
        case 'meta':
            return isObject(data) && typeof data.messageId === 'string' ? { ...turn, messageId: data.messageId } : turn
        case 'step':
            return isObject(data) && typeof data.id === 'string'
                ? { ...turn, steps: upsertStep(turn.steps, data as unknown as Step) } : turn
        case 'text':
            return isObject(data) && typeof data.delta === 'string' ? { ...turn, text: turn.text + data.delta } : turn
        case 'block': {
            if (!isObject(data) || typeof data.id !== 'string' || typeof data.type !== 'string') return turn
            if (turn.blocks.some((b) => b.id === data.id)) return turn
            return { ...turn, blocks: [...turn.blocks, data as unknown as Block] }
        }
        case 'clarify': {
            if (!isObject(data) || typeof data.id !== 'string') return turn
            const clarify: Block = { id: data.id, type: 'clarify', data: { ...(data as unknown as Clarification), answered: false } }
            return { ...turn, blocks: [...turn.blocks.filter((b) => b.id !== data.id), clarify], status: 'clarify' }
        }
        case 'actions':
            return Array.isArray(data) ? { ...turn, actions: [...turn.actions, ...(data as AssistantAction[])] } : turn
        case 'followups':
            return Array.isArray(data) ? { ...turn, followups: data.filter((q): q is string => typeof q === 'string') } : turn
        case 'error': {
            const err = isObject(data) ? data : {}
            return {
                ...turn, status: 'error',
                error: { code: typeof err.code === 'string' ? err.code : 'internal', message: typeof err.message === 'string' ? err.message : '' },
            }
        }
        case 'done': {
            const said = isObject(data) ? data.status : undefined
            const status: TurnStatus = turn.status === 'error' || said === 'error' ? 'error'
                : said === 'clarify' || turn.status === 'clarify' ? 'clarify' : 'ok'
            return { ...turn, status, finished: true, steps: settleSteps(turn.steps, status) }
        }
        default:
            return turn
    }
}

/** The answer did not come to an end of its own: stopped by the person, or cut off. */
export function endTurn(turn: AssistantTurn, how: 'stopped' | TurnError): AssistantTurn {
    if (turn.finished && how !== 'stopped') return turn
    if (how === 'stopped') return { ...turn, status: 'stopped', steps: settleSteps(turn.steps, 'stopped') }
    return { ...turn, status: 'error', error: how, steps: settleSteps(turn.steps, 'error') }
}

/** A clarification answered here: it shows what was chosen, and asks no more. */
export function markClarified(turn: AssistantTurn, clarificationId: string, optionId?: string): AssistantTurn {
    return {
        ...turn,
        blocks: turn.blocks.map((b) => (b.type === 'clarify' && b.id === clarificationId
            ? { ...b, data: { ...b.data, answered: true, ...(optionId ? { chosen: optionId } : {}) } } : b)),
    }
}

function fromStored(m: StoredMessage): Turn {
    if (m.role === 'user') return { role: 'user', id: m.id, text: m.content }
    const status: TurnStatus = m.status === 'error' ? 'error' : m.status === 'clarify' ? 'clarify' : 'ok'
    return {
        role: 'assistant', id: m.id, messageId: m.id, text: m.content ?? '',
        blocks: m.blocks ?? [], steps: m.steps ?? [], actions: m.actions ?? [], followups: m.followups ?? [],
        status, error: status === 'error' ? { code: 'internal', message: '' } : null,
        feedback: m.feedback ?? null, finished: true,
    }
}

export function turnsFromConversation(c: Conversation): Turn[] {
    return c.messages.map(fromStored)
}

/** The answer as plain text, for Copy: its words, then what its cards found. */
export function answerAsText(turn: AssistantTurn): string {
    const parts = [turn.text.trim()]
    for (const b of turn.blocks) {
        if (b.type === 'results') {
            parts.push(`${b.data.title} — ${b.data.total.toLocaleString()}${b.data.totalExact ? '' : '+'}`,
                ...b.data.items.map((e) => `- ${e.name} (${e.type})`))
        } else if (b.type === 'impact') {
            parts.push(b.data.summary)
        } else if (b.type === 'citations') {
            parts.push(...b.data.items.map((c) => `[${c.n}] ${c.title}${c.section ? ` — ${c.section}` : ''}${c.href ? ` (${c.href})` : ''}`))
        }
    }
    return parts.filter(Boolean).join('\n\n')
}

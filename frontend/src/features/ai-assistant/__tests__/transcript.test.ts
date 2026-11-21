/**
 * An answer built from its stream, event by event, and the text around it: citations linked,
 * a stop or a cut-off said, a stored conversation read back.
 */
import { describe, expect, it } from 'vitest'

import type { ContextBrief } from '../api/types'
import { linkCitations } from '../lib/citations'
import type { SseFrame } from '../lib/sseStream'
import { answerAsText, applyFrame, emptyAssistantTurn, endTurn, markClarified, turnsFromConversation } from '../lib/transcript'

const f = (event: string, data: unknown): SseFrame => ({ event, data: JSON.stringify(data) })

describe('applyFrame', () => {
    it('builds an answer from the contract’s events, in order', () => {
        const frames = [
            f('meta', { conversationId: 'c1', messageId: 'm1', persona: 'data', contractVersion: 1 }),
            f('step', { id: 's1', label: 'Finding first_name', status: 'running' }),
            f('step', { id: 's1', label: 'Finding first_name', status: 'done', detail: '1 match' }),
            f('step', { id: 's2', label: 'Walking downstream', status: 'running' }),
            f('text', { delta: 'Dropping it ' }),
            f('text', { delta: 'breaks 3 dashboards.' }),
            f('block', { id: 'b1', type: 'notice', data: { tone: 'info', text: 'Rolled up.' } }),
            f('block', { id: 'b1', type: 'notice', data: { tone: 'info', text: 'Rolled up.' } }),
            f('actions', [{ id: 'a1', kind: 'open_view', label: 'Open view', payload: { viewId: 'v1' } }]),
            f('followups', ['Who owns these?']),
            f('usage', { inputTokens: 10, outputTokens: 5, model: 'm' }),
            f('done', { status: 'ok' }),
        ]
        const turn = frames.reduce(applyFrame, emptyAssistantTurn('t1'))
        expect(turn.messageId).toBe('m1')
        expect(turn.text).toBe('Dropping it breaks 3 dashboards.')
        expect(turn.steps).toEqual([
            { id: 's1', label: 'Finding first_name', status: 'done', detail: '1 match' },
            // Still running when the answer ended: settled with it.
            { id: 's2', label: 'Walking downstream', status: 'done' },
        ])
        expect(turn.blocks).toHaveLength(1)
        expect(turn.actions).toHaveLength(1)
        expect(turn.followups).toEqual(['Who owns these?'])
        expect(turn).toMatchObject({ status: 'ok', finished: true })
    })

    it('ends a turn on a clarification, kept as a block the card is drawn from', () => {
        const clarify = { id: 'clr_1', question: 'Which means PII?', options: [{ id: 'o1', label: 'Tag “pii”', count: 312 }] }
        const turn = [f('clarify', clarify), f('done', { status: 'clarify' })].reduce(applyFrame, emptyAssistantTurn())
        expect(turn.status).toBe('clarify')
        expect(turn.blocks).toEqual([{ id: 'clr_1', type: 'clarify', data: { ...clarify, answered: false } }])
        const answered = markClarified(turn, 'clr_1', 'o1')
        expect(answered.blocks[0].data).toMatchObject({ answered: true, chosen: 'o1' })
    })

    it('says what failed, and keeps the failure past done', () => {
        const turn = [f('step', { id: 's', label: 'x', status: 'running' }), f('error', { code: 'busy', message: 'Busy.' }), f('done', { status: 'error' })]
            .reduce(applyFrame, emptyAssistantTurn())
        expect(turn).toMatchObject({ status: 'error', error: { code: 'busy', message: 'Busy.' } })
        expect(turn.steps[0].status).toBe('error')
    })

    it('ignores what it cannot read', () => {
        const before = emptyAssistantTurn()
        expect(applyFrame(before, { event: 'text', data: 'not json' })).toBe(before)
        expect(applyFrame(before, f('mystery', {}))).toBe(before)
    })
})

describe('endTurn', () => {
    it('a stop keeps what arrived', () => {
        const turn = applyFrame(emptyAssistantTurn(), f('text', { delta: 'Half' }))
        expect(endTurn(turn, 'stopped')).toMatchObject({ status: 'stopped', text: 'Half' })
    })

    it('a stream that ends without done was cut off — but one that finished is left alone', () => {
        const cut = endTurn(emptyAssistantTurn(), { code: 'interrupted', message: 'x' })
        expect(cut.status).toBe('error')
        const done = applyFrame(emptyAssistantTurn(), f('done', { status: 'ok' }))
        expect(endTurn(done, { code: 'interrupted', message: 'x' })).toBe(done)
    })
})

describe('a stored conversation', () => {
    it('reads back as turns, its answers finished', () => {
        const turns = turnsFromConversation({
            id: 'c1', title: 'PII', persona: 'data', messages: [
                { id: 'm1', role: 'user', content: 'Which tables hold PII?' },
                { id: 'm2', role: 'assistant', content: 'These.', blocks: [], steps: [], followups: ['And last week?'], status: 'ok', feedback: 1 },
            ],
        })
        expect(turns[0]).toEqual({ role: 'user', id: 'm1', text: 'Which tables hold PII?' })
        expect(turns[1]).toMatchObject({ role: 'assistant', messageId: 'm2', text: 'These.', feedback: 1, finished: true, status: 'ok' })
    })

    it('keeps a stored “what I know” card as it was', () => {
        const brief: ContextBrief = {
            kind: 'view', about: { name: 'Supply chain', workspace: 'Operations' },
            layers: [{ name: 'Sources', types: ['dataset'] }], hierarchy: { chains: [['container', 'dataset']] },
            caveats: [{ code: 'no_lineage', text: 'No lineage here.' }], notes: [],
        }
        const block = { id: 'b1', type: 'context' as const, data: brief }
        const [, answer] = turnsFromConversation({
            id: 'c1', title: 'Context', persona: 'data', messages: [
                { id: 'm1', role: 'user', content: 'What do you know about this view?' },
                { id: 'm2', role: 'assistant', content: 'This.', blocks: [block], status: 'ok' },
            ],
        })
        expect(answer).toMatchObject({ blocks: [block] })
        // And live, from the stream.
        expect(applyFrame(emptyAssistantTurn(), f('block', block)).blocks).toEqual([block])
    })
})

describe('linkCitations', () => {
    it('links [n] the sources carry, and nothing else', () => {
        expect(linkCitations('Share it [1], then [3].', new Set([1]))).toBe('Share it [\\[1\\]](#cite-1), then [3].')
    })

    it('leaves code alone', () => {
        expect(linkCitations('Use `arr[1]` as in [1].\n```\nx[1]\n```', new Set([1])))
            .toBe('Use `arr[1]` as in [\\[1\\]](#cite-1).\n```\nx[1]\n```')
    })

    it('leaves existing links alone', () => {
        expect(linkCitations('[1](http://a) and [1]: def', new Set([1]))).toBe('[1](http://a) and [1]: def')
    })
})

describe('answerAsText', () => {
    it('copies the words and what the cards found', () => {
        const turn = { ...emptyAssistantTurn(), text: 'Two tables.', blocks: [{ id: 'r', type: 'results' as const, data: {
            title: 'PII tables', total: 2, totalExact: true, items: [{ urn: 'u1', name: 'customers', type: 'dataset' }, { urn: 'u2', name: 'orders', type: 'dataset' }],
        } }] }
        expect(answerAsText(turn)).toBe('Two tables.\n\nPII tables — 2\n\n- customers (dataset)\n\n- orders (dataset)')
    })
})

/**
 * The first questions offered: on a view, drawn from what the assistant knows about it (how its
 * layers connect, who owns or what holds PII, what kinds of thing a generic schema holds); on a
 * page, about that page; with a selection, or knowing nothing yet, the questions it always had.
 */
import { describe, expect, it } from 'vitest'

import { GENERIC_BRIEF, VIEW_BRIEF, WORKSPACE_BRIEF } from '@/harness/aiFixtures'

import type { ContextBrief } from '../api/types'
import { starterPrompts, type StarterSituation } from '../lib/starterPrompts'

const onView: StarterSituation = { onView: true, selectedCount: 0, focused: false, page: { kind: 'view', id: 'v1', title: 'Supply chain' } }
const at = (page: StarterSituation['page']): StarterSituation => ({ onView: false, selectedCount: 0, focused: false, page })

describe('starterPrompts', () => {
    it('on a view with layers: what it knows, how data flows through them, and PII', () => {
        expect(starterPrompts('data', onView, VIEW_BRIEF)).toEqual([
            'What do you know about this view?',
            'How does data flow from Sources to Reports?',
            'Which columns hold PII?',
        ])
    })

    it('without layers, what feeds the end of the lineage; with an owner property, who owns it', () => {
        const brief: ContextBrief = {
            ...VIEW_BRIEF, layers: [],
            contents: { ...VIEW_BRIEF.contents!, tags: [], properties: [{ key: 'owner', count: 10, coverage: 1, kinds: ['string'] }] },
        }
        expect(starterPrompts('data', onView, brief)).toEqual([
            'What do you know about this view?', 'What feeds the charts?', 'Who owns the columns?',
        ])
    })

    it('on a generic schema, asks what kinds of thing are in it', () => {
        expect(starterPrompts('data', onView, GENERIC_BRIEF)).toEqual([
            'What do you know about this view?', 'Who owns the tables?', 'What kinds of things are in here?',
        ])
    })

    it('keeps the questions about a selection, and those it had before it knew the view', () => {
        expect(starterPrompts('data', { ...onView, selectedCount: 2 }, VIEW_BRIEF)[0]).toBe('What breaks if this changes?')
        expect(starterPrompts('data', onView, null)).toEqual([
            'What does this view show?', 'Which tables here hold PII?', 'Do we have views about supply-chain failures?',
        ])
    })

    it('on a workspace page, asks about the workspace', () => {
        expect(starterPrompts('data', at({ kind: 'workspace', id: 'ws' }), WORKSPACE_BRIEF)[0]).toBe('What’s in Operations?')
        expect(starterPrompts('data', at({ kind: 'data_source', id: 'c1', title: 'Snowflake prod' }))[0]).toBe('How is Snowflake prod organised?')
        expect(starterPrompts('data', at({ kind: 'ontology', id: 'o1', title: 'Supply chain v3' }))[0]).toBe('Explain the Supply chain v3 semantic layer')
    })

    it('on a guide page, Help offers to summarise it', () => {
        expect(starterPrompts('help', at({ kind: 'doc', id: '/guide/ai-assistant', title: 'The AI assistant' }))).toEqual([
            'Summarise this page', 'How do I share a view?', 'What is a data source?',
        ])
        expect(starterPrompts('help', at(null))[0]).toBe('How do I share a view?')
    })
})

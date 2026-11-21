/**
 * The assistant's store: open / close / toggle, the persona, what a launcher hands it (taken
 * once), the page left out of the question, the conversation on screen, and the rail's width.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { emptyAssistantTurn } from '../lib/transcript'
import { useAssistantStore } from '../store/assistantStore'

const initial = useAssistantStore.getState()
beforeEach(() => useAssistantStore.setState(initial, true))

describe('assistantStore', () => {
    it('opens, closes and toggles', () => {
        const s = () => useAssistantStore.getState()
        expect(s().open).toBe(false)
        s().openAssistant()
        expect(s().open).toBe(true)
        s().closeAssistant()
        expect(s().open).toBe(false)
        s().toggleAssistant()
        expect(s().open).toBe(true)
        s().toggleAssistant()
        expect(s().open).toBe(false)
    })

    it('keeps its persona unless a launcher names one', () => {
        const s = () => useAssistantStore.getState()
        s().setPersona('help')
        s().openAssistant()
        expect(s().persona).toBe('help')
        s().openAssistant({ persona: 'data' })
        expect(s().persona).toBe('data')
    })

    it('hands a launcher’s question over once, and keeps what it was about', () => {
        const s = () => useAssistantStore.getState()
        s().openAssistant({ context: { focusUrn: 'urn:t', focusName: 'orders', prompt: 'What breaks if this changes?' } })
        expect(s().consumePrompt()).toBe('What breaks if this changes?')
        expect(s().consumePrompt()).toBeNull()
        expect(s().pendingContext).toEqual({ focusUrn: 'urn:t', focusName: 'orders', prompt: undefined })
    })

    it('leaves a page out of the question until a launcher brings context back', () => {
        const s = () => useAssistantStore.getState()
        s().openAssistant({ context: { focusUrn: 'urn:t' } })
        s().detachContext('view:v1')
        expect(s().detachedFrom).toBe('view:v1')
        expect(s().pendingContext).toBeNull()
        s().attachContext()
        expect(s().detachedFrom).toBeNull()
        s().detachContext('view:v1')
        s().openAssistant({ context: { focusUrn: 'urn:u' } })
        expect(s().detachedFrom).toBeNull()
    })

    it('puts a conversation on screen, updates one answer in it, and starts over', () => {
        const s = () => useAssistantStore.getState()
        const answer = emptyAssistantTurn('a1')
        s().appendTurns({ role: 'user', id: 'q1', text: 'Hi' }, answer)
        s().updateTurn('a1', (t) => ({ ...t, text: 'Hello' }))
        expect(s().turns).toHaveLength(2)
        expect(s().turns[1]).toMatchObject({ role: 'assistant', text: 'Hello' })
        s().setConversationId('conv_1')
        expect(s().conversationId).toBe('conv_1')
        s().newChat()
        expect(s().conversationId).toBeNull()
        expect(s().turns).toEqual([])
        s().showConversation('conv_2', [], true)
        expect(s()).toMatchObject({ conversationId: 'conv_2', loadingConversation: true })
    })

    it('keeps the width the person dragged it to', () => {
        useAssistantStore.getState().setRailWidth(512)
        expect(useAssistantStore.getState().railWidth).toBe(512)
    })
})

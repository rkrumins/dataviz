/**
 * Which editor the query card opens in: the one this browser chose last,
 * else the persona's — Sentence for Business, Form for Technical — and one
 * choice shared by everything that asks, so the panel knows when the
 * Sentence already shows the query.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { usePersonaStore } from '@/store/persona'

import { defaultEditorMode, EDITOR_MODE_KEY, useEditorMode } from '../builderMode'


describe('builder mode', () => {
    beforeEach(() => {
        localStorage.clear()
        usePersonaStore.setState({ mode: 'business' })
    })

    it('starts Business in Sentence and Technical in Form', () => {
        expect(defaultEditorMode('business')).toBe('sentence')
        expect(defaultEditorMode('technical')).toBe('form')
        expect(renderHook(() => useEditorMode()).result.current[0]).toBe('sentence')
        act(() => usePersonaStore.setState({ mode: 'technical' }))
        expect(renderHook(() => useEditorMode()).result.current[0]).toBe('form')
    })

    it('opens in the editor this browser chose, whatever the persona', () => {
        localStorage.setItem(EDITOR_MODE_KEY, 'cypher')
        expect(renderHook(() => useEditorMode()).result.current[0]).toBe('cypher')
    })

    it('reads the old "visual" default as no choice at all', () => {
        localStorage.setItem(EDITOR_MODE_KEY, 'visual')
        expect(renderHook(() => useEditorMode()).result.current[0]).toBe('sentence')
    })

    it('remembers a choice, and every reader sees it at once', () => {
        const card = renderHook(() => useEditorMode())
        const panel = renderHook(() => useEditorMode())
        act(() => card.result.current[1]('code'))
        expect(localStorage.getItem(EDITOR_MODE_KEY)).toBe('code')
        expect(panel.result.current[0]).toBe('code')
    })
})

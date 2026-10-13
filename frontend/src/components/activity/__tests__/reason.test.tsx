/**
 * Asking why: optional, one click for the usual reasons, one keystroke to skip,
 * and honest about who will read it.
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Trash2 } from 'lucide-react'
import { beforeEach, describe, expect, it } from 'vitest'

import { ReasonField } from '../ReasonField'
import { REASON_READERS } from '../reasonPresets'
import { useReasonDraft } from '../useReasonDraft'
import { useReasonPrompt, type ReasonAnswer, type ReasonPromptOptions } from '../useReasonPrompt'

beforeEach(() => localStorage.clear())

function Field({ audience = 'workspace' as const }: { audience?: 'workspace' | 'platform' }) {
    const draft = useReasonDraft('cancel')
    return (
        <>
            <ReasonField draft={draft} audience={audience} note="It also shows on the run." />
            <output data-testid="value">{draft.value}</output>
        </>
    )
}

describe('ReasonField', () => {
    it('fills the reason from a chip and says who can read it', async () => {
        const user = userEvent.setup()
        render(<Field />)
        await user.click(screen.getByRole('button', { name: 'Wrong settings' }))
        expect(screen.getByTestId('value')).toHaveTextContent('Wrong settings')
        expect(screen.getByRole('button', { name: 'Wrong settings' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('textbox', { name: /why\?/i })).toHaveAccessibleDescription(
            `${REASON_READERS.workspace} It also shows on the run.`,
        )
    })

    it('names auditors only, for a change no workspace admin can see', () => {
        render(<Field audience="platform" />)
        expect(screen.getByText(/which auditors can read/)).toBeInTheDocument()
        expect(screen.queryByText(/workspace’s admins/)).not.toBeInTheDocument()
    })

    it('offers back the reasons this person gave before, for the same kind of change', () => {
        const first = renderHook(() => useReasonDraft('cancel'))
        act(() => first.result.current.setValue('Graph store maintenance tonight'))
        let taken: string | undefined
        act(() => { taken = first.result.current.take() })
        expect(taken).toBe('Graph store maintenance tonight')
        first.unmount()

        render(<Field />)
        expect(screen.getByRole('button', { name: 'Graph store maintenance tonight' })).toBeInTheDocument()
    })

    it('takes nothing when nothing was said', () => {
        const { result } = renderHook(() => useReasonDraft('cancel'))
        act(() => result.current.setValue('   '))
        expect(result.current.take()).toBeUndefined()
    })
})

function PromptHost({ options, onAnswer }: {
    options: ReasonPromptOptions
    onAnswer: (answer: ReasonAnswer | null) => void
}) {
    const [prompt, ask] = useReasonPrompt()
    return (
        <>
            <button onClick={() => void ask(options).then(onAnswer)}>Stop run</button>
            {prompt}
        </>
    )
}

const OPTIONS: ReasonPromptOptions = {
    title: 'Stop this run?',
    message: 'Cancels the aggregation run.',
    confirmLabel: 'Yes, stop it',
    confirmIcon: Trash2,
    context: 'cancel',
    audience: 'workspace',
    tone: 'danger',
}

describe('useReasonPrompt', () => {
    it('confirms with Enter — with the reason when one was typed', async () => {
        const answers: (ReasonAnswer | null)[] = []
        const user = userEvent.setup()
        render(<PromptHost options={OPTIONS} onAnswer={(a) => answers.push(a)} />)

        await user.click(screen.getByRole('button', { name: 'Stop run' }))
        expect(screen.getByText('Stop this run?')).toBeInTheDocument()
        await user.keyboard('Started by mistake{Enter}')
        await waitFor(() => expect(answers).toEqual([{ reason: 'Started by mistake' }]))
        expect(screen.queryByText('Stop this run?')).not.toBeInTheDocument()

        // A reason is never required: straight to Enter goes ahead without one.
        await user.click(screen.getByRole('button', { name: 'Stop run' }))
        expect(screen.getByRole('textbox', { name: /why\?/i })).toHaveValue('')
        await user.keyboard('{Enter}')
        await waitFor(() => expect(answers).toEqual([{ reason: 'Started by mistake' }, { reason: undefined }]))
    })

    it('answers null when backed out of, by Escape or Cancel', async () => {
        const answers: (ReasonAnswer | null)[] = []
        const user = userEvent.setup()
        render(<PromptHost options={OPTIONS} onAnswer={(a) => answers.push(a)} />)

        await user.click(screen.getByRole('button', { name: 'Stop run' }))
        await user.keyboard('{Escape}')
        await user.click(screen.getByRole('button', { name: 'Stop run' }))
        await user.click(screen.getByRole('button', { name: 'Cancel' }))
        await waitFor(() => expect(answers).toEqual([null, null]))
    })
})

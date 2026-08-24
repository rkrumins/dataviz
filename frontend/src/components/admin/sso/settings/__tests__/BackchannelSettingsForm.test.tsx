/**
 * The gateway form has to be wide enough that a second enterprise is a
 * form rather than a release — and narrow enough that the fields on
 * screen are the ones that apply.
 *
 * Two things are worth pinning. The conditional fields: asking for a
 * header name when the token goes in the body is how an operator fills
 * in a value that is silently ignored and then cannot work out why the
 * login fails. And the defaults, because they are the difference
 * between a form that works when you only fill in the obvious parts and
 * one that needs the Advanced JSON editor to be usable at all.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
    BackchannelSettingsForm, DEFAULT_BACKCHANNEL_SETTINGS,
    type BackchannelSettings,
} from '../BackchannelSettingsForm'

function renderForm(value: BackchannelSettings = {}) {
    const onChange = vi.fn()
    render(<BackchannelSettingsForm value={value} onChange={onChange} />)
    return onChange
}

describe('the ambient token', () => {
    it('asks for a cookie name or a header name, never both', async () => {
        const { rerender } = render(
            <BackchannelSettingsForm value={{ token_source: 'cookie' }} onChange={vi.fn()} />,
        )
        expect(screen.getByText('Cookie name')).toBeInTheDocument()
        expect(screen.queryByText('Header name')).not.toBeInTheDocument()

        rerender(
            <BackchannelSettingsForm value={{ token_source: 'header' }} onChange={vi.fn()} />,
        )
        expect(screen.getByText('Header name')).toBeInTheDocument()
        expect(screen.queryByText('Cookie name')).not.toBeInTheDocument()
    })

    it('says the value is never read, only handed back', () => {
        // The single most load-bearing fact about this kind, and the one
        // an operator is most likely to assume the opposite of.
        renderForm()
        expect(
            screen.getByText(/never read what is inside it/i),
        ).toBeInTheDocument()
    })
})

describe('where the token goes on each call', () => {
    it('asks for a header name only when the token travels in a header', async () => {
        const { rerender } = render(
            <BackchannelSettingsForm
                value={{ gateway_send_as: 'cookie' }} onChange={vi.fn()} />,
        )
        expect(screen.queryByPlaceholderText('Authorization')).not.toBeInTheDocument()

        rerender(
            <BackchannelSettingsForm
                value={{ gateway_send_as: 'header' }} onChange={vi.fn()} />,
        )
        expect(screen.getByPlaceholderText('Authorization')).toBeInTheDocument()
    })

    it('asks for a body field only when the token travels in the body', () => {
        const { rerender } = render(
            <BackchannelSettingsForm
                value={{ gateway_send_as: 'header' }} onChange={vi.fn()} />,
        )
        expect(screen.queryByPlaceholderText('sessionId')).not.toBeInTheDocument()

        rerender(
            <BackchannelSettingsForm
                value={{ gateway_send_as: 'body' }} onChange={vi.fn()} />,
        )
        expect(screen.getByPlaceholderText('sessionId')).toBeInTheDocument()
    })
})

describe('the optional second call', () => {
    it('hides its details until there is somewhere to send them', () => {
        renderForm({ exchange_url: '' })
        expect(screen.queryByPlaceholderText('token')).not.toBeInTheDocument()
    })

    it('shows them once an exchange endpoint is named', () => {
        renderForm({ exchange_url: 'https://gw.corp.internal/userinfo' })
        expect(screen.getByPlaceholderText('token')).toBeInTheDocument()
    })

    it('tells the operator that leaving it blank is a real option', () => {
        // Otherwise every integration configures two calls, including
        // the ones whose gateway already answers with the user.
        renderForm()
        expect(screen.getByText(/skips a round trip/i)).toBeInTheDocument()
    })
})

describe('defaults', () => {
    it('turns the liveness re-check on', () => {
        // Off by default would mean the gap this kind exists to close —
        // our session outliving the enterprise session — stays open for
        // anyone who does not go looking for the switch.
        expect(DEFAULT_BACKCHANNEL_SETTINGS.liveness_on_refresh).toBe(true)
        expect(DEFAULT_BACKCHANNEL_SETTINGS.require_auth_time).toBe(true)
    })

    it('renders both toggles on for a row that has never been edited', () => {
        renderForm({})
        const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
        expect(boxes).toHaveLength(2)
        expect(boxes.every(b => b.checked)).toBe(true)
    })

    it('respects an explicit false rather than treating it as unset', async () => {
        renderForm({ liveness_on_refresh: false, require_auth_time: false })
        const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
        expect(boxes.some(b => b.checked)).toBe(false)
    })
})

describe('editing', () => {
    it('reports a change without dropping the rest of the settings', async () => {
        const onChange = renderForm({
            token_source_key: 'CORPSESSION',
            gateway_url: 'https://gw.corp.internal/token',
        })
        await userEvent.type(
            screen.getByPlaceholderText('access_token'), 'x',
        )
        const next = onChange.mock.calls.at(-1)![0]
        expect(next.token_source_key).toBe('CORPSESSION')
        expect(next.gateway_url).toBe('https://gw.corp.internal/token')
    })

    it('keeps the stored headers when the JSON is mid-edit', async () => {
        // A half-typed object is not an instruction to delete the
        // headers, and silently clearing an app secret because a brace
        // was missing is the kind of thing nobody notices until logins
        // start failing.
        const onChange = renderForm({ gateway_headers: { 'X-App-Id': 'a' } })
        const boxes = screen.getAllByPlaceholderText(/X-App-Id/)
        await userEvent.clear(boxes[0])
        await userEvent.type(boxes[0], '{{ "X-App-Id"')
        boxes[0].blur()
        const headerCalls = onChange.mock.calls.filter(
            ([next]) => 'gateway_headers' in next,
        )
        expect(headerCalls).toHaveLength(0)
    })
})

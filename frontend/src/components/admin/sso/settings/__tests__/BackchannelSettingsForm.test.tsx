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

describe('the gateway cookie name', () => {
    it('is offered only when the token travels as a cookie', () => {
        // It names the cookie we SEND. On a header or body transport
        // there is no cookie, so the field would be a value that gets
        // silently ignored.
        const { rerender } = render(
            <BackchannelSettingsForm
                value={{ gateway_send_as: 'header' }} onChange={vi.fn()} />,
        )
        expect(screen.queryByText(/different cookie name/i)).not.toBeInTheDocument()

        rerender(
            <BackchannelSettingsForm
                value={{ gateway_send_as: 'cookie' }} onChange={vi.fn()} />,
        )
        expect(screen.getByText(/different cookie name/i)).toBeInTheDocument()
    })

    it('is optional, and says what happens when it is left blank', () => {
        // The backend already falls back to the name we read it from,
        // and token_source_key is required, so the fallback always
        // resolves. An operator should not have to discover that by
        // reading the source.
        renderForm({ gateway_send_as: 'cookie', token_source_key: 'CORPSESSION' })
        // Matched on the distinctive half: "leave blank" also appears on
        // the exchange URL, which is a different optional thing.
        expect(screen.getByText(/the name we read it from/i)).toBeInTheDocument()
        // And it names the actual cookie rather than saying "the same one".
        expect(screen.getByText('CORPSESSION')).toBeInTheDocument()
    })

    it('is marked optional rather than required', () => {
        renderForm({ gateway_send_as: 'cookie' })
        expect(
            screen.getByText(/different cookie name/i).textContent,
        ).toMatch(/optional/i)
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

    // Asserted by name rather than by counting. A count breaks whenever
    // a toggle is added, which says nothing about whether the defaults
    // are right — and the point of these is which way each one points.
    const toggle = (name: RegExp) =>
        screen.getByRole('checkbox', { name }) as HTMLInputElement

    it('has the two behaviour toggles on for a row never edited', () => {
        renderForm({})
        expect(toggle(/re-check with the provider/i).checked).toBe(true)
        expect(toggle(/require an authentication time/i).checked).toBe(true)
    })

    it('respects an explicit false rather than treating it as unset', async () => {
        renderForm({ liveness_on_refresh: false, require_auth_time: false })
        expect(toggle(/re-check with the provider/i).checked).toBe(false)
        expect(toggle(/require an authentication time/i).checked).toBe(false)
    })
})

describe('the sign-in trigger', () => {
    it('stays out of the way until an operator needs it', () => {
        // Most deployments do not: the session already exists by the
        // time somebody reaches us. A section of fields for a call that
        // will never be made is noise on every other integration.
        renderForm({})
        expect(screen.queryByPlaceholderText('token')).not.toBeInTheDocument()
        expect(screen.queryByText(/readable by\s+anyone/i)).not.toBeInTheDocument()
    })

    it('says the call is made by the browser, not by us', () => {
        // The single fact that decides whether this integration is even
        // possible. Kerberos cannot be answered server-side, and an
        // operator who assumes otherwise will design around a shape that
        // cannot work.
        renderForm()
        expect(screen.getByText(/made by the browser, not by/i))
            .toBeInTheDocument()
    })

    it('warns that its headers are public, unlike the other two', () => {
        // The trap: three fields whose names differ by one word, two
        // server-side and redacted, one published to every visitor of
        // the sign-in page.
        renderForm({ authenticate_url: 'https://sso.corp.example/authenticate' })
        expect(screen.getByText(/readable by\s+anyone/i)).toBeInTheDocument()
        expect(screen.getByText(/never a credential/i)).toBeInTheDocument()
    })

    it('can be turned off without losing what is configured', () => {
        // Clearing the URL would also stop the call, and would cost the
        // operator their integration. During an incident that is the
        // difference between a switch and a retype.
        const onChange = renderForm({
            authenticate_url: 'https://sso.corp.example/authenticate',
        })
        const toggles = screen.getAllByRole('checkbox') as HTMLInputElement[]
        const trigger = toggles[0]
        expect(trigger.checked).toBe(true)

        trigger.click()
        const next = onChange.mock.calls.at(-1)![0]
        expect(next.authenticate_enabled).toBe(false)
        expect(next.authenticate_url).toBe('https://sso.corp.example/authenticate')
    })

    it('shows it as off when it is off', () => {
        renderForm({
            authenticate_url: 'https://sso.corp.example/authenticate',
            authenticate_enabled: false,
        })
        const toggles = screen.getAllByRole('checkbox') as HTMLInputElement[]
        expect(toggles[0].checked).toBe(false)
    })

    it('offers the token path only once there is a call to read from', () => {
        const { rerender } = render(
            <BackchannelSettingsForm value={{}} onChange={vi.fn()} />,
        )
        expect(screen.queryByPlaceholderText('token')).not.toBeInTheDocument()
        rerender(
            <BackchannelSettingsForm
                value={{ authenticate_url: 'https://sso.corp.example/a' }}
                onChange={vi.fn()} />,
        )
        expect(screen.getByPlaceholderText('token')).toBeInTheDocument()
    })

    it('stops requiring a cookie name when the trigger supplies the token', () => {
        // The two are alternatives, not both. A form that demands a
        // cookie name for a provider that never sets one is asking an
        // operator to invent a value, and the server rejects the row
        // either way — so the asterisk has to move.
        const marker = () =>
            screen.getByText('Cookie name').parentElement?.textContent ?? ''

        const { rerender } = render(
            <BackchannelSettingsForm
                value={{ token_source: 'cookie' }} onChange={vi.fn()} />,
        )
        expect(marker()).toContain('*')

        rerender(
            <BackchannelSettingsForm
                value={{ token_source: 'cookie', authenticate_token_path: 'token' }}
                onChange={vi.fn()} />,
        )
        expect(marker()).not.toContain('*')
    })
})

describe('reaching the allowlist', () => {
    it('says an internal host is unreachable until it is allowed', () => {
        // The single most likely reason a correctly-configured gateway
        // does not work, and there is nothing in the form itself that
        // would ever hint at it.
        renderForm()
        expect(screen.getByText(/until its host is on the allowlist/i))
            .toBeInTheDocument()
    })

    it('names where that list lives', () => {
        renderForm()
        expect(screen.getByText(/Internal gateways SSO may call/i))
            .toBeInTheDocument()
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


describe('clearing a field actually clears it', () => {
    it("an emptied text field writes null, because '' is dropped by the save path", async () => {
        const onChange = renderForm({ exchange_url: 'https://old.example/userinfo' })
        const input = screen.getByPlaceholderText(/userinfo/)
        await userEvent.clear(input)
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ exchange_url: null }),
        )
    })

    it('an emptied numeric field writes null, never NaN', async () => {
        const onChange = renderForm({ timeout_seconds: 5 })
        const input = screen.getByPlaceholderText('5')
        await userEvent.clear(input)
        const last = onChange.mock.calls.at(-1)![0] as BackchannelSettings
        expect(last.timeout_seconds).toBeNull()
        expect(Number.isNaN(last.timeout_seconds)).toBe(false)
    })
})


describe('redacted headers', () => {
    it('render as a Configured panel with a Replace affordance, not the mask', () => {
        renderForm({
            gateway_url: 'https://gw.corp.internal/redeem',
            gateway_headers: '********' as never,
        })
        expect(screen.getByText(/hidden after saving/)).toBeInTheDocument()
        expect(screen.getByText('Replace')).toBeInTheDocument()
        // The mask itself must not be shown as if it were the stored
        // value — that read as data loss, and saving it back was only
        // prevented server-side.
        expect(screen.queryByDisplayValue(/\*{8}/)).not.toBeInTheDocument()
    })

    it('Replace opens an empty editor and a valid map is written through', async () => {
        const onChange = renderForm({
            gateway_url: 'https://gw.corp.internal/redeem',
            gateway_headers: '********' as never,
        })
        await userEvent.click(screen.getByText('Replace'))
        const editor = screen.getAllByPlaceholderText(/X-App-Id/)[0]
        await userEvent.clear(editor)
        await userEvent.type(
            editor, '{{"X-App-Id": "app-2"}', { skipClick: true },
        )
        await userEvent.tab()
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ gateway_headers: { 'X-App-Id': 'app-2' } }),
        )
    })
})

describe('the verification chooser', () => {
    const browserJwt = (over: BackchannelSettings = {}): BackchannelSettings => ({
        exchange_mode: 'browser',
        browser_exchange_url: 'https://sso.corporate.com/translate',
        ...over,
    })

    it('defaults browser mode to a required JWKS URL', () => {
        renderForm(browserJwt())
        expect(screen.getByText('Verify the token with')).toBeInTheDocument()
        expect(screen.getByText('JWKS URL')).toBeInTheDocument()
        expect(
            screen.queryByText('Public key (PEM)'),
        ).not.toBeInTheDocument()
    })

    it('offers a pasted public key for gateways that publish no JWKS', async () => {
        const onChange = vi.fn()
        render(
            <BackchannelSettingsForm value={browserJwt()} onChange={onChange} />,
        )
        await userEvent.selectOptions(
            screen.getByRole('combobox', { name: /verify the token with/i }),
            'public_key',
        )
        // Switching nulls the other materials so nothing lingers to win
        // the populated-field derivation on the next open.
        const next = onChange.mock.calls.at(-1)![0]
        expect(next.jwks_url).toBeNull()
        expect(next.jwt_shared_secret).toBeNull()
    })

    it('renders the PEM textarea once a key is populated', () => {
        renderForm(browserJwt({ jwt_public_key: '-----BEGIN PUBLIC KEY-----' }))
        expect(screen.getByText('Public key (PEM)')).toBeInTheDocument()
        expect(screen.queryByText('JWKS URL')).not.toBeInTheDocument()
    })

    it('renders the secret through SecretField, mask never shown', () => {
        renderForm(browserJwt({ jwt_shared_secret: '********' }))
        // The redaction pattern: a saved secret shows as configured with
        // a Rotate affordance, not as a prefilled password box.
        expect(screen.getByText(/configured/i)).toBeInTheDocument()
        expect(screen.getByText('Rotate')).toBeInTheDocument()
        expect(screen.queryByDisplayValue('********')).not.toBeInTheDocument()
    })

    it('a populated field wins over any local choice', () => {
        // The chooser derives from what is stored — it cannot claim JWKS
        // while a secret is what the server would actually use.
        renderForm(browserJwt({ jwt_shared_secret: '********' }))
        expect(
            (screen.getByRole('combobox', {
                name: /verify the token with/i,
            }) as HTMLSelectElement).value,
        ).toBe('shared_secret')
    })

    it('server mode offers none-by-default with the TLS hint', () => {
        renderForm({ exchange_mode: 'server', claims_format: 'jwt' })
        const select = screen.getByRole('combobox', {
            name: /signature check/i,
        }) as HTMLSelectElement
        expect(select.value).toBe('none')
        expect(
            screen.getByText(/strength of the TLS call/i),
        ).toBeInTheDocument()
        // No pins while nothing verifies — they would pin nothing.
        expect(screen.queryByText(/issuer pin/i)).not.toBeInTheDocument()
    })

    it('browser mode never offers the none option', () => {
        renderForm(browserJwt())
        const select = screen.getByRole('combobox', {
            name: /verify the token with/i,
        })
        const values = Array.from(select.querySelectorAll('option'))
            .map(o => o.getAttribute('value'))
        expect(values).not.toContain('none')
    })

    it('shows the pins for every material choice', () => {
        renderForm(browserJwt({ jwt_public_key: 'PEM' }))
        expect(screen.getByText(/issuer pin/i)).toBeInTheDocument()
        expect(screen.getByText(/audience pin/i)).toBeInTheDocument()
    })
})

describe('trusting it unverified', () => {
    const browserJwt = (over: BackchannelSettings = {}): BackchannelSettings => ({
        exchange_mode: 'browser',
        browser_exchange_url: 'https://sso.corporate.com/translate',
        ...over,
    })

    it('is offered only in browser mode', () => {
        renderForm({ exchange_mode: 'server', claims_format: 'jwt' })
        const select = screen.getByRole('combobox', {
            name: /signature check/i,
        })
        const values = Array.from(select.querySelectorAll('option'))
            .map(o => o.getAttribute('value'))
        expect(values).not.toContain('unsigned')
    })

    it('choosing it reveals the danger toggle without flipping it', async () => {
        const onChange = vi.fn()
        render(
            <BackchannelSettingsForm value={browserJwt()} onChange={onChange} />,
        )
        await userEvent.selectOptions(
            screen.getByRole('combobox', { name: /verify the token with/i }),
            'unsigned',
        )
        // The chooser clears materials and pins; the danger bit itself
        // stays untouched (undefined here) — only the toggle may set it.
        const next = onChange.mock.calls.at(-1)![0]
        expect(next.jwks_url).toBeNull()
        expect(next.jwt_issuer).toBeNull()
        expect(next.trust_unsigned).not.toBe(true)
        expect(screen.getByText('Trust unverified sign-ins')).toBeInTheDocument()
    })

    it('the toggle owns the bit', async () => {
        const onChange = vi.fn()
        render(
            <BackchannelSettingsForm
                value={browserJwt({ trust_unsigned: false, jwks_url: '' })}
                onChange={onChange}
            />,
        )
        // Row already in the unsigned choice (nothing populated, but
        // trust_unsigned=false keeps the chooser on its local state) —
        // select unsigned first, then tick.
        await userEvent.selectOptions(
            screen.getByRole('combobox', { name: /verify the token with/i }),
            'unsigned',
        )
        await userEvent.click(screen.getByRole('checkbox', {
            name: /trust unverified sign-ins/i,
        }))
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ trust_unsigned: true }),
        )
    })

    it('says the full price in the warning copy', () => {
        renderForm(browserJwt({ trust_unsigned: true }))
        expect(screen.getByText(/no verification at all/i)).toBeInTheDocument()
        expect(
            screen.getByText(/any user,\s*including an administrator/i),
        ).toBeInTheDocument()
        expect(screen.getByText(/user\.sso_unsigned_accepted/)).toBeInTheDocument()
        expect(
            screen.getByText(/ineligible to grant platform admin/i),
        ).toBeInTheDocument()
        expect(
            screen.getByText(/reply shape varies by environment/i),
        ).toBeInTheDocument()
        // Pins are hidden — they would pin nothing.
        expect(screen.queryByText(/issuer pin/i)).not.toBeInTheDocument()
    })

    it('a stored trust_unsigned row derives the unsigned choice', () => {
        renderForm(browserJwt({ trust_unsigned: true }))
        expect(
            (screen.getByRole('combobox', {
                name: /verify the token with/i,
            }) as HTMLSelectElement).value,
        ).toBe('unsigned')
    })

    it('names the assurance cost beside the chooser', () => {
        renderForm(browserJwt())
        expect(screen.getByText(/rates it/i)).toBeInTheDocument()
    })
})

describe('forwarding the trigger token into the translate body', () => {
    const browserRow = (over: BackchannelSettings = {}): BackchannelSettings => ({
        exchange_mode: 'browser',
        browser_exchange_url: 'https://sso.corporate.com/translate',
        ...over,
    })
    const label = /send the sign-in call.s token in the body/i

    it('offers the body field in browser mode, and typing reports it', async () => {
        const onChange = renderForm(browserRow())
        const input = screen.getByRole('textbox', { name: label })
        await userEvent.type(input, 't')
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ browser_exchange_body_field: 't' }),
        )
    })

    it("an emptied body field writes null, because '' is dropped by the save path", async () => {
        const onChange = renderForm(
            browserRow({ browser_exchange_body_field: 'token' }),
        )
        await userEvent.clear(screen.getByRole('textbox', { name: label }))
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ browser_exchange_body_field: null }),
        )
    })

    it('does not appear in server mode, where the server leg owns the body', () => {
        renderForm({ exchange_mode: 'server' })
        expect(screen.queryByRole('textbox', { name: label }))
            .not.toBeInTheDocument()
    })

    it('says what pairs with it: the trigger token path and POST', () => {
        renderForm(browserRow({
            authenticate_url: 'https://sso.corporate.com/authenticate',
        }))
        expect(
            screen.getByText(/name that json field here; it needs the trigger/i),
        ).toBeInTheDocument()
        // And the trigger's own hint points forward at it in this mode.
        expect(
            screen.getByText(/forwarded to the translate call/i),
        ).toBeInTheDocument()
    })
})

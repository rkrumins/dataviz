/**
 * Confirming it's you through an Enterprise gateway, without leaving the page.
 *
 * A gateway's sign-in runs in the browser — its sign-in trigger, its browser
 * exchange, or the company cookie this browser carries — so a step-up it
 * asks for has no page to send anyone to: the server names the gateway
 * instead (`ApiKeyError.gateway`). The app already signs in through a
 * gateway again in place when a session needs renewing
 * (`attemptSilentReauth`); a step-up asks for exactly that, and the request
 * is sent once more — only if the same person is still signed in.
 */
import { ApiKeyError } from '@/services/apiKeyService'
import { authService } from '@/services/authService'
import { attemptSilentReauth, readReauthNotice } from '@/services/backchannelReauth'
import { useAuthStore } from '@/store/auth'

const SOMEONE_ELSE = 'Your company sign-in is now someone else’s, so nothing was made. Reload the page to carry on as them.'

/** `send`, and — when a gateway asks to confirm it's you — sign in through it again here and `send` once more. */
export async function withGatewayStepUp<T>(send: () => Promise<T>): Promise<T> {
    try {
        return await send()
    } catch (err) {
        if (!(err instanceof ApiKeyError && err.code === 'step_up_required' && err.gateway)) throw err
        const before = useAuthStore.getState().user?.id
        const outcome = await attemptSilentReauth(err.gateway)
        if (outcome !== 'recovered') {
            const why = outcome === 'failed' || outcome === 'gone' ? readReauthNotice()?.reason : null
            throw new ApiKeyError(err.status, why || err.message, { error: 'step_up_required', method: 'sso' })
        }
        const { user } = await authService.me()
        if (!before || user?.id !== before) {
            throw new ApiKeyError(err.status, SOMEONE_ELSE, { error: 'step_up_required', method: 'sso' })
        }
        return send()
    }
}

/**
 * rideOut — keep asking while the graph can't answer just now.
 *
 * A search, a later page, a display rule's check or count is an idempotent
 * read. When the graph is busy, failing over, restarting or unreachable,
 * the server says so (429 / 503 / 504, with a Retry-After) and keeps
 * whatever the search had found. The request layer retries such an answer
 * a couple of times in quick succession; past that, these reads used to
 * give up within a second or two — the panel said the search "ran out of
 * time", a rule's chips just vanished. Here they wait it out: up to three
 * minutes, backing off to 15 s between tries, the server's Retry-After
 * honoured. Anything else — a refused query, a search the server could not
 * finish — is thrown at once: asking again would fail the same way.
 */
import { isApiStatusError, isRetryableGraphFailure } from './graphRequestFailure'


/** How long a read rides out a graph that can't answer. */
export const RIDE_OUT_MS = 180_000

/** The longest wait between two tries. */
export const RETRY_MAX_MS = 15_000

/** What the request layer throws while its own breaker for the graph is
 *  open — it closes again by itself. */
const CIRCUIT_OPEN = 'Provider unavailable (circuit open)'


/** Whether ``err`` says the graph can't answer just now — worth asking
 *  again later — rather than that the request itself is wrong. */
export function waitsOut(err: unknown): boolean {
    if (isRetryableGraphFailure(err)) return true
    // A confirmed outage too: the request layer leaves a 503 from the
    // server's own breaker to its breaker; a search waits for it.
    if (isApiStatusError(err)) return err.status === 503
    return err instanceof Error && err.message === CIRCUIT_OPEN
}


/** The wait before try ``attempt`` (0-based) after ``err``: doubling from a
 *  second, at least what the server asked for, at most ``RETRY_MAX_MS`` —
 *  with jitter, so open tabs don't ask in lockstep. */
export function rideOutDelayMs(err: unknown, attempt: number): number {
    const hinted = isApiStatusError(err) ? err.retryAfterMs ?? 0 : 0
    const backoff = 1_000 * 2 ** Math.min(attempt, 4)
    return Math.min(RETRY_MAX_MS, Math.max(hinted, backoff)) + Math.floor(Math.random() * 250)
}


/** Resolves after ``ms``, or as soon as ``signal`` aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve()
        const timer = setTimeout(done, ms)
        signal?.addEventListener('abort', done, { once: true })
        function done() {
            clearTimeout(timer)
            signal?.removeEventListener('abort', done)
            resolve()
        }
    })
}


/**
 * ``ask()``, asked again while it fails in a way that ``waitsOut`` — for at
 * most ``windowMs`` from the first such failure. Throws the last failure
 * when the window ends, any other failure at once, and stops asking when
 * ``signal`` aborts.
 */
export async function rideOut<T>(
    ask: () => Promise<T>,
    signal?: AbortSignal,
    windowMs: number = RIDE_OUT_MS,
): Promise<T> {
    let since: number | null = null
    for (let attempt = 0; ; attempt++) {
        try {
            return await ask()
        } catch (err) {
            if (signal?.aborted || !waitsOut(err)) throw err
            since ??= Date.now()
            const wait = rideOutDelayMs(err, attempt)
            if (Date.now() + wait - since > windowMs) throw err
            await pause(wait, signal)
            if (signal?.aborted) throw err
        }
    }
}

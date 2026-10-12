/**
 * Shared error banner for the SSO admin tabs.
 *
 * For what is still true while it is being read — a list that could not
 * be loaded, a posture that could not be reached. What just happened,
 * and every way it failed, goes to the app's one notification stack
 * instead: a result with no timer sits under the next click, and a
 * second pop-up idiom in the same product is the thing this sweep
 * removed everywhere else.
 */
import { AlertCircle } from 'lucide-react'

export function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{message}</span>
        </div>
    )
}

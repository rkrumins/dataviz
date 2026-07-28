/**
 * Shared error banner for the SSO admin tabs.
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

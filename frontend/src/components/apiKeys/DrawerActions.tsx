/**
 * The key drawer's footer on a page of one owner's keys — yours, or a service
 * account's: the same choices as the key's card, and revoking asked once in
 * place.
 */
import { useState } from 'react'
import { LogIn, Pencil, RotateCw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import type { ApiKey } from '@/services/apiKeyService'
import { isRenewable } from './apiKeyFormat'

/** The drawer's footer: the same choices as the card, revoking asked once in place. */
export function DrawerActions({ apiKey, resumeUrl, onRotate, onEdit, onRevoke }: {
    apiKey: ApiKey
    /** A paused key's way back: signing in again. */
    resumeUrl: string | null
    onRotate?: () => void
    onEdit?: () => void
    onRevoke?: () => void
}) {
    const [confirming, setConfirming] = useState(false)
    if (confirming) {
        return (
            <>
                <span className="text-xs font-medium text-ink-secondary mr-auto">Stop “{apiKey.name}” now?</span>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep</Button>
                <Button variant="danger" size="sm" onClick={() => { setConfirming(false); onRevoke?.() }}>Revoke</Button>
            </>
        )
    }
    return (
        <>
            {onRevoke && (
                <Button variant="ghost" size="sm" leftIcon={Trash2} onClick={() => setConfirming(true)} className="mr-auto hover:text-rose-600 dark:hover:text-rose-400">
                    Revoke
                </Button>
            )}
            {onEdit && (
                <Button variant="secondary" size="sm" leftIcon={Pencil} onClick={onEdit} className="border-black/[0.10] dark:border-white/[0.12] shadow-sm">
                    Edit
                </Button>
            )}
            {onRotate && (
                <Button
                    variant={resumeUrl ? 'secondary' : 'primary'}
                    size="sm"
                    leftIcon={RotateCw}
                    onClick={onRotate}
                    className={resumeUrl ? 'border-black/[0.10] dark:border-white/[0.12] shadow-sm' : undefined}
                >
                    {isRenewable(apiKey) ? 'Renew' : 'Rotate'}
                </Button>
            )}
            {resumeUrl && (
                <a
                    href={resumeUrl}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold text-white bg-accent-lineage shadow-sm shadow-accent-lineage/25 hover:brightness-110 transition whitespace-nowrap"
                >
                    <LogIn className="w-3.5 h-3.5" aria-hidden />
                    Sign in to resume
                </a>
            )}
        </>
    )
}

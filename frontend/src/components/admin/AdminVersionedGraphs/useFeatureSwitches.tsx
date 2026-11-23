/**
 * The feature switches a category's settings need (New-version builds, Graph residency), through
 * the Features API, with the confirmations Admin → Features asks for: turning one off always asks,
 * turning one on asks when the switch says what that means. A row's "Turn on New-version builds"
 * fix opens the same dialog the category's card does. A switch saves at once (it isn't a setting
 * and has no review), and says so with an Undo.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppNotifications } from '@/components/ui/notifications'
import { ConfirmTurnOff } from '@/components/admin/AdminFeatures/ConfirmTurnOff'
import { ConfirmTurnOn } from '@/components/admin/AdminFeatures/ConfirmTurnOn'
import { isOn } from '@/components/admin/AdminFeatures/featureState'
import { FeaturesConcurrencyError, featuresService, type FeatureDefinition } from '@/services/featuresService'
import { settingsKeys } from '@/services/settingsService'
import { useFeaturesStore } from '@/store/features'

const FEATURES_KEY = ['admin', 'features'] as const
const UNDO_MS = 8_000

export interface FeatureSwitches {
    loading: boolean
    error: Error | null
    retry: () => void
    definition: (key: string) => FeatureDefinition | undefined
    on: (key: string) => boolean | undefined
    names: Record<string, string>
    lastChange: (key: string) => { actorName: string; at: string; to: unknown } | undefined
    saving: string | null
    /** Turn a switch on or off, asking first where Admin → Features does. */
    request: (key: string, next: boolean) => void
    /** The confirmations; render once. */
    dialogs: ReactElement
}

export function useFeatureSwitches(): FeatureSwitches {
    const qc = useQueryClient()
    const { notify } = useAppNotifications()
    const query = useQuery({ queryKey: FEATURES_KEY, queryFn: featuresService.get, staleTime: 30_000 })
    const [pendingOn, setPendingOn] = useState<FeatureDefinition | null>(null)
    const [pendingOff, setPendingOff] = useState<FeatureDefinition | null>(null)
    const [saving, setSaving] = useState<string | null>(null)
    const schema = useMemo(() => query.data?.schema ?? [], [query.data])
    const values = query.data?.values ?? {}
    const names = useMemo(() => Object.fromEntries(schema.map((f) => [f.key, f.name])), [schema])
    const definition = (key: string) => schema.find((f) => f.key === key)

    const apply = async (feature: FeatureDefinition, next: boolean, undoable = true) => {
        const data = qc.getQueryData<typeof query.data>(FEATURES_KEY) ?? query.data
        if (!data) return
        const was = isOn(feature, data.values)
        setSaving(feature.key)
        try {
            const res = await featuresService.update({ ...data.values, [feature.key]: next, version: data.version })
            qc.setQueryData(FEATURES_KEY, res)
            useFeaturesStore.getState().setValues(res.values)
            // What the settings depend on changed: their statuses, whys and postures with it.
            void qc.invalidateQueries({ queryKey: settingsKeys.all })
            notify('success', `${feature.name} is ${next ? 'on' : 'off'}.`,
                undoable ? { label: 'Undo', onClick: () => void apply(feature, was, false) } : undefined, undoable ? UNDO_MS : undefined)
        } catch (err) {
            if (err instanceof FeaturesConcurrencyError) {
                void query.refetch()
                notify('error', 'Someone else changed the switches meanwhile. They have been read again; try once more.')
            } else {
                notify('error', `Couldn’t turn ${feature.name} ${next ? 'on' : 'off'}: ${(err as Error).message}`)
            }
        } finally {
            setSaving(null)
        }
    }

    const request = (key: string, next: boolean) => {
        const f = definition(key)
        if (!f) return
        if (!next && isOn(f, values)) setPendingOff(f)
        else if (next && f.impactWhenOn && !isOn(f, values)) setPendingOn(f)
        else void apply(f, next)
    }

    return {
        loading: query.isPending,
        error: query.error as Error | null,
        retry: () => void query.refetch(),
        definition,
        on: (key) => {
            const f = definition(key)
            return f ? isOn(f, values) : undefined
        },
        names,
        lastChange: (key) => query.data?.lastChanges?.[key],
        saving,
        request,
        dialogs: (
            <>
                <ConfirmTurnOn feature={pendingOn} onCancel={() => setPendingOn(null)}
                    onConfirm={async () => { if (pendingOn) await apply(pendingOn, true); setPendingOn(null) }} />
                <ConfirmTurnOff feature={pendingOff} allFeatures={schema} values={values} onCancel={() => setPendingOff(null)}
                    onConfirm={async () => { if (pendingOff) await apply(pendingOff, false); setPendingOff(null) }} />
            </>
        ),
    }
}

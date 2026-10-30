/**
 * DraftLevelPicker — the level a new draft opens at: Public or Private, starting from its data
 * source's policy, a level the policy rules out offered disabled.
 */
import { Globe2, Lock } from 'lucide-react'
import { Segmented } from '@/components/ui/Segmented'
import type { DraftLevel, DraftLevels } from '@/services/versioningApiService'

export function DraftLevelPicker({ value, onChange, levels = 'any', size }: {
  value: DraftLevel
  onChange: (level: DraftLevel) => void
  /** The levels the policy allows. */
  levels?: DraftLevels
  size?: 'sm' | 'md'
}) {
  const ruledOut = (v: DraftLevel) => levels !== 'any' && levels !== `${v}_only`
  return (
    <Segmented
      label="Who can see the new draft"
      size={size}
      value={value}
      onChange={onChange}
      options={[
        { value: 'public', label: 'Public', icon: Globe2, disabled: ruledOut('public') },
        { value: 'private', label: 'Private', icon: Lock, disabled: ruledOut('private') },
      ]}
    />
  )
}

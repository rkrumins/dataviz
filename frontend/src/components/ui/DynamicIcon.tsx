import React from 'react'
import * as LucideIcons from 'lucide-react'

export function DynamicIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }) {
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
  if (!IconComponent) {
    return <LucideIcons.Box className={className} style={style} />
  }
  return <IconComponent className={className} style={style} />
}

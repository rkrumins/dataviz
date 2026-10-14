import { useEffect, useState } from 'react'
import { localDay } from './dateFilter'

/**
 * Today's local calendar day, re-rendering when it changes.
 *
 * Date rules resolve against "today", so a tab left open overnight has to roll over
 * at midnight: without this, "Today" would keep showing yesterday's views until
 * something else happened to re-render the page.
 */
export function useLocalDay(): string {
  const [day, setDay] = useState(() => localDay())
  useEffect(() => {
    const now = new Date()
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    // A second past midnight, so the new day is unambiguous when the timer fires.
    const timer = setTimeout(() => setDay(localDay()), nextMidnight.getTime() - now.getTime() + 1000)
    return () => clearTimeout(timer)
  }, [day])
  return day
}

import { useLayoutEffect, useRef, type SyntheticEvent } from 'react'

/** Native disclosures retain browser and author toggles; defaults only ever open them. */
export function useAutoExpand(expanded: boolean, onToggle: () => void) {
  const ref = useRef<HTMLDetailsElement>(null)
  const manual = useRef(false)
  const automatic = useRef(false)
  const autoOpened = useRef(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!expanded || manual.current || autoOpened.current || !element || element.open) return
    autoOpened.current = true
    automatic.current = true
    element.open = true
  }, [expanded])
  const toggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.target !== event.currentTarget) return
    const next = event.currentTarget.open
    if (!automatic.current || !next) manual.current = true
    automatic.current = false
    onToggle()
  }
  return { ref, onToggle: toggle, onSummaryClick: () => { manual.current = true } }
}

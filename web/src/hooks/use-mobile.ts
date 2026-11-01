import * as React from "react"

const MOBILE_BREAKPOINT = 768

/**
 * Tracks whether the viewport is below the mobile breakpoint. Implemented with
 * `useSyncExternalStore` so it subscribes to `matchMedia` without calling
 * setState inside an effect (which this repo's lint rules disallow) and stays
 * SSR-safe (server renders as non-mobile).
 */
export function useIsMobile() {
  const subscribe = React.useCallback((onChange: () => void) => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false
  )
}

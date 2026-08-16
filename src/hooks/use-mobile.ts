import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

export function useIsDesktop(breakpoint = 1024) {
  const [isDesktop, setIsDesktop] = React.useState<boolean>(false)

  React.useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${breakpoint}px)`)
    const onChange = () => {
      setIsDesktop(window.innerWidth >= breakpoint)
    }
    mql.addEventListener("change", onChange)
    setIsDesktop(window.innerWidth >= breakpoint)
    return () => mql.removeEventListener("change", onChange)
  }, [breakpoint])

  return isDesktop
}


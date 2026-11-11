import { createContext, useContext, useMemo, type ReactNode } from "react"
import { assert } from "ts-essentials"
import { screenerOf, type AddressScreener, type Screenings } from "../core"

const ScreeningContext = createContext<Screenings | undefined>(undefined)

/** Provides the page's screening verdicts; unconfigured builds screen with `passThroughScreener`. */
export const ScreeningProvider = ({
  children,
  screenings,
}: {
  children: ReactNode
  screenings: Screenings
}) => {
  return <ScreeningContext.Provider value={screenings}>{children}</ScreeningContext.Provider>
}

export const useScreenings = (): Screenings => {
  const context = useContext(ScreeningContext)
  assert(context, "useScreenings must be used within a ScreeningProvider")
  return context
}

export const useScreener = (): AddressScreener => {
  const screenings = useScreenings()
  return useMemo(() => screenerOf(screenings), [screenings])
}

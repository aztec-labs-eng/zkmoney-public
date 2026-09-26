import { createContext, useContext, ReactNode } from "react"
import { assert } from "ts-essentials"
import type { LocalConfigStore } from "src/core"

const ConfigContext = createContext<LocalConfigStore | undefined>(undefined)

/** Provides the app's one LocalConfigStore; the composition root constructs and init()s it. */
export const ConfigProvider = ({
  children,
  service,
}: {
  children: ReactNode
  service: LocalConfigStore
}) => {
  return <ConfigContext.Provider value={service}>{children}</ConfigContext.Provider>
}

export const useLocalConfigStore = (): LocalConfigStore => {
  const context = useContext(ConfigContext)
  assert(context, "useLocalConfigStore must be used within a ConfigProvider")
  return context
}

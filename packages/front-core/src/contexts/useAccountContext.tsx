import { createContext, ReactNode, useContext } from "react"
import { useAccount } from "../hooks/useAccount"
import { UseAuthenticator } from "src/hooks"
import { assert } from "ts-essentials"

type AccountContextProps = ReturnType<typeof useAccount>

const AccountContext = createContext<AccountContextProps | undefined>(undefined)

export interface AccountProviderProps {
  children: ReactNode
  useAuthenticator: UseAuthenticator
  // useCommunicator: UseCommunicator
}

export const AccountProvider = ({
  children,
  useAuthenticator,
}: // useCommunicator,
AccountProviderProps) => {
  // const account = useAccount(useAuthenticator, useCommunicator)
  const account = useAccount(useAuthenticator)
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>
}

export const useAccountContext = (): AccountContextProps => {
  const context = useContext(AccountContext)
  assert(context, "useAccountContext must be used within an AccountProvider")
  return context
}

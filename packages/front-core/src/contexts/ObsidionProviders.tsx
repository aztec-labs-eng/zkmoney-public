import type { ReactNode } from "react"
import { ContractServiceProvider } from "./useContractServiceContext"
import type { ContractService } from "@obsidion/sdk"
import type { Resource } from "../engine/resource"

/** The page's contract service. */
export const ObsidionCoreProvider = ({
  children,
  contractService,
}: {
  children: ReactNode
  contractService: Resource<ContractService>
}) => (
  <ContractServiceProvider contractService={contractService}>{children}</ContractServiceProvider>
)

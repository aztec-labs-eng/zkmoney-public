// @vitest-environment node
/** The rail keys the scan with the account's own deposit nullifier hiding key. */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { describe, expect, it } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { fixed } from "@obsidion/front-core"
import {
  ContractService,
  DEFAULT_CONTRACTS,
  EcdsaK256AlphaAuthProvider,
  ObsidionAccount,
  ObsidionAccountContractManager,
  getHardcodedArtifact,
  sipaNullifierHidingKey,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { openSipaKeys } from "../../../../src/features/deposit/sipaRail"
import { defaultConfig } from "../../../support/page"
import { answered } from "../../../support/query"

const TUPLE = {
  rollupVersion: "1",
  accountFactory: "0x00000000000000000000000000000000000000af",
} as OxideEnvTuple

describe("openSipaKeys", () => {
  it("hands the scan the account's nullifier hiding key", async () => {
    // Only registration uses the contract service and the PXE. The test never registers.
    const contractService = new ContractService(
      undefined,
      undefined,
      undefined,
      defaultConfig.network,
      { source: "local-ledger" },
    )
    const msk = Fr.random()
    const auth = new EcdsaK256AlphaAuthProvider(Fr.random().toBuffer())
    const contractName = DEFAULT_CONTRACTS.obsidionAccountAlpha
    const manager = await ObsidionAccountContractManager.create(msk, await auth.getPasskeySet(), {
      artifact: await getHardcodedArtifact(contractName),
      contractName,
      pxe: undefined as never,
      contractService,
    })
    const account = new ObsidionAccount(await manager.getCompleteAddress(), manager, auth, {
      l1ChainId: 31337,
      rollupVersion: 1,
    })

    const keys = await openSipaKeys(
      { config: defaultConfig, chain: { oxideTuple: answered(TUPLE) } } as never,
      fixed("wallet", undefined as unknown as ObsidionWallet),
      fixed("account", account),
      async () => msk,
    ).ready()

    expect(keys.nullifierHidingKey.equals(await sipaNullifierHidingKey(account))).toBe(true)
  })
})

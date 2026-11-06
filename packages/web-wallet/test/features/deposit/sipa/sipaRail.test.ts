// @vitest-environment node
/** The rail keys the scan with the account's own deposit nullifier hiding key. */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { afterEach, describe, expect, it } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { fixed, readyValue } from "@obsidion/front-core"
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
import { getConfig } from "../../../../src/config/env"
import { primeOxideTuple } from "../../../../src/config/oxideTuple"
import { sipaKeysResource } from "../../../../src/features/deposit/sipaRail"
import { seedBootConfig } from "../../../support/seedBootConfig"

const TUPLE = {
  rollupVersion: "1",
  accountFactory: "0x00000000000000000000000000000000000000af",
} as OxideEnvTuple

afterEach(() => ContractService.resetInstance())

describe("sipaKeysResource", () => {
  it("hands the scan the account's nullifier hiding key", async () => {
    await seedBootConfig()
    primeOxideTuple(getConfig(), TUPLE)
    // Only registration uses the contract service and the PXE. The test never registers.
    ContractService.getInstance(undefined, undefined, undefined, getConfig().network, {
      source: "local-ledger",
    })
    const msk = Fr.random()
    const auth = new EcdsaK256AlphaAuthProvider(Fr.random().toBuffer())
    const contractName = DEFAULT_CONTRACTS.obsidionAccountAlpha
    const manager = await ObsidionAccountContractManager.create(msk, await auth.getPasskeySet(), {
      artifact: await getHardcodedArtifact(contractName),
      contractName,
      pxe: undefined as never,
    })
    const account = new ObsidionAccount(await manager.getCompleteAddress(), manager, auth, {
      l1ChainId: 31337,
      rollupVersion: 1,
    })

    const keys = await readyValue(
      sipaKeysResource(
        fixed("wallet", undefined as unknown as ObsidionWallet),
        fixed("account", account),
        async () => msk,
      ),
    )

    expect(keys.nullifierHidingKey.equals(await sipaNullifierHidingKey(account))).toBe(true)
  })
})

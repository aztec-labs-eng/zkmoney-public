import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Gas } from "@aztec/stdlib/gas"

/**
 * Short-circuits the kernelless pre-simulation that `ObsidionWallet.sendTx`
 * runs before proving. The wallet's real `simulateTx` reaches into
 * `pxe.simulateTx` (and `simulateViaNode`) which the wallet unit tests do
 * not stub; the tests only care about the prove/submit/persist pipeline.
 *
 * Returned shape satisfies both `collectOffchainEffects` (empty effects ->
 * no authwit capture) and `getGasLimits(_, txsLimits, 0)` (zeroed
 * totalGas/teardownGas via `Gas.empty()`). Pair with `stubNodeInfo()` from
 * `./obsidionWalletStubs.js` so `sendTx` can read `txsLimits.gas`.
 *
 *     ;(wallet as any).simulateTx = stubSimulateTx
 *
 * within `buildStubWallet`-style fixtures in `test/obsidion-wallet/`.
 */
export const stubSimulateTx = async () => ({
  privateExecutionResult: {
    entrypoint: {
      offchainEffects: [],
      nestedExecutionResults: [],
      publicInputs: { callContext: { contractAddress: AztecAddress.ZERO } },
    },
  },
  publicInputs: {
    constants: { anchorBlockHeader: { globalVariables: { timestamp: 0n } } },
  },
  publicOutput: undefined,
  gasUsed: {
    totalGas: Gas.empty(),
    teardownGas: Gas.empty(),
  },
  stats: undefined,
})

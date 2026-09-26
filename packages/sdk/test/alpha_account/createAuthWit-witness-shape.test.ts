/**
 * Unit test for `ObsidionAccount.createAuthWit` witness-less behavior.
 *
 * The alpha account contract authorizes intents via membership in
 * `storage.intents_hashes`, populated by `entrypoint_with_intent` and bound by
 * the user's combined-payload signature in the entrypoint. The per-intent
 * witness bytes are dead data — this test pins that contract:
 *
 *   - Intent shapes (`CallIntent | IntentInnerHash`) return a witness-less
 *     `AuthWitness` (MAX_WITNESS_LEN × Fr.ZERO).
 *   - `requestHash` matches `computeAuthWitMessageHash(intent)` — guards
 *     against `getMessageHash` drift inside `ObsidionAccount`.
 *   - Raw `Fr | Buffer` inputs throw a clear error — the alpha account does
 *     not produce standalone signed authwits through this API.
 *   - `authProvider.createAuthWit` is NOT invoked.
 */
import { Fr } from "@aztec/foundation/curves/bn254"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import {
  FunctionCall,
  FunctionSelector,
  FunctionType,
} from "@aztec/stdlib/abi"
import { computeAuthWitMessageHash } from "@aztec/aztec.js/authorization"
import { describe, expect, it, vi } from "vitest"

import { ObsidionAccount } from "../../src/obsidion/alpha/account/ObsidionAccount.js"
import { MAX_WITNESS_LEN } from "../../src/utils/constants.js"
import type { AlphaAuthProvider } from "../../src/obsidion/alpha/auth/AlphaAuthProvider.js"

// ─── Helpers ───────────────────────────────────────────────────────────────

const FAKE_CHAIN_ID = 31337n
const FAKE_ROLLUP_VERSION = 1n

function makeStubAuthProvider(): AlphaAuthProvider & { createAuthWit: ReturnType<typeof vi.fn> } {
  return {
    getPubkeys: vi.fn(async () => [Buffer.alloc(32), Buffer.alloc(32)] as [Buffer, Buffer]),
    createAuthWit: vi.fn(async () => {
      throw new Error("authProvider.createAuthWit should not be invoked for intent authwits")
    }),
  } as any
}

function makeAccount(authProvider: AlphaAuthProvider) {
  // We bypass `ObsidionAccountContractManager` because none of its methods are
  // exercised by `createAuthWit`. Construct a minimal stand-in.
  const address = AztecAddress.fromBigIntUnsafe(0x1234n)
  const completeAddress = {
    address,
  } as any
  const manager = {} as any
  const nodeInfo = {
    l1ChainId: FAKE_CHAIN_ID,
    rollupVersion: FAKE_ROLLUP_VERSION,
  }
  return new ObsidionAccount(completeAddress, manager, authProvider, nodeInfo as any)
}

async function buildIntent(): Promise<{ caller: AztecAddress; call: FunctionCall }> {
  const caller = AztecAddress.fromBigIntUnsafe(0xbeefn)
  const target = AztecAddress.fromBigIntUnsafe(0xcafen)
  const selector = await FunctionSelector.fromSignature("transfer((Field),(Field),u128,Field)")
  const call = FunctionCall.from({
    name: "transfer",
    args: [
      caller.toField(),
      target.toField(),
      new Fr(100n),
      Fr.ZERO,
    ],
    selector,
    type: FunctionType.PRIVATE,
    hideMsgSender: false,
    isStatic: false,
    to: target,
    returnTypes: [],
  })
  return { caller, call }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ObsidionAccount.createAuthWit — witness-less intent path", () => {
  it("returns a witness-less AuthWitness for a CallIntent", async () => {
    const authProvider = makeStubAuthProvider()
    const account = makeAccount(authProvider)
    const { caller, call } = await buildIntent()

    const authwit = await account.createAuthWit({ caller, call })

    expect(authwit.witness.length).toBe(MAX_WITNESS_LEN)
    expect(authwit.witness.every((fr) => fr.equals(Fr.ZERO))).toBe(true)
    expect(authProvider.createAuthWit).not.toHaveBeenCalled()
  })

  it("returns a requestHash that matches computeAuthWitMessageHash for the same intent", async () => {
    const authProvider = makeStubAuthProvider()
    const account = makeAccount(authProvider)
    const { caller, call } = await buildIntent()

    const authwit = await account.createAuthWit({ caller, call })
    const expectedHash = await computeAuthWitMessageHash(
      { caller, call },
      { chainId: new Fr(FAKE_CHAIN_ID), version: new Fr(FAKE_ROLLUP_VERSION) },
    )

    expect(authwit.requestHash.equals(expectedHash)).toBe(true)
  })

  it("throws on raw Fr input", async () => {
    const authProvider = makeStubAuthProvider()
    const account = makeAccount(authProvider)

    await expect(account.createAuthWit(new Fr(0xdeadbeefn))).rejects.toThrow(/raw-hash input not supported/)
    expect(authProvider.createAuthWit).not.toHaveBeenCalled()
  })

  it("throws on raw Buffer input", async () => {
    const authProvider = makeStubAuthProvider()
    const account = makeAccount(authProvider)

    await expect(account.createAuthWit(Buffer.alloc(32))).rejects.toThrow(/raw-hash input not supported/)
    expect(authProvider.createAuthWit).not.toHaveBeenCalled()
  })
})

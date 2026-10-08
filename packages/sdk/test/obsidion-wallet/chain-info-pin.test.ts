/**
 * `ObsidionWallet`'s chain-identity pin. A wallet built with `chainInfo` binds every tx context,
 * authwit hash, account build and link stamp to that pair, whatever the node answers afterwards;
 * a wallet built without it takes the node's answer. Mock PXE / mock node — no sandbox.
 */
import { Fr } from "@aztec/foundation/curves/bn254"
import { NO_FROM } from "@aztec/aztec.js/account"
import { computeAuthWitMessageHash } from "@aztec/aztec.js/authorization"
import { AccountFeePaymentMethodOptions } from "@aztec/entrypoints/account"
import type { FeeOptions } from "@aztec/wallet-sdk/base-wallet"
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec/stdlib/abi"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { CompleteAddress } from "@aztec/stdlib/contract"
import { ExecutionPayload, SimulationOverrides } from "@aztec/stdlib/tx"
import { afterEach, describe, expect, it, vi } from "vitest"
import { stubGasSettingsFallback, stubNodeInfo } from "../utils/obsidionWalletStubs.js"

import { ObsidionWallet, type WalletChainInfo } from "../../src/obsidion/ObsidionWallet.js"
import {
  ObsidionAccountContractManager,
} from "../../src/obsidion/alpha/account/ObsidionAccountContractManager.js"
import { StubAlphaAuthProvider } from "../../src/obsidion/alpha/auth/StubAlphaAuthProvider.js"
import { chainInfoFields, linkChainInfo } from "../../src/services/claimSponsor.js"

const PINNED: WalletChainInfo = { l1ChainId: 1, rollupVersion: 7 }
const NODE = { l1ChainId: 31337, rollupVersion: 1 }
const LIAR = { l1ChainId: 999, rollupVersion: 42 }

function makeWallet(opts?: {
  chainInfo?: WalletChainInfo
  nodeInfo?: WalletChainInfo
  nodeRejects?: boolean
}) {
  const stubPxe: any = {
    sync: vi.fn(async () => {}),
    simulateTx: vi.fn(async () => ({})),
  }
  const stubNode: any = {
    getNodeInfo: vi.fn(async () => {
      if (opts?.nodeRejects) throw new Error("node unreachable")
      return stubNodeInfo(opts?.nodeInfo ?? NODE)
    }),
  }
  const wallet = new ObsidionWallet(stubPxe, stubNode, { chainInfo: opts?.chainInfo })
  return { wallet, stubPxe, stubNode }
}

/** From here on the node reports another rollup. */
function nodeLies(stubNode: any) {
  stubNode.getNodeInfo.mockImplementation(async () => stubNodeInfo(LIAR))
}

const feeOptions: FeeOptions = {
  gasSettings: stubGasSettingsFallback(),
  walletFeePaymentMethod: undefined,
  accountFeePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
}

/** One private call: what upstream's `DefaultEntrypoint` accepts for a NO_FROM request. */
function privateCallPayload() {
  const call = FunctionCall.from({
    name: "f",
    to: AztecAddress.fromBigIntUnsafe(0x1n),
    selector: FunctionSelector.fromField(new Fr(1)),
    type: FunctionType.PRIVATE,
    hideMsgSender: false,
    isStatic: false,
    args: [],
    returnTypes: [],
  })
  return new ExecutionPayload([call], [], [], [])
}

/**
 * An account built through the wallet, with the address derivation stubbed: the build's identity
 * input is what is under test, not the derivation.
 */
async function buildAccount(wallet: ObsidionWallet) {
  const completeAddress = await CompleteAddress.random()
  const manager = {
    address: completeAddress.address,
    getCompleteAddress: async () => completeAddress,
    ensureContractRegistered: async () => {},
  }
  vi.spyOn(ObsidionAccountContractManager, "create").mockResolvedValue(manager as any)
  ;(wallet as any).getContractManagerOptions = async () => ({})
  const account = await wallet.getObsidionAccountWallet(Fr.random(), new StubAlphaAuthProvider(), {
    register: false,
  })
  return { account, address: completeAddress.address }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ObsidionWallet chain-info pin", () => {
  it("pinned: both accessors answer from the pin and never ask the node", async () => {
    const { wallet, stubNode } = makeWallet({ chainInfo: PINNED, nodeRejects: true })
    await expect(wallet.getNodeIdentity()).resolves.toEqual(PINNED)
    const info = await wallet.getChainInfo()
    expect(info.chainId.toBigInt()).toBe(1n)
    expect(info.version.toBigInt()).toBe(7n)
    expect(stubNode.getNodeInfo).not.toHaveBeenCalled()
  })

  it("unpinned: both accessors answer from the node", async () => {
    const { wallet } = makeWallet()
    await expect(wallet.getNodeIdentity()).resolves.toEqual(NODE)
    const info = await wallet.getChainInfo()
    expect(info.chainId.toBigInt()).toBe(31337n)
    expect(info.version.toBigInt()).toBe(1n)
  })

  it("unpinned: a rejecting node rejects both accessors", async () => {
    const { wallet } = makeWallet({ nodeRejects: true })
    await expect(wallet.getNodeIdentity()).rejects.toThrow("node unreachable")
    await expect(wallet.getChainInfo()).rejects.toThrow("node unreachable")
  })

  it("a NO_FROM request carries the pin after the node changes its answer", async () => {
    const { wallet, stubNode } = makeWallet({ chainInfo: PINNED, nodeInfo: PINNED })
    nodeLies(stubNode)
    const request = await (wallet as any).createTxExecutionRequestFromPayloadAndFee(
      privateCallPayload(),
      NO_FROM,
      feeOptions,
    )
    expect(request.txContext.chainId.toBigInt()).toBe(1n)
    expect(request.txContext.version.toBigInt()).toBe(7n)
  })

  it("an account built while the node rejects hashes authwits over the pin", async () => {
    const { wallet } = makeWallet({ chainInfo: PINNED, nodeRejects: true })
    const { account, address } = await buildAccount(wallet)
    expect(account.getChainId().toBigInt()).toBe(1n)
    expect(account.getVersion().toBigInt()).toBe(7n)

    const intent = { consumer: AztecAddress.fromBigIntUnsafe(0x5n), innerHash: new Fr(0x77n) }
    const passed = vi.spyOn(account, "createAuthWit")
    const witness = await wallet.createAuthWit(address, intent)
    const expected = await computeAuthWitMessageHash(intent, {
      chainId: new Fr(1),
      version: new Fr(7),
    })
    expect(witness.requestHash.equals(expected)).toBe(true)
    // The base class hands the pin down too, for account types that hash over the argument.
    const handed = (passed.mock.calls[0] as unknown[])[1] as { chainId: Fr; version: Fr }
    expect(handed.chainId.toBigInt()).toBe(1n)
    expect(handed.version.toBigInt()).toBe(7n)
  })

  it("unpinned: an account build asks the node and fails with it", async () => {
    const { wallet } = makeWallet({ nodeRejects: true })
    await expect(buildAccount(wallet)).rejects.toThrow("node unreachable")
  })

  it("an account send request carries the pin after the node changes its answer", async () => {
    const { wallet, stubNode } = makeWallet({ chainInfo: PINNED, nodeInfo: PINNED })
    const { address } = await buildAccount(wallet)
    nodeLies(stubNode)
    const request = await (wallet as any).buildSendRequest(
      new ExecutionPayload([], [], [], []),
      address,
      feeOptions,
      Fr.random(),
    )
    expect(request.txContext.chainId.toBigInt()).toBe(1n)
    expect(request.txContext.version.toBigInt()).toBe(7n)
  })

  it("the stub-entrypoint simulation carries the pin while the node rejects", async () => {
    const { wallet, stubPxe, stubNode } = makeWallet({ chainInfo: PINNED, nodeRejects: true })
    const { address } = await buildAccount(wallet)
    ;(wallet as any).buildAccountOverrides = async () => new SimulationOverrides({})
    await (wallet as any).simulateViaStubEntrypoint(new ExecutionPayload([], [], [], []), {
      from: address,
      feeOptions,
      skipTxValidation: true,
      skipFeeEnforcement: true,
    })
    expect(stubNode.getNodeInfo).not.toHaveBeenCalled()
    const request = stubPxe.simulateTx.mock.calls[0][0]
    expect(request.txContext.chainId.toBigInt()).toBe(1n)
    expect(request.txContext.version.toBigInt()).toBe(7n)
  })

  it("unpinned: the stub-entrypoint simulation fails with a rejecting node", async () => {
    const { wallet, stubNode } = makeWallet()
    const { address } = await buildAccount(wallet)
    stubNode.getNodeInfo.mockImplementation(async () => {
      throw new Error("node unreachable")
    })
    ;(wallet as any).buildAccountOverrides = async () => new SimulationOverrides({})
    await expect(
      (wallet as any).simulateViaStubEntrypoint(new ExecutionPayload([], [], [], []), {
        from: address,
        feeOptions,
        skipTxValidation: true,
        skipFeeEnforcement: true,
      }),
    ).rejects.toThrow("node unreachable")
  })

  it("link stamps and authwit fields come from the pin while the node rejects", async () => {
    const { wallet } = makeWallet({ chainInfo: PINNED, nodeRejects: true })
    await expect(linkChainInfo(wallet)).resolves.toEqual({ chainId: 1, rollupVersion: 7 })
    const fields = await chainInfoFields(wallet)
    expect(fields.chainId.toBigInt()).toBe(1n)
    expect(fields.version.toBigInt()).toBe(7n)
  })

  it("unpinned: link stamps and authwit fields fail with a rejecting node", async () => {
    const { wallet } = makeWallet({ nodeRejects: true })
    await expect(linkChainInfo(wallet)).rejects.toThrow("node unreachable")
    await expect(chainInfoFields(wallet)).rejects.toThrow("node unreachable")
  })
})

// @vitest-environment node
/** Settings recovery's search for a pasted address of this account, over a fake L1 and L2. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeFunctionData, encodeFunctionResult, erc20Abi, type Address, type Hex } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { SIPAFactoryAbi } from "@oxide/l1-contracts"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  createResolverWindow,
  createSipaDeposits,
  fixed,
  loadRecords,
  memoryBackend,
  memoryStore,
  openDatabase,
  SELF_SLOTS,
  selfDeployment,
  type IdentityView,
} from "@obsidion/front-core"
import { selfSipaNonce } from "@obsidion/sdk"
import { createPageChain } from "../../../../src/app/pageChain"
import { createSipaAddresses } from "../../../../src/features/deposit/sipaAddresses"
import { windowKeys, type SipaKeys } from "../../../../src/features/deposit/sipaRail"
import { defaultConfig } from "../../../support/page"
import { testChain } from "../../../support/query"

const DAY_MS = 86_400_000
const FACTORY = "0x00000000000000000000000000000000000000f1" as Address
const IMPLEMENTATION = "0x00000000000000000000000000000000000000e1" as Address
const TOKEN = "0x00000000000000000000000000000000000000d1" as Address
const RECOVERY = "0x4444444444444444444444444444444444444444" as Address
const CHAIN_DAY = 20_400

const TUPLE = {
  rollupVersion: "7",
  portal: "0x00000000000000000000000000000000000000a0",
  sipaFactory: FACTORY,
  forwardingTable: "0x00000000000000000000000000000000000000fb",
  accountFactory: "0x00000000000000000000000000000000000000ac",
  sipaRecoveryProtocol: "account",
  token: TOKEN,
  l2Token: `0x${"0c".repeat(32)}`,
  deployedAt: new Date((CHAIN_DAY - 1) * DAY_MS).toISOString(),
} as OxideEnvTuple

const KEYS = {
  msk: new Fr(7n),
  recipient: AztecAddress.fromStringUnsafe(`0x0a${"a1".repeat(31)}`),
  stealthKey: { scalar: 1n },
  recoveryAccount: RECOVERY,
} as unknown as SipaKeys

/** An L1 whose factory predicts `predicted` for every SIPA. */
function fakeL1(predicted: Address) {
  const answer = ({ to, data }: { to: Address; data: Hex }): Hex => {
    if (to.toLowerCase() === FACTORY) {
      const { functionName } = decodeFunctionData({ abi: SIPAFactoryAbi, data })
      const result = functionName === "implementationFor" ? IMPLEMENTATION : predicted
      return encodeFunctionResult({ abi: SIPAFactoryAbi, functionName, result } as never)
    }
    const { functionName } = decodeFunctionData({ abi: erc20Abi, data })
    const result = functionName === "symbol" ? "DAI" : 18
    return encodeFunctionResult({ abi: erc20Abi, functionName, result } as never)
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as
        | { id: number; params: [{ to: Address; data: Hex }] }
        | { id: number; params: [{ to: Address; data: Hex }] }[]
      const reply = (r: { id: number; params: [{ to: Address; data: Hex }] }) => ({
        jsonrpc: "2.0",
        id: r.id,
        result: answer(r.params[0]),
      })
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)))
    }),
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("recordShown", () => {
  it("finds an address shown on today's chain day while the device clock is still on yesterday", async () => {
    const deployment = selfDeployment(TUPLE, IMPLEMENTATION, RECOVERY, [])!
    const shown = (
      await createResolverWindow(SELF_SLOTS)(windowKeys(KEYS), [deployment], [], CHAIN_DAY * DAY_MS)
    ).find((c) => c.day === CHAIN_DAY && c.nonce === selfSipaNonce(0))!
    fakeL1(shown.sipaAddress)
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(CHAIN_DAY * DAY_MS - 60_000)
    const timestamp = BigInt((CHAIN_DAY * DAY_MS + 60_000) / 1000)
    const store = createSipaDeposits({
      db: openDatabase(memoryBackend()),
      account: true,
      now: () => Date.now(),
    })
    const addresses = createSipaAddresses({
      page: {
        config: defaultConfig,
        chain: createPageChain(defaultConfig, testChain(), undefined, { tuple: TUPLE }),
      },
      store,
      wallet: fixed("wallet", {
        node: { getBlock: async () => ({ header: { globalVariables: { timestamp } } }) },
        networkId: "0xnet",
        getPrivateEvents: async () => [],
      } as never),
      keys: fixed("keys", KEYS),
      discovery: () => fixed("discovery", {} as never),
      identity: memoryStore<IdentityView>({ value: null, loaded: true, failed: false }).readonly,
      railPending: memoryStore({ status: "pending" } as const).readonly,
      wakeBroadcasts: () => {},
      wake: async () => {},
    })

    expect(await addresses.recordShown(shown.sipaAddress)).toBe(true)
    expect((await loadRecords(store.view)).map((r) => r.slot)).toEqual([
      { day: CHAIN_DAY, nonce: selfSipaNonce(0) },
    ])
  })
})

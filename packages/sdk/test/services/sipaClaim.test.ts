/**
 * SIPA claim primitives — unit tests over stub clients. The Deposit logs are
 * encoded with viem's own event encoders against the vendored
 * OxidePortalEventsAbi, so the messageKey extraction is tested against real
 * log wire format (including the multi-sweep-per-tx batch case); the sweep
 * calldata builder is decoded back with viem and compared against the
 * vendored encoders directly.
 */

import { describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  multicall3Abi,
  parseAbiParameters,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin"
import {
  OxidePortalEventsAbi,
  encodeDeploySIPA,
  encodeRegistrationProofs,
  encodeSweep,
  type SipaDeployArgs,
  type SweepArgs,
} from "@oxide/l1-contracts"
import {
  buildRegistrationSweepCall,
  buildSipaSweepCall,
  EMPTY_SIGNED_TERMS,
  encodeRecoverErc20Call,
  fetchSipaEvents,
  isSipaDepositClaimed,
  MULTICALL3_ADDRESS,
  readDepositFee,
  readDepositMessageKey,
  readFundingTransfers,
  readSipaFundingStatus,
  readSweepEvents,
  TX_AMOUNT_CAP,
} from "../../src/services/sipaClaim.js"
import { OxideTokenContract } from "@obsidion/contracts"

const SIPA = "0x1234567890abcdef1234567890abcdef12345678" as Address
const PORTAL = "0x7992CD55908B19b60bc46926dEb9B1f1DFb6E0A9" as Address
const TX_HASH = `0x${"ab".repeat(32)}` as Hex

describe("isSipaDepositClaimed", () => {
  it("uses the live nullifier tree as the claimed source of truth", async () => {
    const getNullifierMembershipWitness = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ leafIndex: 7n })
    const params = {
      l1Portal: PORTAL,
      l1ChainId: 31337n,
      l2Token: AztecAddress.fromBigIntUnsafe(0x1234n),
      rollupVersion: 7n,
      recipient: AztecAddress.fromBigIntUnsafe(0xbee0n),
      messageSecret: new Fr(11n),
      amount: 100n,
      inboxIndex: 9n,
      masterNullifierHidingKey: GrumpkinScalar.random(),
    }

    expect(await isSipaDepositClaimed({ getNullifierMembershipWitness } as never, params)).toBe(
      false,
    )
    expect(await isSipaDepositClaimed({ getNullifierMembershipWitness } as never, params)).toBe(
      true,
    )
    expect(getNullifierMembershipWitness.mock.calls[0]![0]).toBe("latest")
    expect(String(getNullifierMembershipWitness.mock.calls[0]![1])).toMatch(/^0x[0-9a-f]+$/)
  })
})

function depositLog(portal: Address, key: Hex, index: bigint) {
  const topics = encodeEventTopics({
    abi: OxidePortalEventsAbi,
    eventName: "Deposit",
    args: { recipientCommitment: `0x${"11".repeat(32)}` as Hex },
  })
  const data = encodeAbiParameters(parseAbiParameters("uint256, bytes32, uint256"), [
    1000n,
    key,
    index,
  ])
  return { address: portal, topics, data }
}

describe("readSweepEvents", () => {
  /** A client whose head is `head` and which yields `logs` from the first chunk only. */
  const clientAt = (head: bigint, logs: unknown[] = []) =>
    ({
      getBlockNumber: vi.fn(async () => head),
      getContractEvents: vi.fn(async () => logs.splice(0, logs.length)),
    } as unknown as PublicClient)

  const ranges = (client: PublicClient) =>
    (client.getContractEvents as ReturnType<typeof vi.fn>).mock.calls.map(([c]) => [
      c.fromBlock,
      c.toBlock,
    ])

  it("maps Sweep logs to claim inputs including the emitting tx", async () => {
    const client = clientAt(100n, [
      { args: { index: 7n, amount: 990n }, blockNumber: 100n, transactionHash: TX_HASH },
    ])
    const sweeps = await readSweepEvents(client, SIPA)
    expect(sweeps).toEqual([{ index: 7n, amount: 990n, blockNumber: 100n, txHash: TX_HASH }])
    const call = (client.getContractEvents as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.address).toBe(SIPA)
    expect(call.eventName).toBe("Sweep")
  })

  // An `earliest → latest` range is refused outright by rate-limited RPCs, so the scan is
  // bounded and chunked — never one unbounded call.
  it("never asks for a range wider than the 10k chunk", async () => {
    const client = clientAt(11_383_721n)
    await readSweepEvents(client, SIPA)
    for (const [from, to] of ranges(client)) {
      expect(typeof from).toBe("bigint")
      expect((to as bigint) - (from as bigint)).toBeLessThan(10_000n)
    }
  })

  it("scans the look-back window up to the head, and no further", async () => {
    const head = 11_383_721n
    const client = clientAt(head)
    await readSweepEvents(client, SIPA)
    const r = ranges(client)
    expect(r[0][0]).toBe(head - 50_000n)
    expect(r[r.length - 1][1]).toBe(head)
  })

  it("honours an explicit fromBlock for a deposit older than the look-back", async () => {
    const client = clientAt(25_000n)
    await readSweepEvents(client, SIPA, 1_000n)
    expect(ranges(client)[0][0]).toBe(1_000n)
  })

  it("clamps to genesis on a chain shorter than the look-back", async () => {
    const client = clientAt(120n)
    await readSweepEvents(client, SIPA)
    expect(ranges(client)).toEqual([[0n, 120n]])
  })

  // A caller scanning many SIPAs bounds them all by one head, so it reads that head itself
  // and each scan costs no eth_blockNumber of its own.
  it("honours an explicit toBlock without reading the head", async () => {
    const client = clientAt(11_383_721n)
    await readSweepEvents(client, SIPA, 11_380_000n, 11_380_500n)
    expect(client.getBlockNumber).not.toHaveBeenCalled()
    expect(ranges(client)).toEqual([[11_380_000n, 11_380_500n]])
  })

  it("derives the look-back from an explicit toBlock, not the live head", async () => {
    const client = clientAt(11_383_721n)
    await readSweepEvents(client, SIPA, undefined, 60_000n)
    expect(ranges(client)[0][0]).toBe(10_000n)
  })
})

describe("readDepositMessageKey", () => {
  // In-field values — real message keys are sha256ToField outputs (< BN254 r).
  const KEY_A = `0x${"0a".repeat(32)}` as Hex
  const KEY_B = `0x${"0b".repeat(32)}` as Hex

  it("selects the Deposit event matching the inbox index in a multi-sweep batch tx", async () => {
    const client = {
      getTransactionReceipt: vi.fn(async () => ({
        logs: [depositLog(PORTAL, KEY_A, 7n), depositLog(PORTAL, KEY_B, 8n)],
      })),
    } as unknown as PublicClient

    const key = await readDepositMessageKey(client, PORTAL, TX_HASH, 8n)
    expect(key?.toString()).toBe(KEY_B)
  })

  it("ignores Deposit events from other contracts and returns null when nothing matches", async () => {
    const otherPortal = "0x9999999999999999999999999999999999999999" as Address
    const client = {
      getTransactionReceipt: vi.fn(async () => ({
        logs: [depositLog(otherPortal, KEY_A, 7n)],
      })),
    } as unknown as PublicClient

    expect(await readDepositMessageKey(client, PORTAL, TX_HASH, 7n)).toBeNull()
  })
})

describe("readFundingTransfers", () => {
  const TOKEN = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address
  const FUNDER = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4" as Address

  it("maps Transfer logs to funding transfers and filters on the token + to=sipa", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => 100n),
      getContractEvents: vi.fn(async () => [
        { args: { from: FUNDER, value: 1_000_000n }, blockNumber: 42n, transactionHash: TX_HASH },
      ]),
    } as unknown as PublicClient

    const transfers = await readFundingTransfers(client, TOKEN, SIPA)

    expect(transfers).toEqual([
      { from: FUNDER, amount: 1_000_000n, blockNumber: 42n, txHash: TX_HASH },
    ])
    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        eventName: "Transfer",
        args: { to: SIPA },
      }),
    )
  })

  it("honours explicit window bounds without reading the head (shared scan shape)", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => {
        throw new Error("must not read the head")
      }),
      getContractEvents: vi.fn(async () => []),
    } as unknown as PublicClient

    await readFundingTransfers(client, TOKEN, SIPA, 1_000n, 1_500n)

    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 1_000n, toBlock: 1_500n }),
    )
  })
})

describe("readSipaFundingStatus", () => {
  function client(balance: bigint, fee: bigint): PublicClient {
    return {
      readContract: async (params: { functionName: string }) => {
        if (params.functionName === "balanceOf") return balance
        if (params.functionName === "depositFee") return fee
        throw new Error(`unexpected read: ${params.functionName}`)
      },
    } as unknown as PublicClient
  }
  const params = {
    sipa: SIPA,
    token: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address,
    implementation: "0x6f94c6c6014199ae899e086ec75b6a2245371ce3" as Address,
    fpcFundingCut: 0n,
  }
  /** Same SIPA, on a deployment that skims a funding cut on top of the sweep fee. */
  const withCut = { ...params, fpcFundingCut: 40n }

  it("balance must strictly exceed the fee to be sweepable", async () => {
    expect((await readSipaFundingStatus(client(100n, 100n), params)).sweepable).toBe(false)
    expect((await readSipaFundingStatus(client(101n, 100n), params)).sweepable).toBe(true)
    expect((await readSipaFundingStatus(client(0n, 100n), params)).sweepable).toBe(false)
  })

  it("adds the portal's funding cut to the floor", async () => {
    // The portal requires the deposit left after the fee to exceed its cut, so a balance that clears
    // the sweep fee alone still cannot be swept.
    expect((await readSipaFundingStatus(client(120n, 100n), withCut)).sweepable).toBe(false)
    expect((await readSipaFundingStatus(client(140n, 100n), withCut)).sweepable).toBe(false)
    expect((await readSipaFundingStatus(client(141n, 100n), withCut)).sweepable).toBe(true)
  })

  it("measures the cap against the amount credited on L2, not the whole balance", async () => {
    // The sweep pays the fee and the portal keeps the cut, so the window's top sits both above the
    // cap.
    const at = await readSipaFundingStatus(client(TX_AMOUNT_CAP + 100n, 100n), params)
    const over = await readSipaFundingStatus(client(TX_AMOUNT_CAP + 101n, 100n), params)
    expect([at.sweepable, over.sweepable]).toEqual([true, false])
    const atWithCut = await readSipaFundingStatus(client(TX_AMOUNT_CAP + 140n, 100n), withCut)
    const overWithCut = await readSipaFundingStatus(client(TX_AMOUNT_CAP + 141n, 100n), withCut)
    expect([atWithCut.sweepable, overWithCut.sweepable]).toEqual([true, false])
    // A zero floor collapses that top back onto the cap itself.
    expect((await readSipaFundingStatus(client(TX_AMOUNT_CAP, 0n), params)).sweepable).toBe(true)
    expect((await readSipaFundingStatus(client(TX_AMOUNT_CAP + 1n, 0n), params)).sweepable).toBe(
      false,
    )
  })

  it("reports the balance, the fee it read and the cut it was given alongside the verdict", async () => {
    expect(await readSipaFundingStatus(client(141n, 100n), withCut)).toEqual({
      balance: 141n,
      scaledBalance: 141n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: true,
    })
  })

  it("scales a 6-decimal balance into the fee's denomination", async () => {
    // 5,000 USDC against an 18-dec fee: raw units read as dust below the floor, scaled they are
    // far over the cap.
    const usdc = { ...params, balanceScale: 10n ** 12n, fpcFundingCut: parseEther("0.1") }
    const status = await readSipaFundingStatus(client(5_000_000_000n, parseEther("0.25")), usdc)
    expect(status.balance).toBe(5_000_000_000n)
    expect(status.scaledBalance).toBe(parseEther("5000"))
    expect(status.sweepable).toBe(false)
    expect(status.scaledBalance - status.fee - status.fpcFundingCut > TX_AMOUNT_CAP).toBe(true)
  })
})

describe("encodeRecoverErc20Call", () => {
  it("targets the SIPA with recoverERC20(signature, target, token, nonce) calldata", async () => {
    const { decodeFunctionData: decode, parseAbi } = await import("viem")
    const SIPAAbi = parseAbi([
      "function recoverERC20(bytes signature, address target, address token, bytes32 nonce)",
    ])
    const signature = `0x${"cd".repeat(65)}` as Hex
    const call = encodeRecoverErc20Call({
      protocol: "legacy-eoa",
      sipa: SIPA,
      signature,
      target: "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b",
      token: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b",
      nonce: `0x${"ab".repeat(32)}`,
    })
    expect(call.to).toBe(SIPA)
    const decoded = decode({ abi: SIPAAbi, data: call.data }) as {
      functionName: string
      args: readonly unknown[]
    }
    expect(decoded.functionName).toBe("recoverERC20")
    expect(decoded.args[0]).toBe(signature)
    expect(String(decoded.args[1]).toLowerCase()).toBe("0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b")
  })
})

describe("readDepositFee", () => {
  it("reads depositFee() off the intent implementation, not a clone", async () => {
    const implementation = "0x6f94c6c6014199ae899e086ec75b6a2245371ce3"
    const client = {
      readContract: async (params: { functionName: string; address: string }) => {
        expect(params.functionName).toBe("depositFee")
        expect(params.address).toBe(implementation)
        return 250_000n
      },
    } as unknown as PublicClient
    expect(await readDepositFee(client, implementation)).toBe(250_000n)
  })
})

describe("buildSipaSweepCall", () => {
  const recipientCommitment = `0x${"11".repeat(32)}` as const
  const deployArgs: SipaDeployArgs = {
    implementation: "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4",
    intentHash: `0x${"22".repeat(32)}`,
    recoveryCommitment: `0x${"44".repeat(32)}`,
    rollupVersion: 4127419662n,
    resweepable: false,
  }
  const sweepArgs: SweepArgs = {
    token: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b",
    relayer: "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b",
    intentData: recipientCommitment,
    proofs: "0x",
  }

  it("sweeps a deployed SIPA directly (a second deploy would revert on the CREATE2 collision)", () => {
    const call = buildSipaSweepCall({
      deployed: true,
      sipaFactory: "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f",
      sipa: SIPA,
      deployArgs,
      sweepArgs,
    })
    expect(call.to).toBe(SIPA)
    expect(call.data).toBe(encodeSweep(sweepArgs))
  })

  it("deploys and sweeps an undeployed SIPA atomically through Multicall3 aggregate3", () => {
    const sipaFactory = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
    const call = buildSipaSweepCall({
      deployed: false,
      sipaFactory,
      sipa: SIPA,
      deployArgs,
      sweepArgs,
    })
    expect(call.to).toBe(MULTICALL3_ADDRESS)

    const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data })
    expect(decoded.functionName).toBe("aggregate3")
    const [calls] = decoded.args as [{ target: Address; allowFailure: boolean; callData: Hex }[]]
    expect(calls).toHaveLength(2)
    expect(calls[0].target.toLowerCase()).toBe(sipaFactory)
    expect(calls[0].allowFailure).toBe(false)
    expect(calls[0].callData).toBe(encodeDeploySIPA(deployArgs))
    expect(calls[1].target.toLowerCase()).toBe(SIPA)
    expect(calls[1].callData).toBe(encodeSweep(sweepArgs))
  })
})

describe("buildRegistrationSweepCall", () => {
  const registrationData = `0x${"ab".repeat(96)}` as Hex
  const deployArgs: SipaDeployArgs = {
    implementation: "0x9a1e3c2f5d7b8046a1c2e3f4d5b6a7089c0d1e2f",
    intentHash: `0x${"33".repeat(32)}`,
    recoveryCommitment: `0x${"44".repeat(32)}`,
    rollupVersion: 4127419662n,
    resweepable: false,
  }
  const sipaFactory = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
  const token = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address
  const relayer = "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b" as Address
  const consentSig = `0x${"cd".repeat(65)}` as Hex
  const domainAuth = { nonce: 7n, deadline: 1893456000n, signature: `0x${"ee".repeat(65)}` as Hex }
  const r1Install = {
    qx: `0x${"a1".repeat(32)}` as Hex,
    qy: `0x${"a2".repeat(32)}` as Hex,
    metadata: `0x${"cc".repeat(20)}` as Hex,
    signature: `0x${"dd".repeat(65)}` as Hex,
  }
  const args = {
    sipaFactory,
    sipa: SIPA,
    deployArgs,
    registrationData,
    consentSig,
    bootstrap: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a" as Address,
    domainAuth,
    signedTerms: EMPTY_SIGNED_TERMS,
    r1Install,
    token,
    relayer,
  }
  // The registration intent is the revealed intentData; the consent/domain/terms pack as proofs.
  const expectedSweep = (): SweepArgs => ({
    token,
    relayer,
    intentData: registrationData,
    proofs: encodeRegistrationProofs({
      consentSig,
      bootstrap: args.bootstrap,
      domainAuth,
      signedTerms: EMPTY_SIGNED_TERMS,
      r1Install,
    }),
  })

  it("sweeps a deployed registration SIPA directly, revealing the intent and its proofs", () => {
    const call = buildRegistrationSweepCall({ deployed: true, ...args })
    expect(call.to).toBe(SIPA)
    expect(call.data).toBe(encodeSweep(expectedSweep()))
  })

  it("deploy-and-sweeps an undeployed registration SIPA through Multicall3 aggregate3", () => {
    const call = buildRegistrationSweepCall({ deployed: false, ...args })
    expect(call.to).toBe(MULTICALL3_ADDRESS)
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data })
    expect(decoded.functionName).toBe("aggregate3")
    const [calls] = decoded.args as [{ target: Address; allowFailure: boolean; callData: Hex }[]]
    expect(calls).toHaveLength(2)
    expect(calls[0].target.toLowerCase()).toBe(sipaFactory)
    expect(calls[0].callData).toBe(encodeDeploySIPA(deployArgs))
    expect(calls[1].target.toLowerCase()).toBe(SIPA)
    expect(calls[1].callData).toBe(encodeSweep(expectedSweep()))
  })
})

describe("fetchSipaEvents", () => {
  it("reads the token's SIPA events in the recipient's scope and joins the intent-hash limbs", async () => {
    const token = AztecAddress.fromBigIntUnsafe(0x70c3n)
    const recipient = AztecAddress.fromBigIntUnsafe(0xbee0n)
    const intentHash = `0x${"12".repeat(16)}${"34".repeat(16)}` as Hex
    const getPrivateEvents = vi.fn(async () => [
      {
        event: {
          shared_secret_salt: 7n,
          resweepable: true,
          intent_hash_hi: BigInt(`0x${"12".repeat(16)}`),
          intent_hash_lo: BigInt(`0x${"34".repeat(16)}`),
        },
      },
    ])
    const filter = { fromBlock: 3, toBlock: 9 } as never

    const events = await fetchSipaEvents({ getPrivateEvents } as never, token, recipient, filter)

    expect(events).toEqual([{ sharedSecretSalt: new Fr(7n), resweepable: true, intentHash }])
    expect(getPrivateEvents).toHaveBeenCalledWith(OxideTokenContract.events.SIPA, {
      fromBlock: 3,
      toBlock: 9,
      contractAddress: token,
      scopes: [recipient],
    })
  })
})

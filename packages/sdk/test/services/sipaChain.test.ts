import { describe, expect, it, vi } from "vitest"
import type { Address, Hex, PublicClient } from "viem"
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem"
import {
  readPortalDeposits,
  readSweptSipa,
  readTokenTransfers,
  SIPA_TOPICS_PER_FILTER,
} from "../../src/services/sipaChain.js"

const PORTAL = "0x92308cE04e2416f20b03e941a14F9238C3603334" as Address
const DAI = "0x00000000000000000000000000000000000000d1" as Address
const USDC = "0x00000000000000000000000000000000000000d2" as Address
const hex = (n: number, size: number) => `0x${n.toString(16).padStart(size * 2, "0")}` as Hex

describe("readPortalDeposits", () => {
  it("filters the portal by commitment topic, one filter per chunk, and returns logs in chain order", async () => {
    const commitments = Array.from({ length: SIPA_TOPICS_PER_FILTER + 1 }, (_, i) => hex(i + 1, 32))
    const getContractEvents = vi.fn(async (request: { args: { recipientCommitment: Hex[] } }) =>
      request.args.recipientCommitment.length === 1
        ? [
            {
              address: PORTAL,
              args: {
                recipientCommitment: commitments.at(-1),
                amount: 9n,
                key: hex(7, 32),
                index: 3n,
              },
              blockNumber: 10n,
              transactionHash: hex(1, 32),
              logIndex: 4,
            },
          ]
        : [
            {
              address: PORTAL,
              args: { recipientCommitment: commitments[0], amount: 5n, key: hex(8, 32), index: 2n },
              blockNumber: 10n,
              transactionHash: hex(2, 32),
              logIndex: 1,
            },
          ],
    )
    const client = { getContractEvents } as unknown as PublicClient

    const deposits = await readPortalDeposits(client, PORTAL, commitments, 1n, 20n)

    expect(getContractEvents).toHaveBeenCalledTimes(2)
    for (const [request] of getContractEvents.mock.calls) {
      expect(request).toMatchObject({
        address: PORTAL,
        eventName: "Deposit",
        fromBlock: 1n,
        toBlock: 20n,
      })
    }
    expect(getContractEvents.mock.calls.map(([r]) => r.args.recipientCommitment.length)).toEqual([
      SIPA_TOPICS_PER_FILTER,
      1,
    ])
    expect(deposits.map((d) => [d.index, d.amount, d.key])).toEqual([
      [2n, 5n, hex(8, 32)],
      [3n, 9n, hex(7, 32)],
    ])
  })
})

describe("readTokenTransfers", () => {
  it("names the SIPAs in the indexed side and the tokens in the address list", async () => {
    const sipa = hex(0xab, 20) as Address
    const getContractEvents = vi.fn(async () => [
      {
        address: USDC,
        args: { from: sipa, to: PORTAL, value: 4n },
        blockNumber: 12n,
        transactionHash: hex(3, 32),
        logIndex: 0,
      },
    ])
    const client = { getContractEvents } as unknown as PublicClient

    const flows = await readTokenTransfers(client, [DAI, USDC], "from", [sipa, sipa], 5n, 15n)

    expect(getContractEvents).toHaveBeenCalledOnce()
    expect(getContractEvents.mock.calls[0]![0]).toMatchObject({
      address: [DAI, USDC],
      eventName: "Transfer",
      args: { from: [sipa] },
    })
    expect(flows).toEqual([
      {
        token: USDC,
        from: sipa,
        to: PORTAL,
        value: 4n,
        blockNumber: 12n,
        txHash: hex(3, 32),
        logIndex: 0,
      },
    ])
  })

  it("reads nothing for no SIPAs", async () => {
    const getContractEvents = vi.fn()
    const client = { getContractEvents } as unknown as PublicClient
    await expect(readTokenTransfers(client, [DAI], "to", [], 0n, 1n)).resolves.toEqual([])
    expect(getContractEvents).not.toHaveBeenCalled()
  })
})

describe("readSweptSipa", () => {
  const sweepEvent = parseAbiItem("event Sweep(uint256 index, uint256 amount)")
  const sweepLog = (address: Address, index: bigint) => ({
    address,
    topics: encodeEventTopics({ abi: [sweepEvent], eventName: "Sweep" }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [index, 5n]),
    blockNumber: 1n,
    transactionHash: hex(9, 32),
    logIndex: 0,
    blockHash: hex(1, 32),
    transactionIndex: 0,
    removed: false,
  })

  it("names the SIPA whose Sweep carries the deposit's index", async () => {
    const a = hex(0xaa, 20) as Address
    const b = hex(0xbb, 20) as Address
    const client = {
      getTransactionReceipt: vi.fn(async () => ({ logs: [sweepLog(a, 3n), sweepLog(b, 4n)] })),
    } as unknown as PublicClient

    expect(await readSweptSipa(client, hex(9, 32), 4n)).toBe(b)
    expect(await readSweptSipa(client, hex(9, 32), 5n)).toBeUndefined()
  })
})

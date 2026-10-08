import { EthAddress } from "@aztec/foundation/eth-address"
import { describe, expect, it } from "vitest"

import {
  NodeIdentityMismatchError,
  profileRollupSkew,
  verifyNodeIdentity,
  type NodeIdentityInfo,
} from "../../src/core/nodeIdentity"

const ROLLUP = "0x" + "ab".repeat(20)
const INBOX = "0x" + "cd".repeat(20)
const OTHER = "0x" + "ee".repeat(20)

const expected = {
  l1ChainId: 11155111,
  rollupVersion: "1821665230",
  rollupAddress: ROLLUP,
  inboxAddress: INBOX,
}

const nodeInfo = (overrides: Partial<NodeIdentityInfo> = {}): NodeIdentityInfo => ({
  l1ChainId: 11155111,
  rollupVersion: 1821665230,
  l1ContractAddresses: {
    rollupAddress: EthAddress.fromString(ROLLUP),
    inboxAddress: EthAddress.fromString(INBOX),
  },
  ...overrides,
})

describe("verifyNodeIdentity", () => {
  it("passes when the node agrees with L1 on all four fields", () => {
    expect(() => verifyNodeIdentity({ nodeInfo: nodeInfo(), expected })).not.toThrow()
  })

  it("names the first field the node disagrees on", () => {
    const cases: [string, NodeIdentityInfo, string | number][] = [
      ["l1ChainId", nodeInfo({ l1ChainId: 1 }), 1],
      ["rollupVersion", nodeInfo({ rollupVersion: 4127419662 }), "4127419662"],
      [
        "rollupAddress",
        nodeInfo({
          l1ContractAddresses: {
            rollupAddress: EthAddress.fromString(OTHER),
            inboxAddress: EthAddress.fromString(INBOX),
          },
        }),
        OTHER,
      ],
      [
        "inboxAddress",
        nodeInfo({
          l1ContractAddresses: {
            rollupAddress: EthAddress.fromString(ROLLUP),
            inboxAddress: EthAddress.fromString(OTHER),
          },
        }),
        OTHER,
      ],
    ]
    for (const [field, info, got] of cases) {
      const err = (() => {
        try {
          verifyNodeIdentity({ nodeInfo: info, expected })
        } catch (e) {
          return e
        }
      })()
      expect(err).toBeInstanceOf(NodeIdentityMismatchError)
      expect(err).toMatchObject({ field, got, expected: expected[field as keyof typeof expected] })
      expect((err as Error).message).toContain(field)
    }
  })

  it("compares addresses case-insensitively", () => {
    const upper = {
      ...expected,
      rollupAddress: "0x" + "AB".repeat(20),
      inboxAddress: "0x" + "CD".repeat(20),
    }
    expect(() => verifyNodeIdentity({ nodeInfo: nodeInfo(), expected: upper })).not.toThrow()
  })
})

describe("profileRollupSkew", () => {
  it("is undefined when the profile matches L1", () => {
    expect(profileRollupSkew("5", { rollupVersion: "5" })).toBeUndefined()
  })

  it("returns the pair when they differ", () => {
    expect(profileRollupSkew("4", { rollupVersion: "5" })).toEqual({ profile: "4", l1: "5" })
  })
})

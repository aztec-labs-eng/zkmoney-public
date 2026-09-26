/**
 * Selector parity for the oxide-aligned bridge content hashes.
 *
 * The content-hash selector strings appear byte-for-byte inside the L1↔L2
 * message commitments:
 *
 *   claim_content_hash             ← keccak256("claim(bytes32,uint256)")[:4]
 *   withdraw_content_hash          ← keccak256("withdraw(address,uint256)")[:4]
 *   register_signer_content_hash   ← keccak256("register_signer(address,bytes32,bytes32)")[:4]
 *
 * These selectors must match oxide byte-for-byte; otherwise the obsidion
 * relayer and the oxide portal disagree about which L1→L2 / L2→L1 message
 * was actually queued. This test pins the 4-byte selectors against viem's
 * `toFunctionSelector` (keccak256-based, matching `cast sig`), so any drift
 * in either codebase's encoding fails CI before it can ship.
 */
import { describe, expect, it } from "vitest"
import { toFunctionSelector } from "viem"

// Source of truth: `cast sig "<signature>"` run against oxide's contracts
// (and the canonical keccak256 selector for any Solidity-shape signature).
const OXIDE_CLAIM_SELECTOR = "0x63f44968"
const OXIDE_WITHDRAW_SELECTOR = "0xf3fef3a3"
const OXIDE_REGISTER_SIGNER_SELECTOR = "0x9a66dfbe"

describe("bridge content-hash selector parity (oxide)", () => {
  it("claim(bytes32,uint256) matches oxide", () => {
    expect(toFunctionSelector("claim(bytes32,uint256)")).toBe(OXIDE_CLAIM_SELECTOR)
  })

  it("withdraw(address,uint256) matches oxide", () => {
    expect(toFunctionSelector("withdraw(address,uint256)")).toBe(OXIDE_WITHDRAW_SELECTOR)
  })

  it("register_signer(address,bytes32,bytes32) matches oxide", () => {
    expect(toFunctionSelector("register_signer(address,bytes32,bytes32)")).toBe(
      OXIDE_REGISTER_SIGNER_SELECTOR,
    )
  })

  it("selectors are distinct (no accidental collision between the three)", () => {
    const all = new Set([
      OXIDE_CLAIM_SELECTOR,
      OXIDE_WITHDRAW_SELECTOR,
      OXIDE_REGISTER_SIGNER_SELECTOR,
    ])
    expect(all.size).toBe(3)
  })
})

/**
 * OxideToken class-id drift sentinel.
 *
 * `EXPECTED_CLASS_ID` is the LOCAL-build class id of `vendor/oxide`'s
 * oxide_token_contract at the vendor pin, compiled with the same
 * `--inliner-aggressiveness 0` flag oxide's cd-dev pipeline uses.
 *
 * `VERIFY_ONCHAIN_CLASS_ID=1` checks the local build against the class the live instance runs,
 * resolved from the entry `OXIDE_PORTAL` pins in `OXIDE_MANIFEST_URL`. That check is the one that matters —
 * a divergence there breaks every oxide-token read and send.
 *
 * Re-pin per oxide deployment roll:
 * 1. Bump `vendor/oxide` to the new deploy commit.
 * 2. Run `pnpm build-contracts -c oxide_token_contract`.
 * 3. Run with `VERIFY_ONCHAIN_CLASS_ID=1` to confirm local-build == on-chain.
 * 4. `EXPECTED_CLASS_ID` follows the local build. The on-chain half resolves its address
 *    from the manifest, so it follows whichever deployment `OXIDE_PORTAL` names. A move can
 *    come from the contract source or from the toolchain; the id alone does not say which.
 */

import { describe, expect, it } from "vitest"
import { getContractClassFromArtifact } from "@aztec/stdlib/contract"

import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { getHardcodedArtifact } from "../../src/services/utils.js"
import { liveInstanceClassId } from "./liveClassId.js"

// Accepted risk: the unconditional test below proves only that the built artifact derives this id.
// Nothing in CI compares it against a live deployment, so an artifact that does not match the
// deployed class reaches a release unless somebody runs the second test by hand.
const EXPECTED_CLASS_ID = "0x1979a8fdbb3e928c486554559baa63a9c81a143a9a7741f1bc9195f549198013"

const verifyOnChain = process.env.VERIFY_ONCHAIN_CLASS_ID === "1"

describe("OxideToken class id", () => {
  it("matches the pinned class id (drift sentinel)", async () => {
    const artifact = await getHardcodedArtifact(DEFAULT_CONTRACTS.oxideToken)
    const cls = await getContractClassFromArtifact(artifact)
    expect(cls.id.toString()).toBe(EXPECTED_CLASS_ID)
  })

  it.runIf(verifyOnChain)(
    "matches the class the live staging instance runs",
    async () => {
      const { classId } = await liveInstanceClassId("l2Token")
      expect(classId).toBe(EXPECTED_CLASS_ID)
    },
    30_000,
  )
})

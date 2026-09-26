/**
 * Broadcaster class-id drift sentinel.
 *
 * `EXPECTED_CLASS_ID` is the LOCAL-build class id of `vendor/oxide`'s
 * broadcaster_contract at the vendor pin, compiled with the same
 * `--inliner-aggressiveness 0` flag oxide's deploy pipeline uses.
 *
 * `VERIFY_ONCHAIN_CLASS_ID=1` is the check that matters: it resolves the live instance from the
 * entry `OXIDE_PORTAL` pins in `OXIDE_MANIFEST_URL` and compares the class the wallet's PXE would
 * have to register against. A divergence there means every broadcast fails with "No artifact
 * registered for contract class".
 *
 * Re-pin when oxide changes the contract SOURCE (a redeploy of unchanged source moves the instance
 * but not the class, and needs no edit):
 * 1. Bump `vendor/oxide` to the new deploy commit.
 * 2. Run `pnpm build-contracts -c broadcaster_contract`.
 * 3. Run with `VERIFY_ONCHAIN_CLASS_ID=1` to confirm local-build == on-chain, and move
 *    `EXPECTED_CLASS_ID` to the local build. If the two diverge with no pending redeploy,
 *    investigate (toolchain drift or a genuine source-level change).
 */

import { describe, expect, it } from "vitest"
import { getContractClassFromArtifact } from "@aztec/stdlib/contract"

import { getBroadcasterArtifact } from "../../src/services/utils.js"
import { liveInstanceClassId } from "./liveClassId.js"

// Pinned at the Broadcaster source of vendor/oxide 3fab04e6. The broadcaster links oxide_lib, whose
// WebAuthn P-256 signature normalisation is part of the compiled private functions, so the class id
// commits to it. Every deployment from that oxide source runs this class.
const EXPECTED_CLASS_ID = "0x20ecff6fc13d5af9c939826cd2b79995c4bc50c7c3869de3229e1364e2528a83"

const verifyOnChain = process.env.VERIFY_ONCHAIN_CLASS_ID === "1"

describe("Broadcaster class id", () => {
  it("matches the pinned class id (drift sentinel)", async () => {
    const artifact = await getBroadcasterArtifact()
    const cls = await getContractClassFromArtifact(artifact)
    expect(cls.id.toString()).toBe(EXPECTED_CLASS_ID)
  })

  it.runIf(verifyOnChain)(
    "matches the class the live staging instance runs",
    async () => {
      const { classId } = await liveInstanceClassId("l2Broadcaster")
      expect(classId).toBe(EXPECTED_CLASS_ID)
    },
    30_000,
  )
})

/**
 * A registration SIPA as the wallet records it when the address is derived: its origin names the
 * SIPA implementation, whose terms name the portal capacity is read from.
 */
import type { Address, Hex } from "viem"
import { SIPADepositStore } from "@obsidion/front-core"
import type { SipaPortalTerms } from "@obsidion/sdk"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"

export const ORIGINAL_IMPLEMENTATION = "0x7777777777777777777777777777777777777777" as Address
/** Not the active bucket's portal (`FAKE_ACTIVE_KEY`): capacity must come from this one. */
export const ORIGINAL_PORTAL = "0x9999999999999999999999999999999999999999" as Address

export function originalTerms(token: string): SipaPortalTerms {
  return {
    portal: ORIGINAL_PORTAL,
    token: token as Address,
    depositFee: 25n * 10n ** 16n,
    fpcFundingCut: 10n ** 17n,
  }
}

export async function seedRecordedRegistration(input: {
  sipaAddress: string
  token: string
  registrationFee: bigint
  l1ChainId: number
  /** Leave the origin out, as a record from before origins were stored. */
  withoutOrigin?: boolean
  /** The terms of an implementation are read once per page, so a test that counts reads uses its own. */
  implementation?: Address
  /** The deposit was recovered off the address (a refunded registration). */
  recovered?: boolean
}): Promise<void> {
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  await store.upsert(
    input.sipaAddress as Address,
    {
      phase: input.recovered ? "recovered" : "broadcast",
      registrationFee: input.registrationFee.toString(),
      ...(input.recovered ? { recoveryTxHash: `0x${"ab".repeat(32)}` as Hex } : {}),
    },
    {
      recipientL2Address: `0x${"22".repeat(32)}`,
      messageSecret: `0x${"33".repeat(32)}`,
      recipientHash: `0x${"44".repeat(32)}`,
      recoveryAddress: "0x00000000000000000000000000000000000000aa",
      ...(input.withoutOrigin
        ? {}
        : {
            origin: {
              sipaFactory: "0x00000000000000000000000000000000000000e7" as Address,
              implementation: input.implementation ?? ORIGINAL_IMPLEMENTATION,
              intentHash: `0x${"55".repeat(32)}` as Hex,
              rollupVersion: "1",
              resweepable: false,
              protocol: "legacy-eoa" as const,
              recoveryAddress: "0x00000000000000000000000000000000000000aa" as Address,
            },
          }),
      l1ChainId: input.l1ChainId,
      amount: "0",
      tokenSymbol: "DAI",
      startTime: Date.now(),
      tokenAddress: input.token as Address,
      intent: "registration",
    },
  )
}

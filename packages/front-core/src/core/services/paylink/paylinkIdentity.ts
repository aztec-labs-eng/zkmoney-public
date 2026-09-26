import type { PaylinkParams } from "@obsidion/sdk"
import { keccak256, toBytes } from "viem"

/** Stable recovery key for the escrow: a hash of the secret, so storage never contains it. */
export function paylinkIdentity(params: Pick<PaylinkParams, "paylinkType" | "secret">): string {
  return keccak256(
    toBytes(["paylink-withdrawal-v2", params.paylinkType, params.secret.toString()].join(":")),
  )
}

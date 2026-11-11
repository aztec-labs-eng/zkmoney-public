import type { PaylinkParams } from "@obsidion/sdk"
import { linkIdentity } from "../../../engine/paylinks"

/** Stable recovery key for the escrow: a hash of the secret, so storage never contains it. */
export function paylinkIdentity(params: Pick<PaylinkParams, "paylinkType" | "secret">): string {
  return linkIdentity(params.paylinkType, params.secret.toString())
}

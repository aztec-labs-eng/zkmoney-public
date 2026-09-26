import { paylinkIdentity } from "@obsidion/front-core"
import { decodePaylinkInline } from "@obsidion/sdk"

/**
 * A paylink without its bearer secret: the same hash the withdrawal records carry, so a durable
 * record can name a link it must never be able to spend.
 */
export function linkIdentity(fragment: string): string {
  return paylinkIdentity(decodePaylinkInline(fragment))
}

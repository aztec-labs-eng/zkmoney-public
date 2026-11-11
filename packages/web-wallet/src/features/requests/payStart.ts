/** Where the pay page opens: its sheet for `request`, in place of the request a link names. */
import type { RequestInlinePacket } from "@obsidion/front-core"
import type { BridgeInStart } from "../deposit/depositStart"

export interface PayStart {
  request: RequestInlinePacket
  bridge?: BridgeInStart
  /** The network and coin the flow starts on. */
  origin?: { chainId: number; symbol: string }
}

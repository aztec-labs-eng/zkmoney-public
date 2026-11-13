import { bestEffort, noteRefundedMoves } from "@obsidion/front-core"
import type { Address, Hash } from "viem"
import type { Session } from "../../../session/session"

/** Marks the retired moves an old version's refund returned. */
export interface RefundedMoves {
  note(
    deposits: readonly { leafIndex: string; amount: string }[],
    to: Address,
    txHash: Hash,
  ): Promise<void>
}

/** The marks only label rows: a refund that moved funds never fails on them. */
export const refundedMoves = (session: {
  moves: Session["moves"]
  page: Pick<Session["page"], "now">
}): RefundedMoves => ({
  note: async (deposits, to, txHash) =>
    void (await bestEffort(
      "unknown",
      noteRefundedMoves(session.moves, deposits, { to, txHash, at: session.page.now() }),
    )),
})

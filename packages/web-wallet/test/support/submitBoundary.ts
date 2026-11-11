import { ProvingStage } from "@obsidion/core/types"
import { testWalletDbs } from "./fakeWalletDb"
import { testSession } from "./operations"

export interface WalletSendOptions {
  operationId?: string
  onTxHash?: (txHash: string, tx: { expiresAtMs: number }) => Promise<void>
}

/**
 * `ObsidionWallet.sendTx` across its submit boundary: the caller's `onTxHash` is awaited, then
 * Mining is reported in the page prover's turn, then `node()` stands for `aztecNode.sendTx`. A rejected `onTxHash` sends
 * nothing.
 */
export async function sendLikeTheWallet(
  options: WalletSendOptions,
  txHash: string,
  node: () => void,
  /** A create's link, which the sdk hands over before it signs. */
  prepared?: unknown,
): Promise<void> {
  if (prepared !== undefined)
    await (options as { onPrepared?: (link: unknown) => Promise<void> }).onPrepared?.(prepared)
  await options.onTxHash?.(txHash, { expiresAtMs: Date.now() + 60_000 })
  await testSession().page.prover.turn(async ({ stage }) => {
    stage(ProvingStage.Mining, options.operationId ?? "", txHash)
    node()
  })
}

/** The writes the wallet database saved, and a switch to refuse some. */
export function watchWalletDb() {
  const saved: (readonly [string, string])[] = []
  const refused: (readonly [string, string])[] = []
  const matches = (
    [key, value]: readonly [string, string],
    [part, text]: readonly [string, string],
  ) => key.includes(part) && value.includes(text)
  testWalletDbs().onApply = (_version, ops) => {
    const writes = ops.flatMap(([key, value]) => (value === null ? [] : [[key, value] as const]))
    if (writes.some((write) => refused.some((rule) => matches(write, rule))))
      throw new Error("quota exceeded")
    saved.push(...writes)
  }
  return {
    /** Whether a saved write under a key containing `key` holds `text`. */
    holds: (key: string, text: string) => saved.some((write) => matches(write, [key, text])),
    /** Fail every later write under a key containing `key` that holds `text`. */
    refuse(key: string, text: string) {
      refused.push([key, text])
    },
  }
}

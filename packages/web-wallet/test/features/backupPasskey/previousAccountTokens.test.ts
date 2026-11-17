// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  tokensToMove,
  type PreviousHolding,
} from "../../../src/features/backupPasskey/previousAccountWatcher"

const MAIN = "0xmain"
const SKY = "0xsky"
const VAULT = "0xvault"
const TOKENS = [
  { kind: "main" as const, l2Token: MAIN },
  { kind: "savings" as const, l2Token: SKY },
  { kind: "savings" as const, l2Token: VAULT },
]
const held = (token: string, amount: bigint): PreviousHolding => ({
  kind: token === MAIN ? "main" : "savings",
  token,
  amount,
  dust: 10n,
})

describe("tokensToMove", () => {
  it("judges each vault's shares by their own balance, so none is left behind", () => {
    const tokens = (holdings: PreviousHolding[]) =>
      tokensToMove(TOKENS, holdings).map((token) => token.l2Token)
    // Sky emptied while the vault still holds shares: the vault's shares take a pass.
    expect(tokens([held(MAIN, 0n), held(SKY, 1n), held(VAULT, 500n)])).toEqual([VAULT])
    expect(tokens([held(MAIN, 50n), held(SKY, 500n), held(VAULT, 0n)])).toEqual([MAIN, SKY])
    // A token no check has read takes a pass.
    expect(tokens([held(MAIN, 0n), held("0xVAULT", 500n)])).toEqual([SKY, VAULT])
  })
})

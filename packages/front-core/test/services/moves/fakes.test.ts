// @vitest-environment node
import { describe } from "vitest"
import { openDatabase } from "../../../src/engine/database"
import { memoryBackend } from "../../../src/engine/memoryBackend"
import { executorRoutes } from "../../../src/core/services/moves/executorRoutes"
import { createWithdrawals } from "../../../src/engine/withdrawals"
import {
  DAI,
  DAI_PORTAL,
  FEED,
  fakeAccount,
  fakeEscrowRoutes,
  fakeL1,
  frontAccount,
  LIMITS,
  RECOVERY_KEYS,
  SKY_HOLDING,
  SUSDS_PORTAL,
  VAULT_HOLDING,
  VAULT_PORTAL,
} from "./fixtures"
import { moveRoutesContract, NONCE, sides } from "./moveRoutesContract"
import { movesAccountContract } from "./movesAccountContract"

const BURNED_AT_MS = 1_700_000_123_000

describe("fakeEscrowRoutes keeps the MoveRoutes contract", () => {
  moveRoutesContract({
    l1: () => fakeL1(),
    routes: fakeEscrowRoutes,
    holding: SKY_HOLDING,
    amount: 100n,
    token: { address: DAI, symbol: "DAI", decimals: 18 },
    limits: LIMITS,
    keys: RECOVERY_KEYS,
    escrowTip: (quote) => quote.escrowTip,
    recoveredToken: (route, direction) => sides(route, direction).source.token,
  })
})

describe("fakeAccount keeps the MovesAccount contract", () => {
  movesAccountContract({
    l1: () => fakeL1(),
    routes: fakeEscrowRoutes,
    account: (l1) => fakeAccount(l1, { [DAI_PORTAL]: 500n }, () => BURNED_AT_MS),
    holding: SKY_HOLDING,
    amount: 100n,
    claimable: async (l1, account) => {
      const secret = account.salts(NONCE, SKY_HOLDING.rail).recipient
      const made = await l1.deposit(SUSDS_PORTAL, l1.commitment(secret, account.address), 98n)
      return { ...made.deposit, secret }
    },
    burnedAt: async () => BURNED_AT_MS,
    unindex: async (l1, txHash) => {
      l1.unread.add(txHash)
      return async () => void l1.unread.delete(txHash)
    },
    withhold: async (l1, messageKey) => {
      l1.inTransit.add(messageKey)
      return async () => void l1.inTransit.delete(messageKey)
    },
    unprove: async (l1, txHash) => {
      l1.unproven.add(txHash)
      return async () => void l1.unproven.delete(txHash)
    },
  })
})

describe("frontAccount keeps the MovesAccount contract", () => {
  movesAccountContract({
    l1: () => fakeL1(),
    routes: fakeEscrowRoutes,
    account: (l1) => {
      const now = () => BURNED_AT_MS
      const withdrawals = createWithdrawals({ db: openDatabase(memoryBackend()), now })
      return frontAccount(fakeAccount(l1, { [DAI_PORTAL]: 500n }, now), withdrawals, now)
    },
    holding: SKY_HOLDING,
    amount: 100n,
    claimable: async (l1, account) => {
      const secret = account.salts(NONCE, SKY_HOLDING.rail).recipient
      const made = await l1.deposit(SUSDS_PORTAL, l1.commitment(secret, account.address), 98n)
      return { ...made.deposit, secret }
    },
    burnedAt: async () => BURNED_AT_MS,
    unindex: async (l1, txHash) => {
      l1.unread.add(txHash)
      return async () => void l1.unread.delete(txHash)
    },
    withhold: async (l1, messageKey) => {
      l1.inTransit.add(messageKey)
      return async () => void l1.inTransit.delete(messageKey)
    },
    unprove: async (l1, txHash) => {
      l1.unproven.add(txHash)
      return async () => void l1.unproven.delete(txHash)
    },
  })
})

describe("fakeAccount keeps the MovesAccount contract for a vault's moves", () => {
  const amount = 1_000n * 10n ** 18n
  movesAccountContract({
    l1: () => fakeL1(),
    routes: (l1) => executorRoutes({ l1: l1.client, eth: { feed: FEED } }),
    account: (l1) => fakeAccount(l1, { [DAI_PORTAL]: 2n * amount }, () => BURNED_AT_MS),
    holding: VAULT_HOLDING,
    amount,
    claimable: async (l1, account) => {
      const secret = account.salts(NONCE, VAULT_HOLDING.rail).recipient
      const made = await l1.deposit(VAULT_PORTAL, l1.commitment(secret, account.address), 98n)
      return { ...made.deposit, secret }
    },
    burnedAt: async () => BURNED_AT_MS,
    unindex: async (l1, txHash) => {
      l1.unread.add(txHash)
      return async () => void l1.unread.delete(txHash)
    },
    withhold: async (l1, messageKey) => {
      l1.inTransit.add(messageKey)
      return async () => void l1.inTransit.delete(messageKey)
    },
    unprove: async (l1, txHash) => {
      l1.unproven.add(txHash)
      return async () => void l1.unproven.delete(txHash)
    },
  })
})

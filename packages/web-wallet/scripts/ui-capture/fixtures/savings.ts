import { memoryStore } from "@obsidion/front-core"
import { DEMO_COMPLETE_ADDRESS } from "../../../src/dev/demoFixtures"
import * as actual from "../../../src/features/savings/savingsLine"
import { savingsFixture } from "./savings-seed"
export * from "../../../src/features/savings/savingsLine"

type Account = Parameters<typeof actual.savingsLine>[1]

// The demo builds no account service; the line reads only the account's complete address.
const account = memoryStore({
  status: "ready",
  value: { getCompleteAddress: () => DEMO_COMPLETE_ADDRESS },
}).readonly as unknown as Account

/** The session's Savings line under the demo account, whose shares the fixture seeds. */
export const savingsLine: typeof actual.savingsLine = (session, owner, balances) =>
  actual.savingsLine(session, savingsFixture() ? account : owner, balances)

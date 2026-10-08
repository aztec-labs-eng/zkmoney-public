import { describe, expect, it } from "vitest"

import {
  depositOwed,
  fundsIn,
  registrationStage,
  type PendingRegistrationRecord,
  type RegistrationStage,
  type RegistrationStageInputs,
} from "../../../src/index.js"
import {
  fundingBurn,
  pendingRegistration,
  sipaDeposit,
} from "../../__test-helpers__/registrationFixtures"

const OTHER_ADDRESS = `0x${"ee".repeat(20)}`

type Row = [string, Partial<PendingRegistrationRecord>, RegistrationStageInputs, RegistrationStage]

describe("registrationStage", () => {
  it.each<Row>([
    ["nothing seen", {}, {}, "reserved"],
    // The rail stamps any balance on a watched address; only `funded` says it covers the floor.
    ["a discovered deposit", {}, { deposit: sipaDeposit() }, "reserved"],
    ["a refunded deposit", {}, { deposit: sipaDeposit({ phase: "recovered" }) }, "reserved"],
    [
      "a deposit refunded after its funded stamp",
      { fundedAt: 1 },
      { deposit: sipaDeposit({ phase: "recovered" }) },
      "reserved",
    ],
    [
      "a deposit refunded after a landed burn",
      { fundedAt: 1 },
      { deposit: sipaDeposit({ phase: "recovered" }), burns: [fundingBurn({ phase: "done" })] },
      "reserved",
    ],
    ["a failed deposit", {}, { deposit: sipaDeposit({ phase: "failed" }) }, "reserved"],
    ["a failed burn", {}, { burns: [fundingBurn({ phase: "failed" })] }, "reserved"],
    ["a reclaimed burn", {}, { burns: [fundingBurn({ phase: "recovered" })] }, "reserved"],
    [
      "a burn to another address",
      {},
      { burns: [fundingBurn({ phase: "done", recipient: OTHER_ADDRESS })] },
      "reserved",
    ],
    ["a burn on its way", {}, { burns: [fundingBurn()] }, "funding"],
    ["the record's funded stamp", { fundedAt: 1 }, { deposit: sipaDeposit() }, "received"],
    ["a funded rail", {}, { deposit: sipaDeposit({ phase: "funded" }) }, "received"],
    [
      "funds seen past a landed burn",
      { fundedAt: 1 },
      { burns: [fundingBurn({ phase: "done" })] },
      "received",
    ],
    [
      "a sweeping rail",
      { fundedAt: 1 },
      { deposit: sipaDeposit({ phase: "sweeping" }) },
      "sweeping",
    ],
    [
      "a stamped sweep",
      { fundedAt: 1, sweptAt: 2 },
      { deposit: sipaDeposit({ phase: "sweeping" }) },
      "claiming",
    ],
    ["a sweep stamped before any funded stamp", { sweptAt: 2 }, {}, "claiming"],
    ["a sweep tx with no stamp", { sweepTxHash: `0x${"5e".repeat(32)}` }, {}, "claiming"],
    [
      "a rail awaiting its claim",
      { sweptAt: 2 },
      { deposit: sipaDeposit({ phase: "pendingClaim" }) },
      "crediting",
    ],
    ["a claimed rail", {}, { deposit: sipaDeposit({ phase: "claimed" }) }, "crediting"],
    ["a confirmed record", { phase: "confirmed" }, {}, "registered"],
    ["a lost race", { phase: "failed_taken" }, {}, "failed"],
    ["an abandoned record", { phase: "failed_terminal" }, {}, "failed"],
  ])("reads %s as the furthest stage shown", (_, over, inputs, expected) => {
    expect(registrationStage(pendingRegistration(over), inputs)).toBe(expected)
  })
})

describe("the two questions every surface asks", () => {
  it.each<[RegistrationStage, boolean, boolean]>([
    ["reserved", true, false],
    ["funding", false, false],
    ["received", false, true],
    ["sweeping", false, true],
    ["claiming", false, true],
    ["crediting", false, true],
    ["registered", false, false],
    ["failed", false, false],
  ])("%s: deposit owed %s, funds in %s", (stage, owed, inFlight) => {
    expect(depositOwed(stage)).toBe(owed)
    expect(fundsIn(stage)).toBe(inFlight)
  })
})

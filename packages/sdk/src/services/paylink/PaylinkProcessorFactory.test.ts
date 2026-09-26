import { describe, it, expect } from "vitest"
import { PaylinkProcessorFactory } from "./PaylinkProcessorFactory.js"
import type { ContractName } from "@obsidion/core/types"

// pnpm test src/services/paylink/PaylinkProcessorFactory.test.ts

describe("PaylinkProcessorFactory", () => {
  it("supports exactly the direct and email flavors", () => {
    expect(PaylinkProcessorFactory.getSupportedTypes().sort()).toEqual([
      "paylinkDirect",
      "paylinkEmail",
    ])
  })

  it("throws for a paylink type it does not route", () => {
    for (const type of ["paylinkTwitter", "paylinkZKPName"]) {
      expect(() => PaylinkProcessorFactory.create(type as ContractName)).toThrow(
        `Unsupported paylink type: ${type}`,
      )
    }
  })
})

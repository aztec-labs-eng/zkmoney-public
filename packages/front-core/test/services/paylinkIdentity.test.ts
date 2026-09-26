import { describe, expect, it } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { paylinkIdentity } from "../../src/core/services/paylink/paylinkIdentity"

const params = {
  paylinkType: "paylinkEmail",
  secret: new Fr(1),
}
describe("paylink recovery identity", () => {
  it("distinguishes escrows and flavors without exposing the secret", () => {
    const id = paylinkIdentity(params)
    expect(id).not.toBe(paylinkIdentity({ ...params, secret: new Fr(2) }))
    expect(id).not.toBe(paylinkIdentity({ ...params, paylinkType: "paylinkDirect" }))
    expect(id).not.toContain(params.secret.toString())
  })
  it("ignores everything else the link carries when it is reopened", () => {
    expect(paylinkIdentity({ ...params, chainId: 1, classId: Fr.random() } as typeof params)).toBe(
      paylinkIdentity(params),
    )
  })
})

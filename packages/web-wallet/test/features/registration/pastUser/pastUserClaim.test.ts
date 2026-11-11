import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AccountServiceError, deriveBootstrapKey } from "@obsidion/front-core"
import {
  claimPastUser,
  PastUserAlreadyUsedError,
} from "../../../../src/features/registration/pastUserClaim"

const SECRET = new Fr(7n)
const OWNER = deriveBootstrapKey(SECRET).address.toLowerCase()

describe("claimPastUser", () => {
  const proved = { proof: "0xaa" as Hex, publicInputs: ["0x1", "0x2", "0x3", "0x4"] }
  const prove = vi.fn()
  const claim = vi.fn()
  const deps = () => ({
    keys: { secretKey: SECRET },
    accountService: { claimPastUser: claim },
    prove,
  })
  beforeEach(() => {
    prove.mockReset().mockResolvedValue(proved)
    claim.mockReset().mockResolvedValue({ status: "created" })
  })

  it("proves for this account's bootstrap key and submits only the proof", async () => {
    await claimPastUser("0x5151", deps())
    expect(prove).toHaveBeenCalledWith({ signature: "0x5151", owner: OWNER })
    expect(claim).toHaveBeenCalledWith(proved)
  })

  it("reports a nullifier that was already spent", async () => {
    claim.mockRejectedValue(new AccountServiceError(409, "past_user_claimed"))
    await expect(claimPastUser("0x5151", deps())).rejects.toBeInstanceOf(PastUserAlreadyUsedError)
  })
})

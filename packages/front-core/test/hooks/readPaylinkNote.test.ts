import { describe, expect, it } from "vitest"
import { WalletError } from "@obsidion/core/errors"
import { PAYLINK_TERMS_REFUSAL, type PaylinkService } from "@obsidion/sdk"
import { readPaylinkNote } from "../../src/hooks/readPaylinkNote"

const service = (error: Error) =>
  ({
    sync_note: async () => {
      throw error
    },
  } as unknown as PaylinkService)

describe("readPaylinkNote", () => {
  it("refuses a note the link was not made for with its code", async () => {
    const read = readPaylinkNote(service(new Error(PAYLINK_TERMS_REFUSAL)), {} as never)
    await expect(read).rejects.toBeInstanceOf(WalletError)
    await expect(read).rejects.toMatchObject({
      code: "paylink.termsMismatch",
      message: PAYLINK_TERMS_REFUSAL,
    })
  })

  it("reads any other failure as no note", async () => {
    expect(await readPaylinkNote(service(new Error("node down")), {} as never)).toBeUndefined()
  })
})

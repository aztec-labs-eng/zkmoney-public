import { describe, expect, it } from "vitest"
import {
  shortenAddress,
  shortenAddressSm,
  shortenTxHash,
  addContactSchema,
  validateAddress,
  validateAmount,
  validateEthereumAddress,
  isZeroAddress,
  completeAddressWireFormat,
} from "../../src/utils"

const VALID_ADDRESS = "0x2b9d7dc8dea863ae525610940367c386cdbad3e4c693802e0d9cb5c0509e5380"
const INVALID_ADDRESS = "0x123"

describe("utilsUnitTests", () => {
  describe("validateAddress", () => {
    it("should validate address", () => {
      expect(validateAddress(VALID_ADDRESS)).toBe(true)
    })

    it("should NOT validate invalid address", () => {
      expect(validateAddress(INVALID_ADDRESS)).toBe(false)
    })
  })

  describe("isZeroAddress", () => {
    it("matches the 64-hex Aztec-native zero address", () => {
      expect(isZeroAddress("0x" + "0".repeat(64))).toBe(true)
    })

    it("matches the 40-hex Ethereum-style zero address", () => {
      expect(isZeroAddress("0x" + "0".repeat(40))).toBe(true)
    })

    it("matches without the 0x prefix and is case-insensitive on it", () => {
      expect(isZeroAddress("0".repeat(64))).toBe(true)
      expect(isZeroAddress("0X" + "0".repeat(40))).toBe(true)
    })

    it("does not match a non-zero address", () => {
      expect(isZeroAddress(VALID_ADDRESS)).toBe(false)
    })

    it("does not match a wrong-length all-zeros string", () => {
      expect(isZeroAddress("0x" + "0".repeat(10))).toBe(false)
    })

    it("does not match undefined / null / empty", () => {
      expect(isZeroAddress(undefined)).toBe(false)
      expect(isZeroAddress(null)).toBe(false)
      expect(isZeroAddress("")).toBe(false)
    })
  })

  describe("validateAmount", () => {
    it("should validate amount", () => {
      expect(validateAmount("100")).toBe(true)
    })

    it("should NOT validate 0 amount", () => {
      expect(validateAmount("0")).toBe(false)
    })

    it("should NOT validate negative amount", () => {
      expect(validateAmount("-100")).toBe(false)
    })

    it("should NOT validate non-numeric amount", () => {
      expect(validateAmount("not-a-number")).toBe(false)
    })
  })

  describe("addContactSchema", () => {
    it("validates legacy contacts as Aztec L2 addresses", () => {
      expect(addContactSchema.parse({ name: "Alice", address: VALID_ADDRESS }).addressKind).toBe(
        undefined,
      )
    })

    it("validates Ethereum L1 contacts with wallet metadata", () => {
      const parsed = addContactSchema.parse({
        name: "Rainbow",
        address: "0xAbCdEf0123456789aBcDeF0123456789aBcDeF01",
        addressKind: "ethereum-l1",
        l1Wallet: {
          provider: "rainbow",
          provenance: "deposit-attested",
        },
      })

      expect(parsed.addressKind).toBe("ethereum-l1")
      expect(validateEthereumAddress(parsed.address)).toBe(true)
    })

    it("rejects L1 contacts without wallet metadata", () => {
      expect(() =>
        addContactSchema.parse({
          name: "Rainbow",
          address: "0xAbCdEf0123456789aBcDeF0123456789aBcDeF01",
          addressKind: "ethereum-l1",
        }),
      ).toThrow(/L1 wallet metadata is required/)
    })
  })

  describe("shortenAddress", () => {
    it("should shorten address", () => {
      expect(shortenAddress(VALID_ADDRESS)).toBe("0x2b9d7dc8...c0509e5380")
    })
  })
  describe("shortenAddressSm", () => {
    it("should shorten address", () => {
      expect(shortenAddressSm(VALID_ADDRESS)).toBe("0x2b9d...5380")
    })
  })

  describe("shortenTxHash", () => {
    it("should shorten tx hash", () => {
      expect(shortenTxHash(VALID_ADDRESS)).toBe("0x2b9d7dc8...c0509e5380")
    })
  })

  describe("completeAddressWireFormat", () => {
    it("detects v5 (288-byte) and v4 (320-byte) blobs", () => {
      expect(completeAddressWireFormat("0x" + "ab".repeat(288))).toBe("v5")
      expect(completeAddressWireFormat("0x" + "ab".repeat(320))).toBe("v4")
      expect(completeAddressWireFormat("ab".repeat(288))).toBe("v5")
    })

    it("returns unknown for odd length or other sizes", () => {
      expect(completeAddressWireFormat("0xabc")).toBe("unknown")
      expect(completeAddressWireFormat("0x" + "ab".repeat(64))).toBe("unknown")
    })
  })
})

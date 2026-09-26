import { z } from "zod"
import { AztecAddress } from "@aztec/stdlib/aztec-address"

const ETHEREUM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

export const validateAddress = (address: string): boolean => {
  try {
    AztecAddress.fromStringUnsafe(address)
    return true
  } catch {
    return false
  }
}

const ALL_ZEROS_REGEX = /^0+$/

/**
 * True when `value` is an all-zeros address (both Aztec and Ethereum)
 * Case-insensitive on the `0x` prefix; the prefix is optional
 */
export const isZeroAddress = (value: string | undefined | null): boolean => {
  if (!value) return false
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value
  return (hex.length === 40 || hex.length === 64) && ALL_ZEROS_REGEX.test(hex)
}

export const validateEthereumAddress = (address: string): boolean => {
  return ETHEREUM_ADDRESS_REGEX.test(address)
}

/** Amounts are dollars: cents are the finest unit a user may type. */
export const AMOUNT_MAX_DECIMALS = 2

/**
 * Plain non-negative decimal (`12`, `1.5`, `.5`) — the only shape viem's `parseUnits` accepts from
 * typed text. `Number()` alone lets `1e3`, `0x10` and `Infinity` through and viem throws on them.
 */
export const isDecimalAmount = (text: string): boolean => /^(\d+\.?\d*|\.\d+)$/.test(text)

export const decimalPlaces = (text: string): number => text.split(".")[1]?.length ?? 0

export const validateAmount = (amount: string): boolean =>
  isDecimalAmount(amount) && decimalPlaces(amount) <= AMOUNT_MAX_DECIMALS && Number(amount) > 0

// Zod schema for validating addContact inputs
export const addContactSchema = z
  .object({
    name: z.string().min(1, "Name cannot be empty"),
    address: z.string(),
    addressKind: z.enum(["aztec-l2", "ethereum-l1", "pending-handshake"]).optional(),
    email: z.string().email("Invalid email format").optional(),
    verified: z.boolean().optional(),
    tag: z.string().optional(),
    // Root-level L2 provenance (distinct from l1Wallet.provenance). Parity with
    // ContactStorage.ContactProvenance; the QR-handshake write path uses
    // addOrMergeContact directly, but keep the schema in sync.
    provenance: z.enum(["qr-scan"]).optional(),
    avatar: z
      .object({
        type: z.enum(["image", "gradient", "initials"]),
        url: z.string().optional(),
        colorHex: z.tuple([z.string(), z.string()]).optional(),
      })
      .optional(),
    l1Wallet: z
      .object({
        provider: z.string().min(1),
        walletId: z.string().optional(),
        walletName: z.string().optional(),
        imageUrl: z.string().optional(),
        provenance: z.enum(["deposit-attested", "saved-recipient"]),
        lastUsedAt: z.number().optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    const addressKind = data.addressKind ?? "aztec-l2"

    if (addressKind === "ethereum-l1") {
      if (!validateEthereumAddress(data.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["address"],
          message: "Invalid Ethereum Address",
        })
      }
      if (!data.l1Wallet) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["l1Wallet"],
          message: "L1 wallet metadata is required",
        })
      }
      return
    }

    if (addressKind === "pending-handshake") {
      if (!validateEthereumAddress(data.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["address"],
          message: "Invalid pending handshake address",
        })
      }
      if (data.provenance !== "qr-scan") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["provenance"],
          message: "Pending handshakes must come from QR scan provenance",
        })
      }
      return
    }

    if (!validateAddress(data.address)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: "Invalid Aztec Address",
      })
    }
  })

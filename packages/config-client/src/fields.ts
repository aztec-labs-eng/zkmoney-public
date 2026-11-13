import { z } from "zod"

export const nonEmpty = z.string().min(1)
export const l1Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 20-byte 0x-hex L1 address")
export const fullGitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "expected full 40-char lowercase git sha")
export const isoInstant = z.iso.datetime({ offset: true })
export const httpUrl = z.url({ protocol: /^https?$/ })
export const profileId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "profileId: lowercase alphanumeric + dashes, max 64 chars")
export const assetSymbol = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,15}$/, "asset: a token symbol")

import { AztecAddress } from "@aztec/stdlib/aztec-address"

export async function compAddrToAztecAddr(compAddr: string) {
  // The address is the first 32-byte field of the serialized CompleteAddress in
  // every generation. CompleteAddress.fromString() instead RE-DERIVES the address
  // from the keys (validate() → grumpkin mul/add/sqrt) with the CURRENT stack's
  // derivation — wasted work, and on a v4-generation account the v5 math rejects
  // the v4-format keys ("Input point_b must be on the curve").
  return AztecAddress.fromStringUnsafe(compAddr.slice(0, 66))
}

export async function compAddrToAztecAddrStr(compAddr: string) {
  return (await compAddrToAztecAddr(compAddr)).toString()
}

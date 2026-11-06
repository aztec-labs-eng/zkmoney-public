import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"

export async function compAddrToAztecAddr(compAddr: string) {
  // The address is the first 32-byte field of the serialized CompleteAddress.
  // CompleteAddress.fromString() instead RE-DERIVES the address from the keys
  // (validate() → grumpkin mul/add/sqrt), which is wasted work.
  return AztecAddress.fromStringUnsafe(compAddr.slice(0, 66))
}

export async function compAddrToAztecAddrStr(compAddr: string) {
  return (await compAddrToAztecAddr(compAddr)).toString()
}

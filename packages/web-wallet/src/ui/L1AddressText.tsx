import { blo } from "blo"
import type { Address } from "viem"
import { l1AddressParts } from "./format"

/** The address's blockie, drawn as MetaMask draws it. */
export function Blockie({ address, size = 16 }: { address: string; size?: number }) {
  return (
    <img className="ww-blockie" src={blo(address as Address)} alt="" width={size} height={size} />
  )
}

/** An L1 address, MetaMask's first 7 and last 5 characters in bold; `cut` drops the middle. */
export function L1AddressText({ address, cut }: { address: string; cut?: boolean }) {
  const { head, middle, tail } = l1AddressParts(address)
  return (
    <span className="ww-l1-addr">
      <strong>{head}</strong>
      {middle && (cut ? "…" : middle)}
      <strong>{tail}</strong>
    </span>
  )
}

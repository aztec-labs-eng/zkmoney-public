import { useEnsName } from "@obsidion/front-core"
import { ensClient } from "../lib/ens"
import { shortL1Addr } from "./format"
import { Blockie } from "./L1AddressText"

/** An L1 address: its blockie, then its ENS primary name on the active L1 or `0xAbCdE…12345`. */
export function L1AddressLabel({ address }: { address: string }) {
  const name = useEnsName(address, ensClient)
  return (
    <>
      <Blockie address={address} />
      {name ? (
        <span className="ww-ens-name" title={`${name}\n${address}`}>
          {name}
        </span>
      ) : (
        shortL1Addr(address)
      )}
    </>
  )
}

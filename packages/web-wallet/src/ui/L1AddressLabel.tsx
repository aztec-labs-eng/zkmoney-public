import { useEnsName } from "@obsidion/front-core"
import { useSession } from "../session/session"
import { shortL1Addr } from "./format"
import { Blockie } from "./L1AddressText"

/**
 * An L1 address: its blockie, then its ENS primary name on the active L1 or `0xAbCdE…12345`.
 * With a `name` or `href` it is a party: the name, then the address, linked to `href`, which wraps
 * under the name when both do not fit on one line.
 */
export function L1AddressLabel({
  address,
  name,
  href,
}: {
  address: string
  name?: string
  href?: string
}) {
  const ens = useEnsName(address, useSession().page.chain.ensName)
  const label = (
    <>
      <Blockie address={address} />
      {ens ? (
        <span className="ww-ens-name" title={`${ens}\n${address}`}>
          {ens}
        </span>
      ) : (
        shortL1Addr(address)
      )}
    </>
  )
  if (!name && !href) return label
  return (
    <span className="ww-party">
      {name && (
        <span className="ww-party__name" title={name}>
          {name}
        </span>
      )}
      {href ? (
        <a className="ww-party__addr" href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : (
        <span className="ww-party__addr">{label}</span>
      )}
    </span>
  )
}

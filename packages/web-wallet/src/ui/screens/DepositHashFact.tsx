import { Icon } from "@obsidion/web-ds"
import { isAddress } from "viem"
import { shortAddr } from "../format"
import { L1AddressLabel } from "../L1AddressLabel"
import { DepositFact } from "./DepositFact"

export function DepositHashFact({
  label,
  hash,
  url,
}: {
  label: string
  hash: string
  url?: string
}) {
  const text = isAddress(hash, { strict: false }) ? (
    <L1AddressLabel address={hash} />
  ) : (
    shortAddr(hash)
  )
  return (
    <DepositFact label={label}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {text} <Icon name="share-box" size={16} />
        </a>
      ) : (
        <b>{text}</b>
      )}
    </DepositFact>
  )
}

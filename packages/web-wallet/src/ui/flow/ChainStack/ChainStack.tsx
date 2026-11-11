import { fmt } from "../../../lib/fmt"
import { ChainIcon } from "../../ChainIcon/ChainIcon"
import { IconStack } from "../../IconStack/IconStack"
import copy from "./ChainStack.copy"

/**
 * A route's chains as overlapping icons: at most `max`, then how many more. With none left over,
 * `label` follows instead.
 */
export function ChainStack({
  chains,
  size,
  max = 5,
  label,
}: {
  chains: readonly { chainId: number; name: string }[]
  /** The logo's size; its disc is 6px wider at 26, 3px at 13. */
  size: number
  max?: number
  label?: string
}) {
  const more = chains.length - max
  return (
    <>
      <IconStack front small={size < 20}>
        {chains.slice(0, max).map((chain) => (
          <ChainIcon key={chain.chainId} chainId={chain.chainId} name={chain.name} size={size} />
        ))}
      </IconStack>
      {more > 0 ? fmt(more === 1 ? copy.moreNetwork : copy.moreNetworks, { count: more }) : label}
    </>
  )
}

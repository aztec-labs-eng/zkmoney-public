export function shortenAddress(address: string) {
  return address.substring(0, 10) + "..." + address.substring(address.length - 10)
}

export function shortenAddressSm(address: string) {
  return address.substring(0, 6) + "..." + address.substring(address.length - 4)
}

export function shortenTxHash(address: string) {
  return address.substring(0, 10) + "..." + address.substring(address.length - 10)
}

/** Ellipsize the middle of a string, keeping `maxLength` visible characters overall. */
export const truncateMiddle = (str: string, maxLength = 20) => {
  if (str.length <= maxLength) return str
  const charsToShow = maxLength - 3
  return `${str.slice(0, Math.ceil(charsToShow / 2))}...${str.slice(-Math.floor(charsToShow / 2))}`
}

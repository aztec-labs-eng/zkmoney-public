import copy from "./tokenName.copy"

const NAMES: Readonly<Record<string, string>> = copy

/** A token's full name, or its symbol where the wallet has none. */
export const tokenName = (symbol: string): string => NAMES[symbol] ?? symbol

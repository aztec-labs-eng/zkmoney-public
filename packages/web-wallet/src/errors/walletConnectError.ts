const SWITCH_CHAIN_FRAME = /^\s*(?:at )?(?:[\w$]+\.)*switchEthereumChain[\s@(]/m
const UNDEFINED_REQUEST =
  /undefined \(reading 'request'\)|can't access property "request", .+ is undefined|^undefined is not an object \(evaluating '.+\.request'\)/

export function isWalletConnectChainSwitchError(reason: unknown): boolean {
  return (
    reason instanceof TypeError &&
    UNDEFINED_REQUEST.test(reason.message) &&
    SWITCH_CHAIN_FRAME.test(reason.stack ?? "")
  )
}

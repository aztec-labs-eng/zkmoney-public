import { describe, expect, it, vi, beforeEach } from "vitest"
import { quotedDepositFee } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { RegistryTagResolution, RequestInlinePacket } from "@obsidion/front-core"
import type { PublicClient } from "viem"
import {
  RequestDecimalsMismatchError,
  resolveAccountlessRequest,
} from "../src/features/requests/accountlessRequest"
import {
  buildErc20TransferUri,
  buildErc20TransferUriWithoutAmount,
} from "../src/features/requests/eip681"

const SIPA = `0x${"aa".repeat(20)}`
const CCIP_SIPA = `0x${"bb".repeat(20)}`
const L2 = `0x${"cc".repeat(32)}`
const TOKEN = `0x${"22".repeat(20)}`
const IMPLEMENTATION = `0x${"77".repeat(20)}`
const PORTAL = `0x${"88".repeat(20)}`
const RELAYER_FEE = 250_000n
const FPC_FUNDING_CUT = 250_000_000_000_000_000n
// The payer must cover the whole quoted fee: the sweep fee AND the portal's funding cut.
const FEE = quotedDepositFee(RELAYER_FEE, FPC_FUNDING_CUT)

const resolveSipaAddressMock = vi.fn(async (..._args: unknown[]) => CCIP_SIPA)
const readDepositFeeMock = vi.fn(async (..._args: unknown[]) => RELAYER_FEE)
const readFpcFundingCutMock = vi.fn(async (..._args: unknown[]) => FPC_FUNDING_CUT)

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  resolveSipaAddress: (...args: unknown[]) => resolveSipaAddressMock(...args),
  readDepositFee: (...args: unknown[]) => readDepositFeeMock(...args),
  readFpcFundingCut: (...args: unknown[]) => readFpcFundingCutMock(...args),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  depositSipaImplementation: async () => IMPLEMENTATION,
}))

const tuple = {
  token: TOKEN,
  l2Token: `0x${"33".repeat(32)}`,
  registry: `0x${"44".repeat(20)}`,
  sipaResolver: `0x${"66".repeat(20)}`,
  ensDomain: "sandbox.oxide",
  sipaFactory: `0x${"55".repeat(20)}`,
  portal: PORTAL,
  rollupVersion: "4127419662",
} as OxideEnvTuple

const resolved: RegistryTagResolution = {
  status: "resolved",
  account: "0x00000000000000000000000000000000000000aa",
  l2Address: L2,
  rollupId: "1",
  sipaStealthPublicKey: { x: 1n, y: 2n },
  xmtpAddress: "0x00000000000000000000000000000000000000b0",
}

function packet(over: Partial<RequestInlinePacket> = {}): RequestInlinePacket {
  return {
    requestId: `0x${"0a".repeat(32)}`,
    requesterTag: "alice",
    requesterAddress: L2,
    amountAtomic: 1_000_000n,
    networkId: "0xrollup",
    tokenAddress: `0x${"1b".repeat(32)}`,
    tokenDecimals: 6,
    tokenSymbol: "DAI",
    ...over,
  }
}

function deps(resolveRequester: () => Promise<RegistryTagResolution> = async () => resolved) {
  return {
    tuple,
    // The token contract reports the decimals the packets below declare.
    publicClient: { readContract: async () => 6 } as unknown as PublicClient,
    resolveRequester,
    chainId: 11155111,
  }
}

describe("resolveAccountlessRequest", () => {
  beforeEach(() => {
    resolveSipaAddressMock.mockClear()
    readDepositFeeMock.mockClear()
  })
  it("uses the embedded SIPA and never CCIP-resolves", async () => {
    const result = await resolveAccountlessRequest(packet({ sipaAddress: SIPA }), deps())
    expect(resolveSipaAddressMock).not.toHaveBeenCalled()
    expect(result.sipaAddress).toBe(SIPA)
    expect(result.grossAtomic).toBe(1_000_000n + FEE)
    // Exact shape: a wallet needs the token, the chain and the amount, not just the address.
    expect(result.paymentUri).toBe(
      `ethereum:${TOKEN}@11155111/transfer?address=${SIPA}&uint256=${1_000_000n + FEE}`,
    )
    expect(result.tagWarning).toBeUndefined()
  })

  it("returns the token and the decimals its contract reports", async () => {
    const result = await resolveAccountlessRequest(packet({ sipaAddress: SIPA }), deps())
    expect(result.token).toBe(TOKEN)
    expect(result.decimals).toBe(6)
  })

  it("refuses a link that declares other decimals than the token has", async () => {
    await expect(
      resolveAccountlessRequest(packet({ sipaAddress: SIPA, tokenDecimals: 18 }), deps()),
    ).rejects.toBeInstanceOf(RequestDecimalsMismatchError)
    expect(resolveSipaAddressMock).not.toHaveBeenCalled()
  })

  it("reads a link without decimals as 6, as the codec defines", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA, tokenDecimals: undefined }),
      deps(),
    )
    expect(result.decimals).toBe(6)
  })

  it("refuses a link without decimals when the token does not have 6", async () => {
    const client = { readContract: async () => 18 } as unknown as PublicClient
    await expect(
      resolveAccountlessRequest(packet({ sipaAddress: SIPA, tokenDecimals: undefined }), {
        ...deps(),
        publicClient: client,
      }),
    ).rejects.toBeInstanceOf(RequestDecimalsMismatchError)
  })

  it("omits uint256 for an any-amount request", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA, amountAtomic: 0n }),
      deps(),
    )
    expect(result.grossAtomic).toBe(0n)
    expect(result.paymentUri).toBe(`ethereum:${TOKEN}@11155111/transfer?address=${SIPA}`)
  })

  it("keeps the QR when the @tag no longer matches — the SIPA is the payee", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA }),
      deps(async () => ({ status: "notFound" })),
    )
    expect(result.sipaAddress).toBe(SIPA)
    expect(result.tagWarning).toMatch(/no longer registered/)
  })

  it("warns when the @tag resolves to a different account than the link pinned", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA }),
      deps(async () => ({ ...resolved, l2Address: `0x${"dd".repeat(32)}` })),
    )
    expect(result.sipaAddress).toBe(SIPA)
    expect(result.tagWarning).toMatch(/no longer matches/)
  })

  it("times out a CCIP resolve that never settles", async () => {
    resolveSipaAddressMock.mockImplementationOnce(() => new Promise(() => {}))
    await expect(resolveAccountlessRequest(packet(), { ...deps(), timeoutMs: 10 })).rejects.toThrow(
      /timed out/,
    )
  })

  it("CCIP-resolves a legacy packet without a SIPA", async () => {
    const result = await resolveAccountlessRequest(packet(), deps())
    expect(resolveSipaAddressMock).toHaveBeenCalledOnce()
    expect(result.sipaAddress).toBe(CCIP_SIPA)
    expect(result.tagWarning).toBeUndefined()
  })

  it("fails closed on a legacy packet whose @tag is gone", async () => {
    await expect(
      resolveAccountlessRequest(
        packet(),
        deps(async () => ({ status: "notFound" })),
      ),
    ).rejects.toThrow(/no longer registered/)
    expect(resolveSipaAddressMock).not.toHaveBeenCalled()
  })
})

describe("eip681", () => {
  it("formats transfer URIs", () => {
    expect(
      buildErc20TransferUri({
        token: TOKEN as never,
        chainId: 1,
        to: SIPA as never,
        rawAmount: 42n,
      }),
    ).toBe(`ethereum:${TOKEN}@1/transfer?address=${SIPA}&uint256=42`)
    expect(
      buildErc20TransferUriWithoutAmount({ token: TOKEN as never, chainId: 1, to: SIPA as never }),
    ).toBe(`ethereum:${TOKEN}@1/transfer?address=${SIPA}`)
  })
})

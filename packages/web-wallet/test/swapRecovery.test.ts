/**
 * The web side of the swap escrow exits: who is offered them and on what grounds, and how each is
 * wired — the channel it signs over, the address it pays, and for a recovery the account, salt and
 * passkey it opens the escrow's commitment with. The calls and the store write belong to
 * front-core's `runSwapEscrowExecute` / `runSwapEscrowRecovery`; the recovery runs for real only
 * where the wiring must open a real commitment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import type { WithdrawalRecord } from "@obsidion/front-core"

const RECIPIENT = `0x${"dd".repeat(20)}` as Address
const TYPED = `0x${"55".repeat(20)}` as Address
const WALLET = `0x${"44".repeat(20)}` as Address
const TOKEN = `0x${"22".repeat(20)}` as Address
const ACCOUNT = `0x${"ac".repeat(20)}` as Address
const OTHER_ACCOUNT = `0x${"bc".repeat(20)}` as Address
const FACTORY = `0x${"fa".repeat(20)}` as Address
const HASH = `0x${"ab".repeat(32)}` as Hex
const L2_TX = `0x${"0a".repeat(32)}` as Hex
const NONCE = `0x${"77".repeat(32)}` as Hex
const RELAYER_TIP = 5n * 10n ** 18n
const SECRET = { toString: () => `0x${"11".repeat(32)}` }
const PASSKEY_KEY = { qx: `0x${"01".repeat(32)}` as Hex, qy: `0x${"02".repeat(32)}` as Hex }
const AUTH = {
  r: `0x${"03".repeat(32)}` as Hex,
  s: `0x${"04".repeat(32)}` as Hex,
  challengeIndex: 1n,
  typeIndex: 2n,
  authenticatorData: "0x" as Hex,
  clientDataJSON: "{}",
}

const h = vi.hoisted(() => ({
  runSwapEscrowExecute: vi.fn(),
  runSwapEscrowRecovery: vi.fn(),
  injectedWalletChannel: vi.fn(),
  desktopBridgeChannel: vi.fn(),
  ownSwapRecoverer: vi.fn(),
  oxideAccountPasskey: vi.fn(),
  provider: { kind: "webauthn" },
  getCode: vi.fn(),
  readAuthKeys: vi.fn(),
  sign: vi.fn(),
  sendTransaction: vi.fn(),
  store: { patch: vi.fn() },
  bridgeActive: { current: false },
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  runSwapEscrowExecute: h.runSwapEscrowExecute,
  runSwapEscrowRecovery: h.runSwapEscrowRecovery,
  createOxideL1Reader: () => ({ getCode: h.getCode, readAuthKeys: h.readAuthKeys }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  L1SwapEscrowReader: class {
    constructor(public client: unknown, public config: unknown) {}
    async daiBalance() {
      return RELAYER_TIP
    }
    async isDeployed() {
      return true
    }
  },
}))
vi.mock("../src/features/deposit/sipaRecovery", () => ({
  injectedWalletChannel: h.injectedWalletChannel,
  desktopBridgeChannel: h.desktopBridgeChannel,
}))
vi.mock("../src/platform/desktopBridge", () => ({
  isDesktopL1SubmitActive: () => h.bridgeActive.current,
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getAuthProvider: async () => h.provider }),
}))
vi.mock("../src/platform/auth/oxideAccountPasskey", () => ({
  oxideAccountPasskey: h.oxideAccountPasskey,
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ token: TOKEN }),
  l1PublicClient: () => ({ kind: "public-client" }),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => h.store,
  ownSwapRecoverer: h.ownSwapRecoverer,
}))

const { executeSwapWithdrawal, recoverSwapWithdrawal, swapExitReasonFor } = await import(
  "../src/features/withdraw/swapRecovery"
)
const { SWAP_STUCK_THRESHOLD_MS, deriveSwapEscrowRecoverySalt } = await import(
  "@obsidion/front-core"
)
const { runSwapEscrowRecovery: runRecoveryForReal } = await vi.importActual<
  typeof import("@obsidion/front-core")
>("@obsidion/front-core")
const { planSwapOnWithdraw } = await import("@obsidion/sdk")

/** The escrow a burn by `account`, salted from `secret`, commits to. */
const planFor = (account: Address, secret = SECRET) =>
  planSwapOnWithdraw({
    swapEscrowFactory: FACTORY,
    output: "USDC",
    l1Recipient: RECIPIENT,
    recovery: { account, salt: deriveSwapEscrowRecoverySalt(secret, NONCE) },
    amount: 210n * 10n ** 18n,
    withdrawalRelayerTip: 0n,
    proverTip: 0n,
    fpcFundingCut: 0n,
    relayerTip: RELAYER_TIP,
    nonce: NONCE,
  })
const PLAN = planFor(ACCOUNT)

const NOW = 1_700_000_000_000

const record = (patch: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  localId: "wdraw_1",
  recipient: RECIPIENT,
  recipientProvenance: "saved-recipient",
  amount: "210",
  tokenSymbol: "DAI",
  phase: "swapping",
  startTime: NOW - SWAP_STUCK_THRESHOLD_MS,
  phaseEnteredAt: NOW - SWAP_STUCK_THRESHOLD_MS,
  l2TxHash: L2_TX,
  swapOutput: "USDC",
  swapEscrow: PLAN.escrow,
  swapEscrowFactory: FACTORY,
  swapNonce: NONCE,
  swapRecoveryCommitment: PLAN.escrowArgs.recoveryCommitment,
  swapRelayerTip: RELAYER_TIP.toString(),
  ...patch,
})

beforeEach(() => {
  h.runSwapEscrowExecute.mockReset().mockResolvedValue(HASH)
  h.runSwapEscrowRecovery.mockReset().mockResolvedValue(HASH)
  h.injectedWalletChannel.mockReset().mockResolvedValue({
    target: WALLET,
    kind: "injected",
    sendTransaction: h.sendTransaction,
    waitForReceipt: async () => true,
  })
  h.desktopBridgeChannel.mockReset().mockReturnValue({ target: TYPED, kind: "bridge" })
  h.ownSwapRecoverer.mockReset().mockResolvedValue({ account: ACCOUNT, secret: SECRET })
  h.oxideAccountPasskey.mockReset().mockResolvedValue({ key: PASSKEY_KEY, sign: h.sign })
  h.getCode.mockReset().mockResolvedValue("0x01")
  h.readAuthKeys.mockReset().mockResolvedValue([{ key: PASSKEY_KEY, metadata: "0x" }])
  h.sign.mockReset().mockResolvedValue(AUTH)
  h.sendTransaction.mockReset().mockResolvedValue(HASH)
  h.store.patch.mockReset()
  h.bridgeActive.current = false
})

describe("swapExitReasonFor", () => {
  it("always offers recovery to an escrow whose route cannot fill", () => {
    expect(swapExitReasonFor(record({ phase: "recoverable", phaseEnteredAt: NOW }), NOW)).toBe(
      "unswappable",
    )
  })

  it("offers a swapping escrow the self-run only once it has waited out the relayer", () => {
    expect(swapExitReasonFor(record(), NOW)).toBe("stuck")
    expect(swapExitReasonFor(record({ phaseEnteredAt: NOW - 1 }), NOW)).toBeNull()
  })

  it("offers nothing once the user's own swap is in flight", () => {
    expect(swapExitReasonFor(record({ swapExecuteTxHash: HASH }), NOW)).toBeNull()
  })

  it("offers nothing to a record that cannot rebuild its escrow args", () => {
    expect(swapExitReasonFor(record({ swapRecoveryCommitment: undefined }), NOW)).toBeNull()
    expect(
      swapExitReasonFor(record({ phase: "recoverable", swapNonce: undefined }), NOW),
    ).toBeNull()
  })

  it("offers nothing to a direct withdrawal or a released one", () => {
    expect(swapExitReasonFor(record({ swapOutput: undefined }), NOW)).toBeNull()
    expect(swapExitReasonFor(record({ phase: "done" }), NOW)).toBeNull()
    expect(swapExitReasonFor(record({ phase: "finalizing_l1" }), NOW)).toBeNull()
  })
})

describe("executeSwapWithdrawal", () => {
  it("signs over the injected wallet and hands the runner the escrow reader and store", async () => {
    await expect(executeSwapWithdrawal(record(), { from: WALLET })).resolves.toBe(HASH)
    expect(h.injectedWalletChannel).toHaveBeenCalledWith(
      expect.objectContaining({ l1ChainId: 11155111 }),
      expect.objectContaining({ from: WALLET }),
    )
    const deps = h.runSwapEscrowExecute.mock.calls[0]![0] as Record<string, unknown>
    expect(deps.channel).toEqual(expect.objectContaining({ kind: "injected" }))
    expect(deps.reader).toEqual(expect.objectContaining({ config: { dai: TOKEN } }))
    expect(deps.store).toBe(h.store)
    expect(deps.record).toEqual(record())
  })

  it("in the desktop launcher shows the helper page the recipient, who the swap pays", async () => {
    h.bridgeActive.current = true
    await executeSwapWithdrawal(record())
    expect(h.desktopBridgeChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: RECIPIENT,
        display: expect.objectContaining({
          lines: expect.arrayContaining([["Recipient", RECIPIENT]]),
        }),
      }),
    )
    expect(h.injectedWalletChannel).not.toHaveBeenCalled()
  })
})

describe("recoverSwapWithdrawal", () => {
  it("pays the withdrawal's own recipient by default, as this wallet's Oxide account", async () => {
    await expect(recoverSwapWithdrawal(record(), { from: WALLET })).resolves.toBe(HASH)
    expect(h.ownSwapRecoverer).toHaveBeenCalledWith({ token: TOKEN })
    expect(h.runSwapEscrowRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        target: RECIPIENT,
        dai: TOKEN,
        chainId: 11155111,
        recovery: { account: ACCOUNT, salt: deriveSwapEscrowRecoverySalt(SECRET, NONCE) },
        channel: expect.objectContaining({ kind: "injected" }),
      }),
    )
  })

  it("pays a typed destination instead when one is given", async () => {
    await recoverSwapWithdrawal(record(), { destination: TYPED })
    expect(h.runSwapEscrowRecovery).toHaveBeenCalledWith(expect.objectContaining({ target: TYPED }))
  })

  it("in the desktop launcher shows the helper page the recovered-to address", async () => {
    h.bridgeActive.current = true
    await recoverSwapWithdrawal(record(), { destination: TYPED })
    expect(h.desktopBridgeChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: TYPED,
        display: expect.objectContaining({
          lines: expect.arrayContaining([["Recovered to", TYPED]]),
        }),
      }),
    )
  })

  it("opens the escrow's commitment and signs with the account's installed passkey", async () => {
    h.runSwapEscrowRecovery.mockImplementation(runRecoveryForReal)
    await expect(recoverSwapWithdrawal(record(), { from: WALLET })).resolves.toBe(HASH)
    expect(h.oxideAccountPasskey).toHaveBeenCalledWith(h.provider)
    expect(h.readAuthKeys).toHaveBeenCalledWith(ACCOUNT, 64)
    expect(h.sign).toHaveBeenCalledOnce()
    expect(h.sendTransaction).toHaveBeenCalledWith(PLAN.escrow, expect.stringMatching(/^0x/))
    expect(h.store.patch).toHaveBeenCalledWith(
      L2_TX,
      expect.objectContaining({ phase: "recovered", recoveryTarget: RECIPIENT }),
    )
  })

  it.each([
    ["another account", planFor(OTHER_ACCOUNT)],
    ["another secret's salt", planFor(ACCOUNT, { toString: () => `0x${"12".repeat(32)}` })],
  ])("refuses an escrow committed to %s before the passkey prompts", async (_, other) => {
    h.runSwapEscrowRecovery.mockImplementation(runRecoveryForReal)
    const foreign = record({ swapRecoveryCommitment: other.escrowArgs.recoveryCommitment })
    await expect(recoverSwapWithdrawal(foreign, { from: WALLET })).rejects.toThrow(
      /not the recovery account/,
    )
    expect(h.sign).not.toHaveBeenCalled()
    expect(h.sendTransaction).not.toHaveBeenCalled()
  })

  it("refuses an account still on its bootstrap key before any transaction", async () => {
    h.runSwapEscrowRecovery.mockImplementation(runRecoveryForReal)
    h.getCode.mockResolvedValue("0x")
    await expect(recoverSwapWithdrawal(record(), { from: WALLET })).rejects.toThrow(
      /Finish setting up your account's passkey/,
    )
    expect(h.sign).not.toHaveBeenCalled()
    expect(h.sendTransaction).not.toHaveBeenCalled()
  })

  it("refuses a record without its escrow details before asking for the account", async () => {
    await expect(recoverSwapWithdrawal(record({ swapNonce: undefined }))).rejects.toThrow(
      /weren't stored/,
    )
    expect(h.ownSwapRecoverer).not.toHaveBeenCalled()
  })

  it("refuses a malformed destination and a locked wallet before touching a channel", async () => {
    await expect(
      recoverSwapWithdrawal(record(), { destination: "0x1234" as Address }),
    ).rejects.toThrow(/Ethereum address/)
    h.ownSwapRecoverer.mockRejectedValue(
      new Error("Unlock your wallet with your passkey and try again."),
    )
    await expect(recoverSwapWithdrawal(record())).rejects.toThrow(/Unlock your wallet/)
    expect(h.injectedWalletChannel).not.toHaveBeenCalled()
    expect(h.runSwapEscrowRecovery).not.toHaveBeenCalled()
  })
})

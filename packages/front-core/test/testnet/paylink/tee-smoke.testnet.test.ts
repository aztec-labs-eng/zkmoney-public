/**
 * DE-RISK GATE for the direct-paylink cold-claim benchmark.
 *
 * Proves the ONE thing that has never run against live testnet: a real
 * direct-paylink create+fund (creator) → cold escrow reconstruct+register+
 * claim (fresh-store claimer), end to end, through the oxide TEE pipeline.
 * If this can't pass, the benchmark N-loop is not worth building yet
 * (see the plan's de-risk-first ordering).
 *
 * Deliberately NOT a bare token transfer — it exercises the escrow contract
 * registration + escrow-note tagging discovery that the benchmark depends on.
 *
 * Run (operator only — needs a funded creator + the testnet TEE env):
 *   RUN_PAYLINK_TEE_SMOKE=1 \
 *     OXIDE_MANIFEST_URL=https://<oxide-env-registry>/staging.v4.json \
 *     OXIDE_PORTAL=<portal> \
 *     TESTNET_BRIDGE_RELAYER_URL=https://<oxide-relayer-url> \
 *     TESTNET_L1_RPC_URL=https://<testnet-L1-rpc> \
 *     pnpm --filter @obsidion/front-core test:testnet:tee-smoke
 *
 * The creator is a Schnorr account (like the fee-service admin) generated from
 * CREATOR_SK; its address is logged on run — fund it with testnet oxideToken.
 *
 * Skips cleanly (never fails) when the flag/env is absent or the creator is
 * unfunded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { sepolia } from "viem/chains"
import {
  benchmarkRegistry,
  DEFAULT_CONTRACTS,
  nextOperationId,
  PaylinkService,
  TokenService,
} from "@obsidion/sdk"
import type { BenchmarkSample } from "@obsidion/core/types"
import {
  buildColdClaimReport,
  PhaseTimer,
  type PhaseSample,
} from "../../../../sdk/test/testnet/paylink/coldClaimTimers.js"
import {
  setupTestnet,
  skipUnlessTestnet,
  type TestnetSetupResult,
} from "../../../../sdk/test/testnet/setupTestnet.js"
import { getChainTimestamp, waitForPaylinkDepositMined } from "../../../../sdk/test/utils/index.js"
import { createOxideTeeSignerSource } from "../../../src/tee/teeSignerSource.js"

const TEN_MINUTES = 10 * 60_000

const CREATOR_SK = process.env.PAYLINK_TEST_CREATOR_SK
console.log("CREATOR_SK", CREATOR_SK)
const AMOUNT = 100n // raw atomic units; creator must hold at least this
// Enable the per-tx timing benchmark so ObsidionWallet.sendTx records the
// entry-sync span as BenchmarkSample.phases.sync — the cold-claim sync timer
// this gate exists to measure. Must be set before any wallet.sendTx runs.
process.env.OBSIDION_TX_TIMING_BENCH = "true"
const BRIDGE_RELAYER_URL =
  process.env.TESTNET_BRIDGE_RELAYER_URL ?? "https://relayer.staging.zk.money"
// The staging relayer's edge gate
// requires X-Obsidion-Client; without it the /relayer-address probe (used to
// register the relayer's L2 account as a PXE sender) is rejected and bridge-
// minted notes stay invisible, so balances read 0.
const RELAYER_CLIENT_SECRET =
  process.env.TESTNET_RELAYER_CLIENT_SECRET ?? process.env.RELAYER_CLIENT_SECRET
console.log("RELAYER_CLIENT_SECRET", RELAYER_CLIENT_SECRET)
const RELAYER_HEADERS: Record<string, string> | undefined = RELAYER_CLIENT_SECRET
  ? { "X-Obsidion-Client": RELAYER_CLIENT_SECRET }
  : undefined

// Skip unless explicitly opted in AND a creator secret is present.
// (Schnorr creator → signing key derives from the secret; no separate key.)
const skip = skipUnlessTestnet() || process.env.RUN_PAYLINK_TEE_SMOKE !== "1" || !CREATOR_SK

const loadTeeSigner = (l1RpcUrl: string) =>
  createOxideTeeSignerSource({ l1RpcUrl, l1Chain: sepolia }).load()

describe.skipIf(skip)("direct paylink TEE smoke — testnet de-risk gate", () => {
  let creator: TestnetSetupResult
  let claimer: TestnetSetupResult
  let creatorToken: TokenService
  let creatorPaylink: PaylinkService
  let claimerPaylink: PaylinkService
  let claimerToken: TokenService
  let token: AztecAddress
  const benchmarkSamples: BenchmarkSample[] = []

  beforeAll(async () => {
    // Capture finalized benchmark samples (one per operationId) so the cold-claim
    // sync time is readable after the claim. Singleton sink — cleared in afterAll.
    benchmarkRegistry.setSampleSink((sample) => benchmarkSamples.push(sample))

    // Creator modeled on the fee-service admin: a Schnorr account whose signing
    // key derives from the secret. Fund the logged address with oxideToken.
    creator = await setupTestnet({
      accountType: "schnorr",
      secretKey: Fr.fromString(CREATOR_SK!),
      dataDirectory: `pxe-paylink-smoke-creator`,
      attachTeeSigner: true,
      loadTeeSigner,
      deployAccount: true,
    })

    // Cold claimer: fresh random keys + a fresh (cold) PXE store.
    claimer = await setupTestnet({
      dataDirectory: `pxe-paylink-smoke-claimer-cold`,
      attachTeeSigner: true,
      loadTeeSigner,
    })

    const contractService = (await import("@obsidion/sdk")).ContractService.getInstance()
    const resolved = await contractService.getContractAddress(DEFAULT_CONTRACTS.oxideToken)
    if (!resolved)
      throw new Error("[tee-smoke] oxideToken not resolvable through the oxide overlay")
    token = resolved

    creatorToken = await TokenService.create(
      creator.wallet,
      creator.account,
      token,
      creator.teeSigner,
      BRIDGE_RELAYER_URL,
      RELAYER_HEADERS,
    )
    claimerToken = await TokenService.create(
      claimer.wallet,
      claimer.account,
      token,
      claimer.teeSigner,
      BRIDGE_RELAYER_URL,
      RELAYER_HEADERS,
    )

    creatorPaylink = new PaylinkService(
      creator.wallet,
      creator.account,
      creatorToken,
      contractService,
      undefined,
      creator.teeSigner,
    )
    claimerPaylink = new PaylinkService(
      claimer.wallet,
      claimer.account,
      claimerToken,
      contractService,
      undefined,
      claimer.teeSigner,
    )
  }, TEN_MINUTES)

  afterAll(async () => {
    benchmarkRegistry.setSampleSink(undefined)
    await claimer?.teardown()
    await creator?.teardown()
  })

  it(
    "creator funds a direct paylink and a cold claimer claims it",
    async () => {
      // Register the oxide relayer's L2 account as a PXE sender so the
      // oxideToken notes it mints (funding + claim) become visible to
      // balance_of_private — the same side effect TokenService.create(relayerUrl,
      // relayerHeaders) has. Idempotent; re-run
      // here in case the relayer wasn't reachable at create() time.
      await creatorToken.ensureRelayerSenderRegistered()
      await claimerToken.ensureRelayerSenderRegistered()
      await creator.wallet.registerSender(
        AztecAddress.fromStringUnsafe(
          "0x210320c80e7df58fc7564e37012e4bc296ec24122f8cfabe78da98cb21324261",
        ),
      )
      await claimer.wallet.registerSender(
        AztecAddress.fromStringUnsafe(
          "0x210320c80e7df58fc7564e37012e4bc296ec24122f8cfabe78da98cb21324261",
        ),
      )

      console.log("creator", creator.account.getAddress().toString())
      const creatorBalance = await creatorToken.getBalance(creator.account)
      console.log("creatorBalance", creatorBalance)
      if (creatorBalance < AMOUNT) {
        // Non-fatal: matches the cancel-tx balance-probe precedent.
        console.warn(
          `[tee-smoke] creator ${creator.fromAddress.toString()} balance ${creatorBalance} < ${AMOUNT}; ` +
            `fund it with testnet oxideToken and re-run. Skipping.`,
        )
        return
      }

      const node = creator.wallet.node
      const params = await creatorPaylink.createPaylinkContract(
        {
          amount: AMOUNT,
          hash: 0n, // direct paylink: no commitment
          token,
          window: {
            fromClaimable: 0n,
            untilClaimable: BigInt((await getChainTimestamp(node)) + 86_400),
            refundableUntil: 0n,
          },
          masterSecret: Fr.random(),
        },
        DEFAULT_CONTRACTS.paylinkDirect,
        {
          profile: false,
          // operationId enables benchmark recording for this op (sample emitted via the sink).
          operationId: nextOperationId("paylink-create"),
          resolveSpendMetadata: creator.resolveSpendMetadata,
          // Pay the deposit fee via Obsidion's PasswordFPC (FPC_PASSWORD), not
          // the upstream Aztec SponsoredFPC the wallet default falls back to.
          sendOptions: {
            from: creator.account.getAddress(),
            fee: { paymentMethod: creator.passwordFeePaymentMethod },
          },
        },
      )
      console.log("sent paylink contract")
      await waitForPaylinkDepositMined(node, params)

      // Pre-claim: escrow note exists and is unspent.
      const claimedBefore = await claimerPaylink.isPaylinkClaimed(params)
      console.log("claimedBefore", claimedBefore)
      expect(claimedBefore).toBe(false)

      const balanceBefore = await claimerToken.getBalance(claimer.account)
      console.log("balanceBefore", balanceBefore)

      // No registerSender(creator): the deposit self-tags (paylink → paylink),
      // so the claimer discovers the note via the reconstructed paylink alone.

      // Cold sync_notes — reconstruct escrow + utility read before claim.
      const syncTimer = new PhaseTimer()
      const syncedNote = await syncTimer.time("sync_notes", () =>
        claimerPaylink.sync_note(params, claimer.account),
      )
      const syncNotesPhases = syncTimer.result()
      console.log("[tee-smoke] sync_notes phases (ms):", JSON.stringify(syncNotesPhases))
      console.log(
        "[tee-smoke] synced note:",
        JSON.stringify({
          amount: syncedNote.amount.toString(),
          claimableFrom: syncedNote.claimableFrom,
          claimableUntil: syncedNote.claimableUntil,
          validUntil: syncedNote.validUntil,
          expiresAt: syncedNote.expiresAt,
          status: syncedNote.status,
          isClaimable: syncedNote.isClaimable,
          isInGracePeriod: syncedNote.isInGracePeriod,
          isExpired: syncedNote.isExpired,
        }),
      )
      expect(syncedNote.amount).toBe(AMOUNT)
      expect(syncedNote.isClaimable).toBe(true)
      expect(syncedNote.tokenAddress.equals(token)).toBe(true)

      // The cold claim — reconstruct+register escrow, sync, discover note, claim.
      const claim = await claimerPaylink.claimPaylink(
        DEFAULT_CONTRACTS.paylinkDirect,
        params,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any, // empty DirectClaimInput
        {
          profile: false,
          // operationId + kind tag this op so the benchmark sample is recorded
          // as the "paylink-claim" flow.
          operationId: nextOperationId("paylink-claim"),
          kind: "paylink-claim",
          // Cold claim pays its own fee via the claimer's PasswordFPC method.
          sendOptions: {
            from: claimer.account.getAddress(),
            fee: { paymentMethod: claimer.passwordFeePaymentMethod },
          },
        },
      )
      await claim.txHash
      await claim.txPromise

      const createSample = benchmarkSamples.find((s) => s.flow === "paylink-create")
      const claimSample = benchmarkSamples.find((s) => s.flow === "paylink-claim")
      console.log("[tee-smoke] create phases:", JSON.stringify(createSample?.phases))
      console.log("[tee-smoke] cold-claim phases:", JSON.stringify(claimSample?.phases))

      // Feed the per-claim phase breakdown into the dedicated cold-claim
      // aggregator (coldClaimTimers). One cold rep here — the de-risk gate; the
      // benchmark N-loop will pass many cold + warm reps for real percentiles.
      if (claimSample) {
        // coldClaimTimers labels the non-representative host-WASM phase "prove"
        // (NON_REPRESENTATIVE_PHASES); the SDK sample labels it "proving". Remap
        // so representativeDominant excludes it and the WASM note fires.
        const { proving, ...restPhases } = claimSample.phases
        const coldRep: PhaseSample = { ...syncNotesPhases, ...restPhases, prove: proving }
        const report = buildColdClaimReport({
          coldReps: [coldRep],
          warmReps: [],
          coldDiagnostics: [{}],
          warmDiagnostics: [],
        })
        console.log("[tee-smoke] ColdClaimReport:", JSON.stringify(report, null, 2))
      }

      const balanceAfter = await claimerToken.getBalance(claimer.account)
      expect(balanceAfter).toBeGreaterThan(balanceBefore)

      const claimedAfter = await claimerPaylink.isPaylinkClaimed(params)
      expect(claimedAfter).toBe(true)
    },
    TEN_MINUTES,
  )
})

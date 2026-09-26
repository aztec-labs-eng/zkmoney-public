import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { NO_FROM } from "@aztec/aztec.js/account"
import { NO_WAIT } from "@aztec/aztec.js/contracts"
import { EthCheatCodes } from "@aztec/ethereum/test"
import { Fr } from "@aztec/aztec.js/fields"
import { DateProvider } from "@aztec/foundation/timer"
import { createAztecNodeAdminClient } from "@aztec/stdlib/interfaces/client"
import { setupTest } from "../../../sdk/test/utils/helper.js"
// @ts-expect-error zero-dep .mjs script, no types
import { healNonceGaps, makeRpc } from "../../../../scripts/reorg-l1.mjs"
import { AccountStorage } from "../../src/core/storages/AccountStorage"
import { TransactionStorage } from "../../src/core/storages/TransactionStorage"
import {
  ReorgMonitor,
  type ConfirmationOutcome,
} from "../../src/core/services/coordination/ReorgMonitor"
import type { ReorgTxReceiptLike } from "../../src/core/services/chain/receiptTypes"
import { setActiveNetworkId } from "../../src/core/activeNetworkId"
import { TRANSACTION_STATUS } from "../../src/core/services/transactions/constants"
import type { TokenInTxService } from "../../src/types/tokens"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { PausableSerialTask } from "./PausableSerialTask"
import { withPausedReorgWriters } from "./ReorgRollbackGuard"

/**
 * Real-reorg e2e: real sandbox node, real anvil rollbacks, real front-core stores.
 * Needs `AZTEC_DISABLE_ADMIN_API_KEY=1 PROVER_TEST_DELAY_MS=120000 aztec start --local-network`
 * — the admin API pauses the sequencer for the alert legs, and the prover delay keeps recent
 * blocks unproven so rollbacks can unwind them. Four scenarios, one tx each:
 *   recover-before-grace (sender / recipient): rollback → demote → quiet re-confirm.
 *   recover-after-grace (sender / recipient): rollback → demote, hold publication until the
 *   alert deadline, then resume and require the corrective re-confirmation.
 *
 * XMTP is deliberately absent: it only delivers the recipient's txHash hint. Rows enter
 * the watch set here exactly as the transfer scanner would insert them.
 */

const L1_RPC = process.env.SANDBOX_L1_RPC_URL ?? "http://localhost:8545"
const L2_RPC = process.env.SANDBOX_URL ?? "http://localhost:8080"
const ADMIN_RPC = process.env.AZTEC_NODE_ADMIN_URL ?? "http://localhost:8880"

const l1 = makeRpc(L1_RPC)
const l1Tip = async () => Number(await l1("eth_blockNumber"))
const l1CheatCodes = new EthCheatCodes([L1_RPC], new DateProvider())
const nodeAdmin = createAztecNodeAdminClient(
  ADMIN_RPC,
  undefined,
  undefined,
  process.env.AZTEC_ADMIN_API_KEY,
)
const CHECKPOINT_PROPOSED_TOPIC =
  "0x6ff492bf2b4ca1b93a175167d14b3e46085b935cab3f39ca94013000799b93a0"

const uint256Topic = (value: number) => `0x${BigInt(value).toString(16).padStart(64, "0")}`

type CheckpointLog = { blockNumber?: string; blockHash?: string }

const checkpointLogs = (rollupAddress: string, checkpointNumber: number) =>
  l1("eth_getLogs", [
    {
      address: rollupAddress,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [CHECKPOINT_PROPOSED_TOPIC, uint256Topic(checkpointNumber)],
    },
  ]) as Promise<CheckpointLog[]>

const waitUntil = async (pred: () => Promise<boolean> | boolean, timeoutMs: number) => {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 250))
  }
  return true
}

const waitFor = async (
  label: string,
  pred: () => Promise<boolean> | boolean,
  timeoutMs = 60_000,
) => {
  if (!(await waitUntil(pred, timeoutMs))) throw new Error(`timeout waiting for: ${label}`)
}

/**
 * Ceiling for the node to notice an L1 unwind once the chain is being kept busy. Detection is
 * activity-gated, not time-gated: the node syncs L1 (and so prunes) only when it builds a block,
 * and it only builds on new tx activity. Waiting passively deadlocks — a CI run sat idle for 4
 * minutes with five log lines, then pruned 4s after the next tx arrived. Anything waiting on a
 * post-reorg observation must therefore drive activity itself; see `waitUntilWithActivity`.
 * The wallet is never the slow part — it emitted its outcome 80ms after the prune.
 */
const REORG_DETECT_MS = 240_000

/** How often to poke the chain while waiting for it to notice something. */
const NUDGE_INTERVAL_MS = 15_000

/** What ReorgNotificationProducer would mint for an outcome (its unit suite pins the real mapping). */
const notificationIdFor = (o: ConfirmationOutcome): string | null => {
  switch (o.type) {
    case "failed":
    case "grace-expired":
      return `reorg:failed:${o.txHash}:${o.reorgEpoch ?? 0}`
    case "re-confirmed":
      return o.hadAlerted ? `reorg:reconfirmed:${o.txHash}:${o.reorgEpoch ?? 0}` : null
    case "exit-required":
      return `reorg:exit:${o.txHash}`
    default:
      return null
  }
}

describe("reorg e2e (sandbox)", () => {
  let node: any
  let wallet: any
  let adminAddress: any
  let sendOptions: any
  let storage: TransactionStorage
  let rollupAddress: string

  const txHashObjs = new Map<string, unknown>()
  const outcomes: ConfirmationOutcome[] = []
  const activeMonitors = new Set<ReorgMonitor>()
  let nonceHealer: PausableSerialTask

  const receiptNode = {
    getTxReceipt: async (txHash: string): Promise<ReorgTxReceiptLike> => {
      const raw = txHashObjs.get(txHash.toLowerCase())
      if (!raw) throw new Error(`unknown txHash ${txHash}`)
      const receipt = await node.getTxReceipt(raw)
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber !== undefined ? Number(receipt.blockNumber) : undefined,
        blockHash: receipt.blockHash?.toString(),
        executionResult: receipt.executionResult,
      }
    },
  }
  const startMonitor = (graceWindowMs: number): ReorgMonitor => {
    const monitor = new ReorgMonitor({
      node: receiptNode,
      transactionStorage: storage,
      pollIntervalMs: 400,
      graceWindowMs,
    })
    monitor.subscribe((o) => {
      outcomes.push(o)
      console.log("[reorg e2e] outcome", JSON.stringify(o))
    })
    monitor.start()
    activeMonitors.add(monitor)
    return monitor
  }

  const tokenInTx = (amount: number): TokenInTxService => ({
    address: "0xreorg-test-token",
    name: "Reorg Test",
    symbol: "RRG",
    decimals: 18,
    logo: "",
    amount,
    price: 0,
  })

  /**
   * Submit a fresh Schnorr account deploy — the lightest tx the sandbox admits (the
   * standard Token deploy trips the DA gas cap). A rollback can leave the PXE anchored on
   * a pruned block; it re-anchors on its next sync, so retry the simulation a few times.
   */
  const sendAccountDeploy = async (): Promise<any> => {
    const manager = await wallet.createSchnorrAccount(Fr.random(), Fr.random())
    const instance = await manager.getInstance()
    const deployMethod = await manager.getDeployMethod()
    const deployOpts = {
      from: NO_FROM,
      universalDeploy: true,
      contractAddressSalt: instance.salt,
      fee: sendOptions.fee,
      wait: NO_WAIT,
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await deployMethod.send(deployOpts)
      } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err)
        // "Block hash … not found when resolving query" is the node refusing a query anchored on
        // a block the rollback pruned — the PXE re-anchors on its next sync.
        const transient =
          msg.includes("Reference block") ||
          msg.includes("Existing nullifier") ||
          ((msg.includes("Block hash") || msg.includes("Block header")) &&
            msg.includes("not found"))
        if (attempt >= 4 || !transient) throw err
        await new Promise((r) => setTimeout(r, 4_000))
      }
    }
  }

  /** One real included L2 tx; the reorg layer only ever sees the receipt, and the row
   * content is seeded independently. */
  const sendRealTx = async (label: string) => {
    const sent = await sendAccountDeploy()
    const hash = sent.txHash.toString().toLowerCase()
    txHashObjs.set(hash, sent.txHash)
    // "proposed" is only the gossiped L2 block; the tx is not on L1 until its block is
    // CHECKPOINTED. Rolling back earlier cannot touch it, so wait for the checkpoint — keeping
    // the builder fed, since a chain left idle mid-reconcile can sit on a pending tx for minutes.
    await waitForWithActivity(
      `${label} checkpointed on L1`,
      async () => {
        const r = await receiptNode.getTxReceipt(hash)
        if (r.status === "checkpointed" || r.status === "proven" || r.status === "finalized") {
          return true
        }
        return false
      },
      420_000,
    )
    const receipt = await receiptNode.getTxReceipt(hash)
    const checkpointNumber = receipt.blockNumber!
    const logs = await checkpointLogs(rollupAddress, checkpointNumber)
    const checkpointL1Blocks = logs
      .map((log) => (log.blockNumber ? Number(log.blockNumber) : Number.NaN))
      .filter(Number.isFinite)
    if (checkpointL1Blocks.length !== 1) {
      throw new Error(
        `expected one canonical L1 checkpoint log for checkpoint ${checkpointNumber}, got ${checkpointL1Blocks.length}`,
      )
    }
    if (!logs[0].blockHash) {
      throw new Error(`checkpoint ${checkpointNumber} log is missing its L1 block hash`)
    }
    return {
      hash,
      blockNumber: checkpointNumber,
      checkpointL1Block: checkpointL1Blocks[0],
      checkpointL1BlockHash: logs[0].blockHash,
    }
  }

  const rowFor = async (hash: string) => {
    const rows = await storage.getTransactions()
    const row = rows.find((tx) => (tx.txHash ?? "").toLowerCase() === hash)
    if (!row) throw new Error(`no row for ${hash}`)
    return row
  }

  const outcomesFor = (hash: string) => outcomes.filter((o) => o.txHash.toLowerCase() === hash)

  beforeAll(async () => {
    const health = await fetch(L2_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "node_getNodeInfo", params: [], id: 1 }),
    }).catch(() => null)
    if (!health?.ok) {
      throw new Error(
        `sandbox not reachable at ${L2_RPC} — run \`aztec start --local-network\` first`,
      )
    }

    // The sdk test wallet persists PXE state in ./pxe-<rollupAddress>, and a restarted
    // sandbox reuses the same rollup address — stale state from a previous chain then
    // poisons sends ("Existing nullifier"). Always start from a clean client view.
    const fs = await import("node:fs")
    for (const entry of fs.readdirSync(".")) {
      if (entry.startsWith("pxe-0x")) fs.rmSync(entry, { recursive: true, force: true })
    }

    const setup = await setupTest()
    node = setup.node
    wallet = setup.wallet
    adminAddress = setup.accounts[0].getAddress()
    sendOptions = await wallet.getDefaultSendOptions(adminAddress)

    const info = await node.getNodeInfo()
    rollupAddress = String(info.l1ContractAddresses.rollupAddress)
    setActiveNetworkId(rollupAddress)

    const adapter = new InMemoryStorageAdapter()
    AccountStorage.get(adapter)
    storage = TransactionStorage.get(adapter)

    // A rollback rewinds the sequencer publisher's L1 account nonce while its cached nonce
    // manager keeps counting; the next checkpoint parks behind the gap and the rollup freezes.
    // Serialize heals so pauseAndDrain() is a real barrier before the held rollback starts.
    nonceHealer = new PausableSerialTask(
      () => healNonceGaps(L1_RPC).then(() => {}),
      3_000,
      (error) => console.warn("[reorg e2e] nonce healing failed", error),
    )
    nonceHealer.start()
  })

  afterEach(() => {
    for (const monitor of activeMonitors) monitor.stop()
    activeMonitors.clear()
  })

  afterAll(async () => {
    await nonceHealer?.stop()
  })

  const seedRow = async (kind: "send" | "receive", hash: string, blockNumber: number) => {
    if (kind === "send") {
      await storage.addTokenTransaction(
        "send",
        tokenInTx(25),
        TRANSACTION_STATUS.SUCCESS,
        hash,
        "0xrecipient",
      )
    } else {
      await storage.addIncomingTokenTransaction({
        txHash: hash,
        from: "reorg-sender",
        senderL2Address: adminAddress.toString(),
        to: adminAddress.toString(),
        token: tokenInTx(25),
        timestamp: Date.now(),
        blockNumber,
      })
    }
  }

  /**
   * Send one tx, seed its row, wait for the monitor to stamp the block anchor,
   * then roll L1 back past the tx's checkpoint. One tx per cycle, reorged right after
   * checkpointing: the prover-delayed sandbox keeps recent blocks unproven and unwindable.
   * Mining stays paused until the wallet observes the unwind. Otherwise anvil can re-mine the
   * rolled-back checkpoint before the node sees the replacement chain, producing no reorg at all.
   */
  const includeAndReorg = async (
    kind: "send" | "receive",
    graceWindowMs: number,
    opts: {
      whileMiningHeld?: (tx: Awaited<ReturnType<typeof sendRealTx>>) => Promise<void>
    } = {},
  ) => {
    outcomes.length = 0
    const monitor = startMonitor(graceWindowMs)
    const tx = await sendRealTx(`${kind} tx`)
    await seedRow(kind, tx.hash, tx.blockNumber)
    await waitFor(
      "block anchor stamped on the row",
      async () => (await rowFor(tx.hash)).blockHash !== undefined,
      30_000,
    )
    const anchorHash = (await rowFor(tx.hash)).blockHash

    // Stop checkpoint production before draining nonce healing. Reversing these calls leaves a
    // window in which the sequencer can submit a new checkpoint between the drain and the L1 hold;
    // rolling that submission back poisons the publisher nonce and starves every later scenario.
    await withPausedReorgWriters(nodeAdmin, nonceHealer, async () => {
      await l1CheatCodes.execWithPausedAnvil(async () => {
        const preRollbackReceipt = await receiptNode.getTxReceipt(tx.hash)
        if (preRollbackReceipt.status === "finalized") {
          throw new Error(
            `${kind} tx ${tx.hash} finalized before rollback; increase PROVER_TEST_DELAY_MS`,
          )
        }

        // Read the tip only after interval mining and automine are disabled, then target the block
        // immediately below the checkpoint. This makes the target stable rather than carrying a
        // depth sampled from a moving chain into the rollback helper.
        const frozenTip = await l1Tip()
        const targetTip = tx.checkpointL1Block - 1
        const depth = frozenTip - targetTip
        expect(targetTip).toBeGreaterThan(0)
        expect(depth).toBeGreaterThan(0)
        console.log(
          `[reorg e2e] ${kind} tx ${tx.hash}: frozen L1 tip ${frozenTip}, checkpoint block ${tx.checkpointL1Block}, target tip ${targetTip}, rollback depth ${depth}`,
        )

        await l1CheatCodes.reorg(depth)
        expect(await l1Tip()).toBe(targetTip)

        // A lowered-but-static L1 tip is not enough: the archiver can wait forever for the
        // missing heights it had already synced. Replace the entire removed range with empty
        // blocks while publisher txs remain unmineable, so it can compare the old and new chain
        // through the former tip without the checkpoint being immediately rebuilt.
        await l1CheatCodes.mineEmptyBlock(depth)
        expect(await l1Tip()).toBe(frozenTip)

        // Prove the old checkpoint was actually removed before accepting any wallet observation.
        // This also catches an unexpected miner or nonce-heal evm_mine during the hold.
        const replacementCheckpointBlock = (await l1("eth_getBlockByNumber", [
          `0x${tx.checkpointL1Block.toString(16)}`,
          false,
        ])) as { hash?: string } | null
        expect(replacementCheckpointBlock?.hash).toBeDefined()
        expect(replacementCheckpointBlock?.hash).not.toBe(tx.checkpointL1BlockHash)
        expect(await checkpointLogs(rollupAddress, tx.blockNumber)).toEqual([])

        await waitFor(
          "wallet emitted demoted for the removed checkpoint while mining was held",
          () => {
            const txOutcomes = outcomesFor(tx.hash)
            if (txOutcomes.some((outcome) => outcome.type === "demoted")) return true
            const unexpected = txOutcomes.find(
              (outcome) =>
                outcome.type === "failed" ||
                outcome.type === "grace-expired" ||
                outcome.type === "re-confirmed" ||
                outcome.type === "finalized",
            )
            if (unexpected) {
              throw new Error(
                `expected demoted before ${unexpected.type} for ${tx.hash}: ${JSON.stringify(
                  txOutcomes,
                )}`,
              )
            }
            return false
          },
          REORG_DETECT_MS,
        )
        await opts.whileMiningHeld?.(tx)
      })
    })
    return { monitor, tx, anchorHash }
  }

  /** The sandbox only builds blocks on activity; a fresh tx makes the block builder sweep
   * the reorg-restored tx back in with it. */
  const nudgeBlockBuild = async () => {
    await sendAccountDeploy()
  }

  /**
   * Wait for `pred`, poking the chain as we go. Every post-reorg observation needs this: the node
   * only syncs L1 — and so only prunes, regresses receipts, and re-includes restored txs — while
   * it is building blocks, and it only builds on new tx activity. A passive poll waits forever for
   * a state change that its own idleness is preventing. Nudge failures are ignored; a nudge is
   * just noise to make the builder run, and post-reorg sends legitimately bounce.
   */
  const waitUntilWithActivity = async (
    pred: () => Promise<boolean> | boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    const start = Date.now()
    let lastNudge = 0
    while (true) {
      if (Date.now() - lastNudge >= NUDGE_INTERVAL_MS) {
        lastNudge = Date.now()
        await sendAccountDeploy().catch(() => {})
      }
      if (await pred()) return true
      if (Date.now() - start > timeoutMs) return false
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  const waitForWithActivity = async (
    label: string,
    pred: () => Promise<boolean> | boolean,
    timeoutMs: number,
  ) => {
    if (!(await waitUntilWithActivity(pred, timeoutMs))) {
      throw new Error(`timeout waiting for: ${label}`)
    }
  }

  const encourageReinclusion = async (tx: Awaited<ReturnType<typeof sendRealTx>>) => {
    const pooled = await node.getTxByHash(txHashObjs.get(tx.hash))
    if (pooled) {
      try {
        await node.sendTx(pooled)
      } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err)
        if (!msg.includes("Existing nullifier")) throw err
      }
    }
    // The PXE can still be re-anchoring immediately after the rollback. A nudge is only a hint;
    // waitForReconfirmation keeps retrying activity and owns the timeout if recovery stalls.
    await nudgeBlockBuild().catch(() => {})
  }

  const waitForReconfirmation = async (
    tx: Awaited<ReturnType<typeof sendRealTx>>,
    allowedPriorOutcome: "none" | "grace-expired",
  ) => {
    await waitForWithActivity(
      "wallet emitted re-confirmed after checkpoint publication resumed",
      () => {
        const txOutcomes = outcomesFor(tx.hash)
        const reconfirmed = txOutcomes.find((outcome) => outcome.type === "re-confirmed")
        if (reconfirmed) return true
        const unexpected = txOutcomes.find(
          (outcome) =>
            outcome.type === "failed" ||
            outcome.type === "finalized" ||
            (outcome.type === "grace-expired" && allowedPriorOutcome === "none"),
        )
        if (unexpected) {
          throw new Error(
            `expected re-confirmed before ${unexpected.type} for ${tx.hash}: ${JSON.stringify(
              txOutcomes,
            )}`,
          )
        }
        return false
      },
      180_000,
    )
    return outcomesFor(tx.hash).find((outcome) => outcome.type === "re-confirmed")!
  }

  const waitForCanonicalReinclusion = async (tx: Awaited<ReturnType<typeof sendRealTx>>) => {
    await waitForWithActivity(
      "re-included transaction checkpointed on the replacement chain",
      async () => {
        const receipt = await receiptNode.getTxReceipt(tx.hash)
        if (
          receipt.status !== "checkpointed" &&
          receipt.status !== "proven" &&
          receipt.status !== "finalized"
        ) {
          return false
        }
        const row = await rowFor(tx.hash)
        return row.status === TRANSACTION_STATUS.SUCCESS && row.blockHash === receipt.blockHash
      },
      180_000,
    )
    return rowFor(tx.hash)
  }

  const expectEpochMatchesDemotions = (txHash: string, reorgEpoch: number | undefined) => {
    const demotions = outcomesFor(txHash).filter((outcome) => outcome.type === "demoted").length
    expect(demotions).toBeGreaterThan(0)
    expect(reorgEpoch).toBe(demotions)
  }

  const assertRecovers = async (kind: "send" | "receive") => {
    // The grace window outlasts detection and re-confirmation so this leg must recover quietly.
    const { monitor, tx, anchorHash } = await includeAndReorg(kind, REORG_DETECT_MS + 360_000)

    await encourageReinclusion(tx)
    const reconfirmed = await waitForReconfirmation(tx, "none")

    const row = await waitForCanonicalReinclusion(tx)
    expectEpochMatchesDemotions(tx.hash, row.reorgEpoch)
    expect(row.status).toBe(TRANSACTION_STATUS.SUCCESS)
    expect(row.blockHash).toBeDefined()
    expect(row.blockHash).not.toBe(anchorHash)
    expect(reconfirmed).toMatchObject({ type: "re-confirmed", hadAlerted: false, reorgEpoch: 1 })
    expect(outcomesFor(tx.hash).map(notificationIdFor).filter(Boolean)).toEqual([])
    monitor.stop()
  }

  const assertAlertsThenRecovers = async (kind: "send" | "receive") => {
    const { monitor, tx, anchorHash } = await includeAndReorg(kind, 4_000, {
      whileMiningHeld: async (heldTx) => {
        await waitFor(
          "wallet emitted grace-expired while checkpoint publication remained held",
          () => {
            const txOutcomes = outcomesFor(heldTx.hash)
            if (txOutcomes.some((outcome) => outcome.type === "grace-expired")) return true
            const unexpected = txOutcomes.find(
              (outcome) =>
                outcome.type === "failed" ||
                outcome.type === "re-confirmed" ||
                outcome.type === "finalized",
            )
            if (unexpected) {
              throw new Error(
                `expected grace-expired before ${unexpected.type} for ${
                  heldTx.hash
                }: ${JSON.stringify(txOutcomes)}`,
              )
            }
            return false
          },
          30_000,
        )
      },
    })

    const alert = outcomesFor(tx.hash).find((outcome) => outcome.type === "grace-expired")!
    expect(alert).toMatchObject({ type: "grace-expired", reorgEpoch: 1 })
    expect(notificationIdFor(alert)).toBe(`reorg:failed:${tx.hash}:1`)
    expect(await rowFor(tx.hash)).toMatchObject({
      status: TRANSACTION_STATUS.PENDING,
      reorgEpoch: 1,
    })

    await encourageReinclusion(tx)
    const reconfirmed = await waitForReconfirmation(tx, "grace-expired")
    const row = await waitForCanonicalReinclusion(tx)
    expect(reconfirmed).toMatchObject({ type: "re-confirmed", hadAlerted: true, reorgEpoch: 1 })
    expect(notificationIdFor(reconfirmed)).toBe(`reorg:reconfirmed:${tx.hash}:1`)
    expectEpochMatchesDemotions(tx.hash, row.reorgEpoch)
    expect(row.status).toBe(TRANSACTION_STATUS.SUCCESS)
    expect(row.blockHash).not.toBe(anchorHash)
    expect(outcomesFor(tx.hash).map(notificationIdFor).filter(Boolean)).toEqual([
      `reorg:failed:${tx.hash}:1`,
      `reorg:reconfirmed:${tx.hash}:1`,
    ])
    monitor.stop()
  }

  it("sender payment reorged: demotes with epoch fence, no premature alert, quiet re-confirm when re-included", async () => {
    await assertRecovers("send")
  })

  it("received payment reorged: incoming row demotes the same way, no premature alert", async () => {
    await assertRecovers("receive")
  })

  it("sender payment held past grace: reorg:failed alert followed by corrective recovery notice", async () => {
    await assertAlertsThenRecovers("send")
  })

  it("received payment held past grace: same alert and corrective recovery path", async () => {
    await assertAlertsThenRecovers("receive")
  })
})

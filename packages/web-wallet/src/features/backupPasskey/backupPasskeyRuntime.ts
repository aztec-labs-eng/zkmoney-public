import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  backupLinks,
  deriveBootstrapKey,
  deriveStealthKey,
  FUNDING_STATUS,
  fundingFits,
  loadRecords,
  observeSipas,
  operationIndex,
  pubkeyToR1KeyArg,
  RootPasskeyRequiredError,
  signAccountUserOp,
  stampWithdrawal,
  unreadDeposits,
  withNotes,
  withOperation,
  type BackupRotationRecord,
  type OutcomeNode,
  type PaylinkRecord,
  type RotationFlowDeps,
  type SignInput,
} from "@obsidion/front-core"
import {
  base64UrlToBytes,
  runBackupPasskeyCreation,
  type BackupAddChoice,
} from "@obsidion/passkey-web"
import {
  assertBackupSweepProfitable,
  backupSweepRefused,
  buildBackupSweep,
  fundingAmount,
  isWithdrawalSpent,
  nextOperationId,
  prepareBackupRotation,
  quoteBackupSweep,
  readBridgeDestination,
  readRotationFundability,
  readSpendShape,
  readTokenBalanceAt,
  rotationUserOpHash,
  settledBlockNumber,
  verifyPersistedRotation,
  type BackupPasskeyAdd,
  type FundingAmount,
  type BackupRotationTuple,
  type ObsidionAccount,
  type ObsidionWallet,
  type PersistedRotation,
  type RotationIntent,
} from "@obsidion/sdk"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import { bytesToHex, formatUnits, TransactionReceiptNotFoundError } from "viem"
import type { Address, Hex, PublicClient } from "viem"
import { getWebOxideToken } from "../../config/classArtifacts"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { errorMessage } from "../../errors/catalog"
import { trackBackupPasskeyAdd } from "../../lib/backupPasskeyTelemetry"
import { withTimeout } from "../../lib/withTimeout"
import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
import { DepositReadError, EmptyDepositError } from "../deposit/depositReadErrors"
import { readStrandedToken, type StrandedToken } from "../deposit/recovery/sipaRecovery"
import { saveIdentity, type OnboardingKeys } from "../../session/account"
import { markCreatedHere } from "../migration/upgradeLock"
import { claimSponsorContext } from "../registration/claimSponsorship"
import { generationFactories, loadOxideGenerations } from "../registration/oxideGenerations"
import { RAIL_REGISTERED } from "../registration/rails"
import { unlockedSessionKeys } from "../registration/registrationResume"
import { runOperation } from "../operations/operations"
import {
  creatorLinkFor,
  linkRefundable,
  recoverSponsoredLink,
  type SponsoredPaylinkDeps,
} from "../paylink/sponsoredPaylink"
import { l2TokenService } from "../token/l2TokenService"
import {
  currentDeployment,
  noteSponsoredMine,
  runBurn,
  withdrawalOptions,
} from "../withdraw/withdrawGateway"
import { withdrawalExecutorFee } from "../withdraw/withdrawalFee"
import { readBackupAddTakesMs } from "./backupAddTime"
import { backupMoveTokens, moveCap, moveCount, readMoveBalances } from "./backupMoveTokens"
import { passkeyDeclined, type BackupAddDeps } from "./backupPasskeyAdd"
import { rerootToPasskeySet, sessionChanged, type RerootDeps } from "./rerootToPasskeySet"
import {
  publishRotationAddress,
  republishRotationAddress,
  seedRotationDeposit,
} from "./rotationPublish"
import { accountRotations } from "./backupRotations"
import { activeNamespace, signedInAccount, type Session } from "../../session/session"
import { linkFragmentOf } from "../../ui/screens/activityView"

/** One id per load of the page: the life of the wallet its sends are seeded under. */
const WALLET_LIFE = crypto.randomUUID()

/**
 * The name the backup passkey is created under: the account's tag, or a short form of the owner
 * for an identity without one. Either fits the user handle's name budget.
 */
export function backupUserName(handle: string | undefined, owner: Address): string {
  return handle || `${owner.slice(0, 6)}…${owner.slice(-4)}`
}

/** What the deposit address holds once a withdrawal of `withdrawn` is released, after its charges. */
export function depositedAmount(live: FundingAmount, withdrawn: bigint): bigint {
  const b = live.breakdown
  return withdrawn - b.withdrawalFee - b.proverTip - b.relayerTip
}

/**
 * What the deposit address holds once the funding is released: the withdrawal of `saved` (the live
 * amount before a plan is saved) less the withdrawal's current charges. Undefined once that no longer
 * covers the route's own charges and minimum credit, so the saved funding cannot be swept.
 */
export function sweepFunding(live: FundingAmount, saved: string | undefined): bigint | undefined {
  const b = live.breakdown
  const held = depositedAmount(live, saved === undefined ? live.amount : BigInt(saved))
  return held >= b.sweepTip + b.beneficiaryFee + b.minCredited ? held : undefined
}

/** The token's service for `account` with the co-signer its sponsored sends go through. */
export async function sponsoredTokenService(
  page: Pick<Session["page"], "chain" | "tokenServices">,
  account: ObsidionAccount,
  token: string,
) {
  const { chain } = page
  const [service, signer] = await Promise.all([
    l2TokenService(page, account, token),
    chain.teeSignerOfToken(token),
  ])
  service.setTeeSigner(signer)
  return service
}

/** The wallet's node as `txOutcome` reads it. */
export function walletOutcomeNode(wallet: ObsidionWallet): OutcomeNode {
  return {
    getTxReceipt: async (txHash) => {
      const receipt = await wallet.node.getTxReceipt(TxHash.fromString(txHash))
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash?.toString(),
        executionResult: receipt.executionResult,
      }
    },
    finalizedTimestampMs: async () => {
      const block = await wallet.node.getBlockData("finalized")
      if (!block) throw new Error("no finalized block")
      return Number(block.header.globalVariables.timestamp) * 1000
    },
  }
}

/** The session's root key as the flows name it: 64 bytes x‖y, hex, no prefix. */
async function sessionRootKey(session: Pick<Session, "auth">, wallet: ObsidionWallet) {
  const keys = await unlockedSessionKeys(session, wallet)
  if (!keys) throw new Error("wallet locked")
  return { keys, rootPubkeyHex: keys.pubkeyHex.slice(2) }
}

/**
 * The add's dependencies for the signed-in session and the account the record names: the session
 * key is the root key, the auth service creates the passkey, and its rotations keep the record.
 * Nothing here reads the account's key list. The add attempt is not reported.
 */
export async function buildBackupAddDeps(input: {
  session: Session
  owner: Address
  choice?: BackupAddChoice
}): Promise<BackupAddDeps> {
  const { auth, identity } = input.session
  const { keys } = await sessionRootKey(input.session, await input.session.wallet.ready())
  const userName = backupUserName(identity.get().value?.handle, input.owner)
  return {
    owner: input.owner,
    masterKey: () => new Uint8Array(keys.secretKey.toBuffer()),
    create: (ceremony, observe, signal) =>
      auth.createBackupPasskey(runBackupPasskeyCreation, ceremony, {
        userName,
        observe,
        ...(input.choice ? { choice: input.choice } : {}),
        ...(signal ? { signal } : {}),
      }),
    track: trackBackupPasskeyAdd,
    store: accountRotations(input.session),
  }
}

/** How long the Fund step's fit read may take before it counts as failed. */
const FIT_ANSWER_WITHIN_MS = 15_000

/** The flow's dependencies plus the reads the panel runs before signing and before a recovery. */
export interface BackupFlowDeps extends RotationFlowDeps {
  /** The change for the record's backup, priced and planned over the chain now. */
  prepare(record: BackupRotationRecord): Promise<SignInput>
  /**
   * Whether the one-key account funds an amount in one transfer of the funding token, over its
   * balance as read now: the Fund step's check before it offers a tip on top. Rejects when the read
   * fails or runs past its bound.
   */
  fundable(): Promise<(amount: bigint) => boolean>
  /**
   * Writes the recovery origin on the deposit address's rail record if it lacks one, then reads the
   * fee token held there, for the Settings recovery sheet.
   */
  strandedDeposit(record: BackupRotationRecord): Promise<StrandedToken>
}

type SessionRootKey = Awaited<ReturnType<typeof sessionRootKey>>

/** The two-key address of the root key and `pubkeyHex`, as the account contract derives it. */
const twoKeyAddress = (wallet: ObsidionWallet, session: SessionRootKey, pubkeyHex: string) =>
  wallet.deriveAccountAddress(session.keys.secretKey, [session.rootPubkeyHex, pubkeyHex])

const keyHex = (key: { qx: string; qy: string }) => `${key.qx.slice(2)}${key.qy.slice(2)}`
const addPubkeyHex = (add: BackupPasskeyAdd) => keyHex(add.pubkey)
const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The signed change as this session may act on it: its root key must be the session's, so the move
 * spends from the account the change was built over and nothing else.
 */
export function signedChangeFor(
  rotation:
    | {
        expectedKeys: readonly { key: { qx: string; qy: string } }[]
        builtOver: { l2Address: string }
        add: { pubkey: { qx: string; qy: string } }
      }
    | undefined,
  rootPubkeyHex: string,
): { source: string; add: string } {
  if (!rotation) throw new Error("nothing signed to move")
  const root = rotation.expectedKeys[0]?.key
  if (!root || !sameHex(keyHex(root), rootPubkeyHex)) throw new RootPasskeyRequiredError()
  return { source: rotation.builtOver.l2Address, add: keyHex(rotation.add.pubkey) }
}

/**
 * The re-root's dependencies on this session's keys. `root` signs over the passkey set, and is the
 * account's signer when the stored account names none.
 */
export function rerootDeps(input: {
  session: Session
  wallet: Pick<ObsidionWallet, "deriveAccountAddress" | "createObsidionAccount">
  secretKey: OnboardingKeys["secretKey"]
  /** The one-key account's address, which the root's record still names. */
  oneKeyAddress: string
  root: { credentialId: string; pubkeyHex: string }
  switchAccount: (account: ObsidionAccount) => void
}): RerootDeps {
  const { session, wallet, secretKey, oneKeyAddress, root, switchAccount } = input
  const { auth, device } = session
  const signer = { credentialId: root.credentialId, pubkey: root.pubkeyHex }
  return {
    derive: async (set) => (await wallet.deriveAccountAddress(secretKey, set)).toString(),
    root,
    rootRecord: () => auth.accountRecord(oneKeyAddress),
    session: () => auth.holdsSession(root.credentialId),
    providerFor: (set) => auth.providerFor({ ...root, passkeys: set }),
    account: (authProvider) => wallet.createObsidionAccount(secretKey, authProvider),
    persist: async (account, records, held) => {
      const accounts = signedInAccount(session)
      const { prefix } = activeNamespace(device)
      await accounts.ready
      const completeAddress = account.getCompleteAddress().toString()
      await session.database.write(async (w) => {
        await auth.stageRecoveryMetadata(w, records)
        await accounts.apply({ type: "moved", completeAddress, signer }, w.scoped(prefix))
        // Asked after the write's reads, so a sign-out that began during them saves nothing.
        if (!held()) throw sessionChanged()
      })
      for (const { credentialId } of records) await auth.recordLearned(credentialId)
    },
    commit: async (authProvider) => {
      const generation = await auth.commitSecret(
        { secretKey, authProvider },
        () => device.get().credentialId === root.credentialId,
      )
      if (generation === false || !auth.sessionHeld(generation)) throw sessionChanged()
    },
    moveIdentity: async (account) => {
      const address = account.getAddress().toString()
      const identity = session.identity.get().value
      if (identity) await saveIdentity(session.page, { ...identity, address })
      // New on this version: nothing older to upgrade.
      markCreatedHere(session.page.config, address)
    },
    switchAccount,
  }
}

/**
 * Everything the rotation flow runs against for `owner`, on this session's keys: the L1 reads over
 * the fee token bridge's deployment, the root passkey's signature, the deposit address's rail record
 * and broadcast, the funding withdrawal through the wallet's burn path, the re-root of this browser
 * and the move of the one-key account's balance.
 */
export async function buildBackupFlowDeps(input: {
  session: Session
  owner: Address
  /** Hands the page the two-key account once the re-root switched to it. */
  switchAccount?: (account: ObsidionAccount) => void
}): Promise<BackupFlowDeps> {
  const { session, owner } = input
  const wallet = await session.wallet.ready()
  const store = accountRotations(session)
  const { config, chain } = session.page
  const client = l1PublicClient(config)
  const { auth, device } = session
  const { credentialId } = device.get()
  if (!credentialId) throw new Error("wallet locked")
  const rootKey = await sessionRootKey(session, wallet)
  const { keys, rootPubkeyHex } = rootKey
  const envTuple = await chain.feeTokenBridgeTuple.read()
  const [tuple, env] = await Promise.all([
    readBridgeDestination(client, envTuple),
    chain.oxideEnv.read(),
  ])
  const plainWithdrawalExecutor = requireTupleField(envTuple, "plainWithdrawalExecutor") as Address
  const l2Token = requireTupleField(envTuple, "l2Token")
  const contractService = await session.contractService.ready()
  const sponsorDeps = { session, wallet, account: keys.account, contractService }

  const userOpHash = (rotation: Pick<PersistedRotation, "intent">) =>
    rotationUserOpHash(client, rotation.intent, tuple)
  /** The persisted change in the shape the sdk's readers take. */
  const rotationIntent = async (rotation: PersistedRotation): Promise<RotationIntent> => {
    const recipient = await twoKeyAddress(wallet, rootKey, addPubkeyHex(rotation.add))
    return {
      sharedSecretSalt: rotation.sharedSecretSalt,
      newRecord: { ...rotation.builtOver, l2Address: recipient.toString() as Hex },
      intent: rotation.intent,
      deployArgs: rotation.deployArgs,
      sipa: rotation.sipa,
      userOpHash: userOpHash(rotation),
    }
  }
  const liveFunding = (proverTip: bigint) =>
    fundingAmount(client, { tuple, plainWithdrawalExecutor, proverTip })
  /** The block the flow counts on: the settled depth behind the tip, read fresh each time. */
  const settledBlock = async () => {
    const head = await client.getBlockNumber()
    const block = await client.getBlock({ blockNumber: settledBlockNumber(head) })
    return { number: Number(block.number), hash: block.hash }
  }
  /** The one-key account under the root passkey alone: the move spends from it after the re-root. */
  let oneKey: Promise<ObsidionAccount> | undefined
  /** The signal of the send in flight: the account is built once, so its key reads it per request. */
  let sending: AbortSignal | undefined
  const oneKeyAccount = async (source: string) => {
    oneKey ??= wallet
      .createObsidionAccount(
        keys.secretKey,
        auth.providerFor({
          credentialId,
          pubkeyHex: rootPubkeyHex,
          passkeys: [rootPubkeyHex],
          signal: () => sending,
        }),
      )
      .catch((err: unknown) => {
        oneKey = undefined
        throw err
      })
    const account = await oneKey
    if (!sameHex(account.getAddress().toString(), source)) {
      throw new Error("the one-key account is not the signed change's")
    }
    return account
  }
  /** The signed change's source and destination, checked against the session and the saved plan. */
  const signedChange = async () => {
    const record = await store.get(owner)
    const change = signedChangeFor(record?.rotation, rootPubkeyHex)
    const destination = await twoKeyAddress(wallet, rootKey, change.add)
    if (!record?.plan || !sameHex(destination.toString(), record.plan.address)) {
      throw new Error("the signed change names another address")
    }
    return { ...change, destination }
  }
  /** The deposit address's sweeps and recoveries since `fromBlock`. */
  const observeDeposit = async (sipa: Address, fromBlock: number) => {
    const commitment = (await store.get(owner))?.rotation?.intent.recipientCommitment
    if (!commitment) throw new Error("no signed rotation to read the deposit address for")
    const head = await client.getBlockNumber()
    const { observed } = await observeSipas(client, {
      portals: [tuple.portal],
      tokens: [tuple.token],
      subjects: [{ address: sipa, commitment, fromBlock: BigInt(fromBlock), inflows: false }],
      head,
    })
    // A subject the observation could not read is left out of `observed`: that is no answer.
    const seen = observed.get(sipa.toLowerCase())
    if (!seen) throw new Error("the deposit address read did not complete")
    return seen
  }
  /**
   * The account factory the origin names. `recoverDeposit` refuses unless it predicts `owner` from
   * this session's bootstrap key, and the tuple's factory does not predict an account an earlier
   * generation's factory made.
   */
  const resolveOwnerFactory = async (): Promise<Address> => {
    const bootstrap = deriveBootstrapKey(keys.secretKey).address
    const predicts = (factory: Address) =>
      sameHex(predictAccountAddressLocally(factory, bootstrap), owner)
    if (predicts(env.env.factory)) return env.env.factory
    const generations = await loadOxideGenerations(wallet, contractService, session.page)
    const found = generationFactories(generations).find(predicts)
    if (!found) throw new Error("no account factory predicts the account from this wallet's keys")
    return found
  }
  let factory: Promise<Address> | undefined
  const ownerFactory = () =>
    (factory ??= resolveOwnerFactory().catch((err: unknown) => {
      factory = undefined
      throw err
    }))
  const depositInput = async (record: BackupRotationRecord) => ({
    session,
    record,
    l1ChainId: config.l1ChainId,
    networkId: wallet.networkId,
    token: tuple.token,
    sipaFactory: tuple.factory,
    accountFactory: await ownerFactory(),
  })
  /** The paylinks `account` made that the add takes back, from this device's links. */
  const linksOf = async (account: string) => {
    const { paylinks, operations } = session
    const [links, ops] = await Promise.all([
      loadRecords(paylinks.view),
      loadRecords(operations.view),
    ])
    const index = operationIndex(ops)
    return backupLinks(links, (link) => FUNDING_STATUS[withOperation(link, index).funding], {
      account,
      network: wallet.networkId,
      token: l2Token,
      nowSec: Math.floor(Date.now() / 1000),
    })
  }
  const fragmentOf = (link: PaylinkRecord) => (link.paylink ? linkFragmentOf(link.paylink) : null)
  /** Paylink calls as the one-key account: only the link's creator can take it back. */
  const linkDeps = async (): Promise<SponsoredPaylinkDeps> => {
    const account = await oneKeyAccount((await signedChange()).source)
    const [tokenService, teeSigner] = await Promise.all([
      l2TokenService(session.page, account, l2Token),
      chain.teeSignerOfToken(l2Token),
    ])
    tokenService.setTeeSigner(teeSigner)
    return {
      account,
      tokenService,
      teeSigner,
      rollupAddress: wallet.networkId,
      session,
    }
  }
  /** Reads pinned to one block, for the portal's release check at the settled block. */
  const clientAt = (blockNumber: number) =>
    ({
      ...client,
      readContract: (args: Parameters<PublicClient["readContract"]>[0]) =>
        client.readContract({ ...args, blockNumber: BigInt(blockNumber) } as never),
    } as PublicClient)

  return {
    store,
    now: Date.now,
    mintAttemptId: () => crypto.randomUUID(),
    activeSince: session.page.activeSince.get(),
    session: WALLET_LIFE,

    verify: (rotation) =>
      verifyPersistedRotation(client, rotation, tuple, {
        derive: (set) =>
          wallet.deriveAccountAddress(
            keys.secretKey,
            set.map((key) => `${key.qx.slice(2)}${key.qy.slice(2)}`),
          ),
        publicKey: deriveStealthKey(keys.secretKey).publicKey,
      }),
    fundability: async (rotation) =>
      readRotationFundability(client, {
        rotation: await rotationIntent(rotation),
        expectedKeys: rotation.expectedKeys,
        builtOver: rotation.builtOver,
        add: rotation.add,
        implementation: rotation.implementation,
        sipaFactory: tuple.factory,
        metadataRegistry: tuple.metadataRegistry,
      }),
    // The sweep is quoted over what the deposit address holds once the saved funding is released,
    // against the route's charges read live, with the tip the funding carried.
    route: async (rotation) => {
      try {
        const plan = (await store.get(owner))?.plan
        const live = await liveFunding(BigInt(plan?.proverTip ?? 0))
        const funding = sweepFunding(live, plan?.fundingAmount)
        if (funding === undefined) return "route"
        const operation = await buildBackupSweep(
          client,
          await rotationIntent(rotation),
          rotation.signature,
          tuple,
        )
        const quote = await quoteSweep(client, tuple, {
          operation,
          owner,
          sipa: rotation.sipa,
          funding,
        })
        assertBackupSweepProfitable(quote)
        return "ok"
      } catch (err) {
        if (backupSweepRefused(err)) return "route"
        throw err
      }
    },

    l1: {
      settledBlock,
      isSettled: async ({ blockNumber, blockHash }) => {
        const [at, head] = await Promise.all([
          client.getBlock({ blockNumber: BigInt(blockNumber) }),
          client.getBlockNumber(),
        ])
        return at.hash === blockHash && settledBlockNumber(head) >= BigInt(blockNumber)
      },
      txBlock: async (hash) => {
        const receipt = await client.getTransactionReceipt({ hash }).catch((err) => {
          if (err instanceof TransactionReceiptNotFoundError) return undefined
          throw err
        })
        return receipt && { blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash }
      },
      sipaBalance: async (sipa, at) =>
        readTokenBalanceAt(
          client,
          tuple.token,
          sipa,
          at === "latest" ? at : BigInt((at ?? (await settledBlock())).number),
        ),
      sweep: async (sipa, fromBlock) => {
        const sweep = (await observeDeposit(sipa, fromBlock)).sweeps[0]
        if (!sweep) return undefined
        return {
          index: sweep.index.toString(),
          blockNumber: Number(sweep.blockNumber),
          blockHash: sweep.blockHash,
          credited: sweep.amount,
        }
      },
      recovery: async (sipa, fromBlock) =>
        (await observeDeposit(sipa, fromBlock)).recoveries.at(-1)?.txHash,
      releaseSettled: (withdrawalId, at) =>
        isWithdrawalSpent(clientAt(at.number), tuple.portal, withdrawalId as Hex),
    },
    node: walletOutcomeNode(wallet),
    tracker: {
      row: async (localId) => {
        await session.withdrawals.ready
        const row = await session.withdrawals.get(localId)
        return row
          ? {
              phase: row.phase,
              l2TxHash: row.l2TxHash,
              withdrawalId: row.withdrawalId,
              startTime: row.startTime,
              recipient: row.recipient,
            }
          : undefined
      },
      // The funding's burn runs as an operation, whose hash commits with the row's.
      stamp: async (localId, txHash) => {
        await session.withdrawals.ready
        await stampWithdrawal(session, localId, txHash)
      },
    },

    prepare: async (record) => {
      const envelopeHex = record.backup.envelopeHex
      if (!envelopeHex) throw new Error("the backup's envelope has left the record")
      const identity = session.identity.get().value
      if (!identity) throw new Error("no wallet identity")
      const add: BackupPasskeyAdd = {
        pubkey: pubkeyToR1KeyArg(record.backup.pubkeyHex),
        credentialId: bytesToHex(base64UrlToBytes(record.backup.credentialId)),
        envelope: `0x${envelopeHex}`,
      }
      const recipient = await twoKeyAddress(wallet, rootKey, record.backup.pubkeyHex)
      const [prepared, funding, takesMs, balances, head, links] = await Promise.all([
        prepareBackupRotation(client, {
          tuple,
          owner,
          rootKey: pubkeyToR1KeyArg(rootPubkeyHex),
          recordExpected: {
            l2Address: identity.address as Hex,
            rollupVersion: tuple.rollupVersion,
          },
          add,
          recipient,
        }),
        liveFunding(0n),
        readBackupAddTakesMs(session.burnDurations, session.page, wallet.node),
        readMoveBalances(chain, wallet, contractService, keys.account.getAddress()),
        client.getBlockNumber(),
        linksOf(keys.account.getAddress().toString()).then(({ open }) => open),
      ])
      const { rotation } = prepared
      const refunds = links.map((row) => row.amountAtomic)
      return {
        prepared: {
          owner,
          intent: rotation.intent,
          sharedSecretSalt: rotation.sharedSecretSalt,
          nonce: rotation.intent.nonce,
          builtOver: prepared.builtOver,
          expectedKeys: prepared.expectedKeys,
          implementation: prepared.implementation,
          deployArgs: rotation.deployArgs,
          sipa: rotation.sipa,
          add: prepared.add,
        },
        plan: {
          address: recipient.toString(),
          fundingAmount: funding.amount.toString(),
          deposited: depositedAmount(funding, funding.amount).toString(),
          credited: funding.credited.toString(),
          approvals: 1,
          refunds: links.length,
          // Main Account's token comes first, and the refunds land in it.
          moves: moveCount(
            balances.map((b, i) => (i === 0 ? { ...b, shape: withNotes(b.shape, refunds) } : b)),
          ),
          takesMs,
        },
        fromBlock: Number(head),
      }
    },
    fundable: () =>
      withTimeout(
        Promise.all([
          getWebOxideToken(wallet, contractService, l2Token).then((oxide) =>
            readSpendShape(wallet, oxide, keys.account.getAddress()),
          ),
          moveCap(chain, l2Token),
        ]).then(([shape, cap]) => {
          const deposits = unreadDeposits(shape)
          return (amount: bigint) => fundingFits(amount, cap, shape, deposits).kind === "fits"
        }),
        FIT_ANSWER_WITHIN_MS,
      ),
    sign: async (prepared) => {
      const passkey = await oxideAccountPasskey(keys.authProvider)
      if (!passkey) throw new Error("the session key is not a passkey")
      const recipient = await twoKeyAddress(wallet, rootKey, addPubkeyHex(prepared.add))
      return signAccountUserOp(
        { client, passkey },
        { intent: prepared.intent, userOpHash: userOpHash(prepared) },
        {
          owner,
          metadataRegistry: tuple.metadataRegistry,
          namePortal: tuple.namePortal,
          rollupVersion: tuple.rollupVersion,
          add: prepared.add,
          record: prepared.builtOver,
          recipient: recipient.toString() as Hex,
        },
      )
    },
    publish: async (record, rotation) =>
      publishRotationAddress({ ...(await depositInput(record)), owner, rotation }),
    strandedDeposit: async (record) => {
      const { sipaAddress } = await seedRotationDeposit(await depositInput(record))
      return readStrandedToken(session, sipaAddress, tuple.token, wallet.networkId).catch(
        (err: unknown) => {
          if (err instanceof EmptyDepositError) throw err
          throw new DepositReadError(errorMessage(err))
        },
      )
    },
    republish: async (record) => {
      await republishRotationAddress(session, owner, record, async () =>
        Number(await wallet.node.getBlockNumber()),
      )
    },
    fund: async (record, funding, onTxHash) => {
      const plan = record.plan
      const sipa = record.rotation?.sipa
      if (!plan || !sipa) throw new Error("nothing signed to fund")
      const amount = BigInt(plan.fundingAmount)
      const proverTip = BigInt(plan.proverTip ?? 0)
      const tokenService = await sponsoredTokenService(session.page, keys.account, l2Token)
      const [token, sponsor, deployment, withdrawalFee] = await Promise.all([
        tokenService.fetchTokenInformation(),
        claimSponsorContext(sponsorDeps, RAIL_REGISTERED),
        currentDeployment(envTuple),
        withdrawalExecutorFee(chain, envTuple),
      ])
      const { result } = await runOperation(
        session,
        {
          operationId: nextOperationId("withdraw"),
          flow: "withdraw",
          summary: "Backup passkey funding",
        },
        (op) =>
          runBurn({
            op,
            session,
            localId: funding.localId,
            record: {
              intent: "backup",
              recipient: sipa,
              recipientProvenance: "saved-recipient",
              amount: formatUnits(amount, token.decimals),
              rawAmount: amount.toString(),
              relayerTip: WITHDRAW_RELAYER_TIP.toString(),
              // What the add's cost is checked against: the release is the gross less these.
              withdrawalFee: withdrawalFee.toString(),
              ...(proverTip ? { proverTip: proverTip.toString() } : {}),
              tokenSymbol: token.symbol,
              tokenDecimals: token.decimals,
              phase: "submitting",
              startTime: Date.now(),
              deployment,
            },
            burn: () =>
              tokenService.exitToL1PrivateSponsored(
                EthAddress.fromString(sipa),
                amount.toString(),
                sponsor,
                {
                  userAccount: keys.account,
                  useRawAmount: true,
                  withdrawal: withdrawalOptions(config, envTuple),
                  proverTip,
                  operationId: op.operationId,
                  onTxHash,
                },
              ),
            reportContext: "backup:fund",
          }),
      )
      if (!result) return
      noteSponsoredMine(sponsorDeps, sponsor, "funding")
    },
    reroot: (record, checkpoint) =>
      rerootToPasskeySet(
        rerootDeps({
          session,
          wallet,
          secretKey: keys.secretKey,
          oneKeyAddress: keys.account.getAddress().toString(),
          root: { credentialId, pubkeyHex: rootPubkeyHex },
          switchAccount: input.switchAccount ?? (() => {}),
        }),
        record,
        checkpoint,
      ),
    move: {
      tokens: () => backupMoveTokens(chain),
      shape: async (token) => {
        const { source } = await signedChange()
        return readSpendShape(
          wallet,
          await getWebOxideToken(wallet, contractService, token),
          (await oneKeyAccount(source)).getAddress(),
        )
      },
      // Stored deposits are not enumerated: a balance held in them moves as note-only chunks, then one attempt.
      deposits: async (_token, shape) => unreadDeposits(shape),
      cap: (token) => moveCap(chain, token),
      // The sponsor refuses a send past the allowance; nothing is read ahead.
      usesLeft: async () => true,
      send: async (token, amount, onTxHash, signal) => {
        sending = signal
        try {
          const { source, destination } = await signedChange()
          const acting = await oneKeyAccount(source)
          const [tokenService, sponsor] = await Promise.all([
            sponsoredTokenService(session.page, acting, token),
            claimSponsorContext({ ...sponsorDeps, account: acting }, RAIL_REGISTERED),
          ])
          await tokenService.sendTokenSponsored(destination, amount.toString(), sponsor, {
            userAccount: acting,
            useRawAmount: true,
            onTxHash,
          })
          session.oweFpcRefuel({ address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact })
        } finally {
          sending = undefined
        }
      },
      // The link is found by its secret, which a refund and a rebuilt history both keep. A
      // claimed link is listed while no checkpoint holds its claim, so the flow waits on it.
      links: async () => {
        const { open, claimed } = await linksOf((await signedChange()).source)
        const unsettled = await Promise.all(
          claimed.map(async (link) => {
            const fragment = fragmentOf(link)
            const spend =
              fragment &&
              (await linkRefundable({ session, wallet, contractService }, link, fragment))
            return spend && spend !== "spent" ? fragment : null
          }),
        )
        return [...open.map(fragmentOf), ...unsettled].filter((f): f is string => !!f)
      },
      refundable: async (fragment) =>
        linkRefundable(
          { session, wallet, contractService },
          await creatorLinkFor(session, fragment),
          fragment,
        ),
      refund: async (fragment, onTxHash, signal) => {
        sending = signal
        try {
          await recoverSponsoredLink(await linkDeps(), fragment, undefined, onTxHash)
        } finally {
          sending = undefined
        }
      },
      declined: passkeyDeclined,
    },
  }
}

function quoteSweep(
  client: PublicClient,
  tuple: BackupRotationTuple,
  args: {
    operation: Awaited<ReturnType<typeof buildBackupSweep>>
    owner: Address
    sipa: Address
    funding: bigint
  },
) {
  return quoteBackupSweep(client, {
    operation: args.operation,
    executor: tuple.operationExecutor,
    sender: args.owner,
    sipa: args.sipa,
    token: tuple.token,
    depositSubsidy: tuple.depositSubsidy,
    funding: args.funding,
  })
}

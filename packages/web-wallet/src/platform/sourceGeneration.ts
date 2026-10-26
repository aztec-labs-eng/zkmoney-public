import {
  SOURCE_GENERATION_PROTOCOL,
  type SourceAccountKeys,
  type SourceGenerationModule,
  type SourceGenerationSession,
} from "@obsidion/core/types"
import { createNode, WebAuthnAlphaAuthProvider, type ObsidionAccount } from "@obsidion/sdk"
import { getConfig } from "../config/env"
import { getAuthService } from "./auth/useAuthenticator"

/** Where the build serves each source generation's bundle, by Aztec major version. */
const BUNDLES: Readonly<Record<string, string>> = { "5": "generations/v5/index.js" }

const majorOf = (version: string) => version.replace(/^v/, "").split(".")[0]!

const identities = new Map<string, Promise<{ major: string; rollupAddress: string }>>()

/** The Aztec major version and L1 rollup a node runs. `getNodeInfo` reads the same on every version. */
function nodeIdentity(nodeUrl: string) {
  let identity = identities.get(nodeUrl)
  if (!identity) {
    const config = getConfig()
    const apiKey = nodeUrl === config.nodeUrl ? config.nodeApiKey : config.sourceRollupApiKey
    identity = createNode(nodeUrl, apiKey)
      .getNodeInfo()
      .then((info) => ({
        major: majorOf(info.nodeVersion),
        rollupAddress: info.l1ContractAddresses.rollupAddress.toString().toLowerCase(),
      }))
    identities.set(nodeUrl, identity)
    identity.catch(() => identities.delete(nodeUrl))
  }
  return identity
}

/** The Aztec major version a node runs. */
export function nodeAztecMajor(nodeUrl: string): Promise<string> {
  return nodeIdentity(nodeUrl).then((identity) => identity.major)
}

/**
 * The Aztec major version of the source rollup at `rollupAddress` when it differs from the active
 * node's. Undefined for the active generation, or a rollup no profile version names or whose node
 * does not answer.
 */
export async function retiredRollupMajor(rollupAddress: string): Promise<string | undefined> {
  const address = rollupAddress.toLowerCase()
  for (const { nodeUrl } of getConfig().sourceRollups ?? []) {
    const identity = await nodeIdentity(nodeUrl).catch(() => undefined)
    if (identity?.rollupAddress !== address) continue
    const active = await nodeAztecMajor(getConfig().nodeUrl).catch(() => undefined)
    return identity.major !== active ? identity.major : undefined
  }
  return undefined
}

/** Whether `nodeUrl` runs another Aztec major version than the active node. */
export async function isOtherGeneration(nodeUrl: string): Promise<boolean> {
  const [source, active] = await Promise.all([
    nodeAztecMajor(nodeUrl),
    nodeAztecMajor(getConfig().nodeUrl),
  ])
  return source !== active
}

const modules = new Map<string, Promise<SourceGenerationModule>>()

/** The bundle built for Aztec `major`, loaded once. */
export function loadSourceGeneration(major: string): Promise<SourceGenerationModule> {
  let loaded = modules.get(major)
  if (!loaded) {
    loaded = importBundle(major)
    modules.set(major, loaded)
    loaded.catch(() => modules.delete(major))
  }
  return loaded
}

async function importBundle(major: string): Promise<SourceGenerationModule> {
  const path = BUNDLES[major]
  if (!path) throw new Error(`This build cannot read an Aztec ${major} network`)
  // From the app's root, not the current route's.
  const root = new URL(import.meta.env.BASE_URL, window.location.origin)
  const module = (await import(
    /* @vite-ignore */ new URL(path, root).href
  )) as SourceGenerationModule
  return checkedModule(major, module)
}

/** `module`, if it serves this build's protocol for Aztec `major`. */
export function checkedModule(major: string, module: SourceGenerationModule) {
  if (module.protocol !== SOURCE_GENERATION_PROTOCOL)
    throw new Error(
      `The Aztec ${major} bundle speaks protocol ${module.protocol}, ` +
        `not ${SOURCE_GENERATION_PROTOCOL}`,
    )
  if (majorOf(module.aztecVersion) !== major)
    throw new Error(`The Aztec ${major} bundle is built for Aztec ${module.aztecVersion}`)
  return module
}

type SourceSign = SourceAccountKeys["passkey"]["sign"]

let signThrough: ((sign: SourceSign) => SourceSign) | undefined
let signerTurn: Promise<unknown> = Promise.resolve()

/**
 * Runs `step` with every passkey prompt of a source generation going through `wrap`. Runs share
 * one session's keys, so each step waits for the one before it.
 */
export function withSourceSigner<T>(
  wrap: (sign: SourceSign) => SourceSign,
  step: () => Promise<T>,
): Promise<T> {
  const run = signerTurn.then(async () => {
    signThrough = wrap
    try {
      return await step()
    } finally {
      signThrough = undefined
    }
  })
  signerTurn = run.catch(() => {})
  return run
}

/** The unlocked account's keys, in the plain form a source generation takes. */
export async function sourceAccountKeys(account: ObsidionAccount): Promise<SourceAccountKeys> {
  const secretKey = await getAuthService().getSecretKey()
  if (!secretKey) throw new Error("Unlock the wallet to read the old network")
  const auth = account.getAuthProvider()
  if (!(auth instanceof WebAuthnAlphaAuthProvider))
    throw new Error("The old network is read with the account's passkey")
  const [x, y] = await auth.getPubkeys()
  const sign: SourceSign = (challenge) => auth.signChallenge(Buffer.from(challenge))
  return {
    secretKey: secretKey.toString(),
    passkey: {
      publicKey: { x: `0x${x.toString("hex")}`, y: `0x${y.toString("hex")}` },
      sign: (challenge) => (signThrough?.(sign) ?? sign)(challenge),
    },
  }
}

const sessions = new Map<string, Promise<SourceGenerationSession>>()

/** The account on another generation's rollup: one session per node for the page's lifetime. */
export function openSourceGenerationSession(
  nodeUrl: string,
  account: ObsidionAccount,
): Promise<SourceGenerationSession> {
  const key = `${nodeUrl}\n${account.getAddress()}`
  let session = sessions.get(key)
  if (!session) {
    session = open(nodeUrl, account)
    sessions.set(key, session)
    session.catch(() => sessions.delete(key))
  }
  return session
}

async function open(nodeUrl: string, account: ObsidionAccount) {
  const config = getConfig()
  const rollup = config.sourceRollups?.find((r) => r.nodeUrl === nodeUrl)
  if (!rollup) throw new Error(`No profile version names the node ${nodeUrl}`)
  const module = await loadSourceGeneration(await nodeAztecMajor(nodeUrl))
  return module.open({
    account: await sourceAccountKeys(account),
    nodeUrl,
    nodeApiKey: config.sourceRollupApiKey,
    l1RpcUrl: config.l1RpcUrl,
    l1ChainId: config.l1ChainId,
    network: config.network,
    contracts: rollup.contracts,
    artifacts: rollup.artifacts,
    proverEnabled: config.proverEnabled,
  })
}

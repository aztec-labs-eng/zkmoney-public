import { seedDemo as actual } from "../../../src/dev/seedDemo"
import { DEMO_OXIDE_DEPLOYMENT, DEMO_OXIDE_TUPLE } from "../../../src/dev/demoFixtures"
import { isDemoMode } from "../../../src/dev/demoFlag"
import { installFakeEthereum } from "../../../src/dev/fakeEthereum"
import { installL1RpcStub } from "../../../src/dev/fakeL1Rpc"
import { captureOn, captureSession, fixtureState } from "./control"
import { seedRegistration } from "./registration-seed"
import { seedProcessing } from "./processing-seed"
import { entryPath, TOKEN, SIPA } from "./data"
import { desktopState, installDesktopBridge, seedPublishedAddress } from "./desktop"
import { parseUnits } from "viem"
import { WalletError } from "@obsidion/front-core"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { DEMO_COMPLETE_ADDRESS, DEMO_L2_TOKEN } from "../../../src/dev/demoFixtures"
import { saveIdentity } from "../../../src/session/account"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"
import { backupFixture, keyPubkey, sessionPubkeyHex } from "./backup-passkey"
export * from "../../../src/dev/seedDemo"
export const seedDemo: typeof actual = async (scenario, boot, _primed, pace) => {
  // The swap stack's contracts, so the withdrawal offers its swapped coins and gas step.
  const tuple = {
    ...DEMO_OXIDE_TUPLE,
    l2Token: TOKEN,
    swapEscrowFactoryV2: SIPA,
    operationExecutor: "0x0e5e000000000000000000000000000000000e5e",
    accountFactory: "0xacc0000000000000000000000000000000000fac",
    l2Broadcaster: `0x${"b0".repeat(32)}`,
  }
  const seeded = await actual(
    scenario,
    boot,
    fixtureState() ? { tuple, deployment: DEMO_OXIDE_DEPLOYMENT } : undefined,
    pace,
  )
  if (seeded) captureOn(seeded)
  if (!seeded || !isDemoMode() || !fixtureState()) return seeded
  const session = captureSession()
  const { config } = boot
  if (scenario === "onboarding")
    installL1RpcStub(config.l1RpcUrl, installFakeEthereum(config.l1ChainId))
  const query = new URLSearchParams(location.search)
  const registration = query.get("registrationFixture")
  if (registration) await seedRegistration(session, registration)
  // `?identityFixture=pending`: the seeded tag is still registering, as after a signup.
  const identity = query.get("identityFixture")
  if (identity) {
    if (identity !== "pending") throw new Error(`Unknown identity fixture: ${identity}`)
    const current = session.identity.get().value
    if (current) await saveIdentity(seeded, { ...current, pending: true })
  }
  const processing = query.get("processingFixture")
  if (processing) await seedProcessing(session, processing)
  // `?balanceFixture=<tokens>` replaces the seeded wallet balance.
  const balance = query.get("balanceFixture")
  if (balance) {
    if (!/^\d+(\.\d+)?$/.test(balance)) throw new Error(`Unknown balance fixture: ${balance}`)
    const { balanceStore } = session
    if (!balanceStore) throw new WalletError("wallet.notReady", "the balance fixture seeds an account session")
    const scope = `${config.network}:${DEMO_COMPLETE_ADDRESS}`
    const atomic = parseUnits(balance, 18)
    await balanceStore.write(scope, DEMO_L2_TOKEN, atomic, undefined, undefined, WALLET_TOKEN_SYMBOL)
  }
  // `?backupFixture=<name>`: the names the fixture's keys carry on this device.
  const backup = backupFixture()
  if (backup && typeof backup.keys === "object") {
    const own = await sessionPubkeyHex()
    const names = Object.fromEntries(
      backup.keys.flatMap((key) => (key.name ? [[keyPubkey(key, own), key.name]] : [])),
    )
    await writeDeviceKeys(seeded.database, { passkeyNames: JSON.stringify(names) })
  }
  if (desktopState()) {
    installDesktopBridge()
    await seedPublishedAddress(session, SIPA)
  }
  const entry = query.get("flowEntry")
  if (entry) {
    const destination = new URL(entryPath(entry), location.origin)
    query.delete("flowEntry")
    destination.search = query.toString()
    history.replaceState(history.state, "", destination)
  }
  return seeded
}

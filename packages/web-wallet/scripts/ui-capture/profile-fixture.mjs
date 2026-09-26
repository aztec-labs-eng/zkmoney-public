import { configProfileSchema } from "@obsidion/config-client"
import * as oxide from "@obsidion/core/oxide"

export const DEMO_PORTAL = "0xde1100000000000000000000000000000000da01"
const timestamp = "2026-08-01T09:00:00.000Z"
const field = (n) => `0x${n.toString(16).padStart(64, "0")}`

function profileFor(pointer) {
  return {
    profileId: "ui-capture",
    network: "sandbox",
    publishedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    shared: { l1ChainId: 31337, xmtpEnv: "local", rollupVersion: "1821665230" },
    current: "0.0.1",
    versions: {
      "0.0.1": {
        schemaVersion: "1",
        deployedAt: "2026-08-12T00:00:00.000Z",
        nodeUrl: "http://node.ui-capture.invalid",
        l1RpcUrl: "http://l1.ui-capture.invalid",
        accountServiceUrl: "http://account.ui-capture.invalid",
        zkmoneyApiUrl: "http://analytics.ui-capture.invalid",
        paylinkDomain: "http://paylink.ui-capture.invalid",
        oxide: pointer,
        contracts: {
          accountFactory: { address: "0x2c5eabc1c0ff859900efbe47a55e8f171d6ac001" },
          obsidionAccountAlpha: { classId: field(102) },
          paylinkDirect: { classId: field(106) },
          paylinkEmail: { classId: field(107) },
          claimFpc: { classId: field(108), address: field(109) },
        },
      },
    },
  }
}

// Fixture data only. The installed public schema selects its own supported pointer shape.
// Never combine both strict shapes or strip validation errors from a served profile.
export function captureFixtures(manifestUrl) {
  const candidates = [
    { kind: "legacy", pointer: { manifestUrl, stack: "v5", expectedEntryTimestamp: timestamp } },
    { kind: "portal", pointer: { manifestUrl, portal: DEMO_PORTAL } },
  ].map(({ kind, pointer }) => ({ kind, result: configProfileSchema.safeParse(profileFor(pointer)) }))
  const accepted = candidates.filter(({ result }) => result.success)
  if (accepted.length !== 1) {
    const details = candidates.map(({ kind, result }) => `${kind}: ${result.success ? "accepted" : result.error.message}`).join("\n")
    throw new Error(`Capture profile needs exactly one supported public schema variant.\n${details}`)
  }
  const { kind, result } = accepted[0]
  if (kind === "legacy") {
    // The old client only reads this endpoint for its timestamp advisory. This is not a
    // complete transaction manifest; demo boot primes the existing tuple separately.
    return { kind, profile: result.data, manifest: { versions: { v5: { current: { timestamp } } } } }
  }
  const manifest = {
    schemaVersion: "4",
    deployments: [{
      label: "demo", deployedAt: timestamp, updatedAt: timestamp, gitSha: "0".repeat(40),
      portal: DEMO_PORTAL, chainId: "31337", rollupVersion: "1",
      token: "0xb0de1000000000000000000000000000000b01d0", l2Token: `0x${"5c".repeat(32)}`,
      enclaveUrl: "https://enclave.invalid", pcr0: "0".repeat(96),
      sipaFactory: "0x5117a0000000000000000000000000000000fac7",
      sipaResolver: "0x8e50100000000000000000000000000000005e12",
      nameRegistry: "0x1e61000000000000000000000000000000015ada",
      depositFeeStore: "0xfee500000000000000000000000000000000f0ee",
      depositSubsidy: "0x5ab500000000000000000000000000000000d1da",
      withdrawalSubsidy: "0x5ab500000000000000000000000000000000d1db",
      plainWithdrawalExecutor: "0xe8ec000000000000000000000000000000000e8c",
    }],
  }
  // Use the same public sandbox extraction as the wallet. Production policy stays in its
  // existing consumers; this local fixture cannot certify a live deployment or transaction.
  if (typeof oxide.extractPinnedOxideEnvTuple !== "function") throw new Error("The portal profile requires the public v4 manifest extractor")
  oxide.extractPinnedOxideEnvTuple(manifest, result.data.versions["0.0.1"].oxide)
  return { kind, profile: result.data, manifest }
}

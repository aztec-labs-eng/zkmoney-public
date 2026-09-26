import { ZKJWT_VKEY_HASH } from "@obsidion/core/constants"

export const F32 = (n: number) => "0x" + n.toString(16).padStart(64, "0")
export const PORTAL = "0x92308cE04e2416f20b03e941a14F9238C3603334"

/** A valid sandbox profile with one version; tests mutate a copy. */
export function sandboxProfile(): any {
  return {
    profileId: "sandbox",
    network: "sandbox",
    publishedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    shared: {
      l1ChainId: 31337,
      xmtpEnv: "local",
      rollupVersion: "1821665230",
    },
    current: "0.0.1",
    versions: {
      "0.0.1": {
        schemaVersion: "1",
        gitSha: "c".repeat(40),
        deployedAt: "2026-08-12T00:00:00.000Z",
        nodeUrl: "http://profile-node.test",
        l1RpcUrl: "http://profile-l1.test",
        accountServiceUrl: "http://profile-account.test",
        zkmoneyApiUrl: "http://profile-analytics.test",
        paylinkDomain: "http://profile-paylink.test",
        oxide: {
          manifestUrl: "http://profile-oxide.test/sandbox.json",
          portal: PORTAL,
        },
        contracts: {
          accountFactory: { address: "0x2c5eabc1c0ff859900efbe47a55e8f171d6ac001" },
          obsidionAccountAlpha: { classId: F32(102) },
          paylinkDirect: { classId: F32(106) },
        },
        vkeys: { zkJwtVkeyHash: ZKJWT_VKEY_HASH },
      },
    },
  }
}

/** The same document on testnet, with every endpoint https as the schema demands there. */
export function testnetProfile(): any {
  const profile = sandboxProfile()
  profile.profileId = "staging-v5"
  profile.network = "testnet"
  profile.shared.l1ChainId = 11155111
  profile.versions["0.0.1"] = {
    ...profile.versions["0.0.1"],
    nodeUrl: "https://node.example",
    l1RpcUrl: "https://l1.example",
    accountServiceUrl: "https://account.example",
    zkmoneyApiUrl: "https://api.example",
    paylinkDomain: "https://paylink.example",
    oxide: {
      ...profile.versions["0.0.1"].oxide,
      manifestUrl: "https://manifest.example/staging.v4.json",
    },
  }
  return profile
}

/** A fetch double answering `status` with `document`. */
export function serve(document: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status <= 299,
    status,
    json: async () => document,
  })) as unknown as typeof fetch
}

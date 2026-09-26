/**
 * A minimal valid profile, shaped like a real one but owned by this package. The documents the
 * host ships are its contract with publishing; this is the schema's contract with consumers, so
 * the two move independently.
 */
const F32 = (n: number) => "0x" + n.toString(16).padStart(64, "0")

export function stagingDoc(): any {
  return {
    profileId: "staging-v5",
    network: "testnet",
    publishedAt: "2026-08-11T00:00:00.000Z",
    shared: {
      l1ChainId: 11155111,
      xmtpEnv: "dev",
      rollupVersion: "1821665230",
    },
    current: "0.0.2",
    versions: {
      // An earlier deployment, predating claimFpc and carrying no oxide pin — key sets and
      // optional fields differ per version by design.
      "0.0.1": {
        schemaVersion: "1",
        gitSha: "b".repeat(40),
        deployedAt: "2026-07-02T00:00:00.000Z",
        nodeUrl: "https://v1-node.example",
        l1RpcUrl: "https://v1-l1.example",
        accountServiceUrl: "https://v1-account.example",
        zkmoneyApiUrl: "https://v1-api.example",
        paylinkDomain: "https://v1-paylink.example",
        oxide: {
          manifestUrl: "https://manifest.example/staging.v4.json",
          portal: "0x92308cE04e2416f20b03e941a14F9238C3603334",
        },
        contracts: {
          adminAccount: { address: F32(11), classId: F32(111) },
          obsidionAccountAlpha: { classId: F32(112) },
          oidcKeyRegistry: { address: F32(13), classId: F32(113) },
          sponsorFPC: { address: F32(14), classId: F32(114) },
        },
        vkeys: { zkJwtVkeyHash: F32(210) },
      },
      "0.0.2": {
        schemaVersion: "1",
        gitSha: "a".repeat(40),
        deployedAt: "2026-08-11T00:00:00.000Z",
        nodeUrl: "https://node.example",
        l1RpcUrl: "https://l1.example",
        accountServiceUrl: "https://account.example",
        zkmoneyApiUrl: "https://api.example",
        paylinkDomain: "https://paylink.example",
        oxide: {
          manifestUrl: "https://manifest.example/staging.v4.json",
          portal: "0x92308cE04e2416f20b03e941a14F9238C3603334",
          expectedGitSha: "5e839cdbfedb7cba359c20efa0324d52ab3af184",
        },
        contracts: {
          // A second L1 entry — L1 rows never reach a snapshot's L2 map.
          stealthPortal: { address: "0x11196a10ae4ceff9d44b40e254c039e6dd974111" },
          adminAccount: { address: F32(1), classId: F32(101) },
          obsidionAccountAlpha: { classId: F32(102) },
          oidcKeyRegistry: { address: F32(3), classId: F32(103) },
          sponsorFPC: { address: F32(4), classId: F32(104) },
          claimFpc: {
            address: F32(5),
            classId: F32(105),
            meta: { policyManifest: { root: F32(9), entries: [] } },
          },
          paylinkDirect: { classId: F32(106) },
          paylinkEmail: { classId: F32(107) },
        },
        vkeys: { zkJwtVkeyHash: F32(200) },
      },
    },
  }
}

export function withVersions(...ids: string[]): any {
  const doc = stagingDoc()
  const seed = doc.versions["0.0.2"]
  doc.versions = Object.fromEntries(ids.map((id) => [id, JSON.parse(JSON.stringify(seed))]))
  doc.current = ids[0]
  return doc
}

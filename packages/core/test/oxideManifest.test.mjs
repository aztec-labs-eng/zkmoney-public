import assert from "node:assert/strict"
import { test } from "node:test"
import { MAINNET_ENS_DOMAIN, MAINNET_ENTRY_POINT, Network } from "../dist/constants/index.js"
import { loadOxideManifestTuple } from "../dist/oxide/index.js"

const MANIFEST_URL = "https://oxide.example/manifest.json"
const GIT_SHA = "c92f24e54e11222d5255e653d673851122cbbf04"
const PORTAL = "0x1E6142c98D83c8D14b09668d90583E940A646458"
const RAW_ENTRY_POINT = "0x00000000000000000000000000000000000000e7"

function manifest(overrides = {}) {
  return {
    schemaVersion: "4",
    deployments: [
      {
        schemaVersion: "1",
        label: "v1",
        gitSha: GIT_SHA,
        deployedAt: "2026-07-13T20:24:20.754Z",
        updatedAt: "2026-07-13T20:24:20.754Z",
        portal: PORTAL,
        token: "0x6440f144b7e50D6a8439336510312d2F54beB01D",
        nameRegistry: "0xee17cff830cd8344d3908c2e07f1a57d9605efb6",
        accountFactory: "0x00000000000000000000000000000000000000a2",
        entryPoint: RAW_ENTRY_POINT,
        ensDomain: "oxidestaging.eth",
        resolverGatewayUrl: "https://resolver.example/{sender}/{data}.json",
        plainWithdrawalExecutor: "0x55021D52991974d60cdee55CB009C1b9d36c515A",
        l2Token: "0x2fbdc2a4303c9855eb39b14091d57cee8575692925ffbac5c7e3e1b1e62a20c8",
        l2Broadcaster: "0x087a42cac485b38d91202fe949fb2933f20185ba7a2fb1de860500379b1350c8",
        enclaveUrl: "https://enclave.example/rpc",
        rollupVersion: "2934756905",
        chainId: "1",
        ...overrides,
      },
    ],
  }
}

function jsonFetch(body, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
}

test("loadOxideManifestTuple returns the manifest values unchanged off mainnet", async () => {
  const tuple = await loadOxideManifestTuple({
    manifestUrl: MANIFEST_URL,
    portal: PORTAL,
    network: Network.TESTNET,
    fetchImpl: jsonFetch(manifest()),
  })

  assert.equal(tuple.ensDomain, "oxidestaging.eth")
  assert.equal(tuple.entryPoint, RAW_ENTRY_POINT)
})

test("loadOxideManifestTuple reads the deployment's Sky escrow factory", async () => {
  const factory = "0x00000000000000000000000000000000000000f5"
  const tuple = await loadOxideManifestTuple({
    manifestUrl: MANIFEST_URL,
    portal: PORTAL,
    network: Network.TESTNET,
    fetchImpl: jsonFetch(manifest({ skyEscrowFactory: factory })),
  })

  assert.equal(tuple.skyEscrowFactory, factory)
})

test("loadOxideManifestTuple gates and overlays the pinned mainnet entry", async () => {
  const tuple = await loadOxideManifestTuple({
    manifestUrl: MANIFEST_URL,
    portal: PORTAL,
    network: Network.MAINNET,
    expectedGitSha: GIT_SHA,
    fetchImpl: jsonFetch(manifest({ entryPoint: undefined, ensDomain: undefined })),
  })

  assert.equal(tuple.entryPoint, MAINNET_ENTRY_POINT)
  assert.equal(tuple.ensDomain, MAINNET_ENS_DOMAIN)
  assert.equal(tuple.portal, PORTAL)
  assert.equal(Object.isFrozen(tuple), true)
})

test("loadOxideManifestTuple enforces the pinned git SHA on mainnet", async () => {
  await assert.rejects(
    loadOxideManifestTuple({
      manifestUrl: MANIFEST_URL,
      portal: PORTAL,
      network: Network.MAINNET,
      expectedGitSha: "0".repeat(40),
      fetchImpl: jsonFetch(manifest()),
    }),
    /gitSha/,
  )
})

test("loadOxideManifestTuple reports the URL and status for an HTTP failure", async () => {
  await assert.rejects(
    loadOxideManifestTuple({
      manifestUrl: MANIFEST_URL,
      portal: PORTAL,
      network: Network.TESTNET,
      fetchImpl: jsonFetch({}, 503),
    }),
    /HTTP 503 \(https:\/\/oxide\.example\/manifest\.json\)/,
  )
})

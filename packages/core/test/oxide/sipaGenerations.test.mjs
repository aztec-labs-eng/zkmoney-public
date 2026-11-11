import assert from "node:assert/strict"
import { test } from "node:test"
import { pinnedOxideDeployment, sipaGenerationOf, sipaGenerations } from "../../dist/oxide/index.js"

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"
const DAI_PORTAL = "0x1E6142c98D83c8D14b09668d90583E940A646458"
const SUSDS_PORTAL = "0x2E6142c98D83c8D14b09668d90583E940A646458"
const a = (byte) => `0x${byte.repeat(20)}`
const l2 = (byte) => `0x${byte.repeat(32)}`

const set = (byte) => ({
  sipaFactory: a(`${byte}1`),
  forwardingTable: a(`${byte}2`),
  depositSIPAImplementation: a(`${byte}3`),
  registrationSIPAImplementation: a(`${byte}4`),
})

const bridge = (key, token, portal, byte, subsidy) => ({
  key,
  bridgeId: `brg-${key}`,
  token,
  portal,
  l2Token: l2(byte),
  depositSubsidy: subsidy,
})

const manifest = (revisions, current = set("c")) => ({
  schemaVersion: "5",
  deployments: [
    {
      label: "v1.0.0",
      deployedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
      chainId: "11155111",
      rollupVersion: "679261766",
      enclaveUrl: "https://enclave.example/rpc",
      sipaRecoveryProtocol: "account",
      ...current,
      bridges: [
        bridge("dai", DAI, DAI_PORTAL, "d0", a("c5")),
        bridge("susds", SUSDS, SUSDS_PORTAL, "e0", a("c6")),
      ],
      ...(revisions === undefined ? {} : { revisions }),
    },
  ],
})

const tupleOf = (doc, portal = DAI_PORTAL) => pinnedOxideDeployment(doc, { portal }).pinned.tuple

const factories = (tuple) => sipaGenerations(tuple).map((g) => g.sipaFactory)

test("an entry without revisions has only its current set", () => {
  const tuple = tupleOf(manifest(undefined))
  assert.equal(tuple.priorSipaGenerations, undefined)
  assert.deepEqual(sipaGenerations(tuple), [{ ...set("c"), depositSubsidy: a("c5") }])
})

test("a revision that replaced the whole set rebuilds it, with each bridge's own subsidy", () => {
  const doc = manifest([
    {
      updatedAt: "2026-10-31T00:00:00.000Z",
      gitSha: "e0bcfb2f",
      ...set("b"),
      bridges: [
        { bridgeId: "brg-dai", key: "dai", depositSubsidy: a("b5") },
        { bridgeId: "brg-susds", key: "susds", depositSubsidy: a("b6") },
      ],
    },
  ])
  assert.deepEqual(sipaGenerations(tupleOf(doc))[1], { ...set("b"), depositSubsidy: a("b5") })
  assert.deepEqual(sipaGenerations(tupleOf(doc, SUSDS_PORTAL))[1], {
    ...set("b"),
    depositSubsidy: a("b6"),
  })
})

test("revisions undo newest first, so a value one revision leaves out comes from the newer state", () => {
  const doc = manifest([
    { updatedAt: "2026-10-01T00:00:00.000Z", ...set("a") },
    { updatedAt: "2026-10-20T00:00:00.000Z", forwardingTable: a("b2") },
  ])
  const generations = sipaGenerations(tupleOf(doc))
  assert.deepEqual(
    generations.map((g) => [g.sipaFactory, g.forwardingTable]),
    [
      [a("c1"), a("c2")],
      [a("c1"), a("b2")],
      [a("a1"), a("a2")],
    ],
  )
})

test("null is a value the older state did not have", () => {
  const doc = manifest([
    { updatedAt: "2026-10-01T00:00:00.000Z", sipaFactory: a("b1"), forwardingTable: null },
  ])
  const [, prior] = sipaGenerations(tupleOf(doc))
  assert.equal(prior.sipaFactory, a("b1"))
  assert.equal("forwardingTable" in prior, false)
})

test("a revision that changed no SIPA value adds no set", () => {
  const doc = manifest([
    { updatedAt: "2026-10-01T00:00:00.000Z", enclaveUrl: "https://old.example/rpc" },
  ])
  assert.deepEqual(factories(tupleOf(doc)), [a("c1")])
})

test("a malformed revision keeps the newer sets and drops the older ones", async (t) => {
  t.mock.method(console, "warn", () => {})
  const malformed = [
    { updatedAt: "2026-10-01T00:00:00.000Z", sipaFactory: "0xnot-an-address" },
    { updatedAt: "2026-10-01T00:00:00.000Z", bridges: [{ depositSubsidy: a("a5") }] },
    { updatedAt: "2026-10-01T00:00:00.000Z", bridges: {} },
    { updatedAt: "yesterday", sipaFactory: a("a1") },
    // Not older than the revision after it.
    { updatedAt: "2026-10-25T00:00:00.000Z", sipaFactory: a("a1") },
  ]
  for (const bad of malformed) {
    const doc = manifest([
      { updatedAt: "2026-09-01T00:00:00.000Z", ...set("9") },
      bad,
      { updatedAt: "2026-10-20T00:00:00.000Z", ...set("b") },
    ])
    assert.deepEqual(factories(tupleOf(doc)), [a("c1"), a("b1")], JSON.stringify(bad))
  }
})

test("a SIPA's set is found by factory and table, and by implementation among sets sharing both", () => {
  const doc = manifest([
    { updatedAt: "2026-10-01T00:00:00.000Z", ...set("a") },
    { updatedAt: "2026-10-20T00:00:00.000Z", depositSIPAImplementation: a("b3") },
  ])
  const tuple = tupleOf(doc)
  const of = (origin) => sipaGenerationOf(tuple, origin)?.depositSIPAImplementation
  assert.equal(of({ sipaFactory: a("a1"), forwardingTable: a("a2") }), a("a3"))
  assert.equal(
    of({ sipaFactory: a("c1"), forwardingTable: a("c2"), implementation: a("b3") }),
    a("b3"),
  )
  assert.equal(
    of({ sipaFactory: a("c1"), forwardingTable: a("c2"), implementation: a("c3") }),
    a("c3"),
  )
  assert.equal(of({ sipaFactory: a("c1"), forwardingTable: a("a2") }), undefined)
})

test("earlier sets are frozen with the tuple", () => {
  const doc = manifest([{ updatedAt: "2026-10-01T00:00:00.000Z", ...set("a") }])
  const { priorSipaGenerations } = tupleOf(doc)
  assert.ok(Object.isFrozen(priorSipaGenerations))
  assert.ok(Object.isFrozen(priorSipaGenerations[0]))
})

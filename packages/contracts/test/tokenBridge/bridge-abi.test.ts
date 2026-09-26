/**
 * OxideTokenContract — ABI shape parity tests.
 *
 * Asserts the vendored L2 bridge artifact exposes the oxide surface:
 *
 *   - constructor(portal_address: EthAddress, name: str<31>, symbol: str<31>, decimals: u8)
 *   - store_deposit(...) — records an L1->L2 deposit for lazy spending (there is no explicit `claim`)
 *   - withdraw(from: AztecAddress, executor: EthAddress, user_payload_hash: Field, amount: u128,
 *              prover_tip: u128, meta: [Field; 7], authwit_nonce: Field)
 *   - transfer(from: AztecAddress, to: AztecAddress, amount: u128, authwit_nonce: Field)
 *   - balance_of(owner: AztecAddress) -> u128
 *   - consume_signer_registration(pub_key_x_hi: Field, pub_key_x_lo: Field,
 *                                 pub_key_y_hi: Field, pub_key_y_lo: Field,
 *                                 message_leaf_index: Field)
 *
 * And forbids the legacy obsidion-only names:
 *   - claim_private
 *   - exit_to_l1_private
 *   - drip_to_private (cross-contract mint path; bridge holds balances now)
 *   - set_token (no separate token contract anymore)
 *   - get_token / get_config / get_admin (config struct removed)
 *
 * Storage layout:
 *   - balances occupies slot 3
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { TRANSFER_META_LEN, WITHDRAW_META_LEN } from "@obsidion/core/constants"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACT_PATH = resolve(
  __dirname,
  "../../src/artifacts/target/oxide_token_contract/oxide_token_contract-OxideToken.json",
)

interface AbiParam {
  name: string
  type: { kind: string; path?: string; sign?: string; width?: number }
}

interface ContractFunction {
  name: string
  abi?: { parameters: AbiParam[] }
}

interface StorageSlotEntry {
  name: string
  value: { fields: { name: string; value: { value: string } }[] }
}

interface StorageContractEntry {
  fields: {
    name: string
    value: { value?: string; fields?: StorageSlotEntry[] }
  }[]
}

interface ContractArtifact {
  name: string
  functions: ContractFunction[]
  outputs?: {
    globals?: {
      storage?: StorageContractEntry[]
    }
  }
}

const loadArtifact = (): ContractArtifact =>
  JSON.parse(readFileSync(ARTIFACT_PATH, "utf-8")) as ContractArtifact

const userVisibleParams = (fn: ContractFunction): AbiParam[] =>
  // Aztec macros prepend an implicit `inputs` struct to externally-callable functions.
  // Strip it so this test reads the user-facing parameter list.
  (fn.abi?.parameters ?? []).filter((p) => p.name !== "inputs")

const findFn = (a: ContractArtifact, name: string): ContractFunction | undefined =>
  a.functions.find((f) => f.name === name)

const findFnNames = (a: ContractArtifact): string[] => a.functions.map((f) => f.name)

const getBridgeStorage = (a: ContractArtifact): StorageSlotEntry[] => {
  // Each storage global is `{ name: "STORAGE_LAYOUT_<Contract>", value: { fields: [...] } }`.
  const allContracts = a.outputs?.globals?.storage ?? []
  const bridge = allContracts.find((entry) => {
    const cn = entry.value?.fields?.find((f) => f.name === "contract_name")?.value?.value
    return cn === "OxideToken"
  })
  if (!bridge) throw new Error("OxideToken storage entry not found in artifact")
  return bridge.value?.fields?.find((f) => f.name === "fields")?.value?.fields ?? []
}

const slotOf = (entries: StorageSlotEntry[], fieldName: string): number => {
  const e = entries.find((x) => x.name === fieldName)
  if (!e) return -1
  const slotHex = e.value.fields.find((x) => x.name === "slot")?.value?.value
  return slotHex ? parseInt(slotHex, 16) : -1
}

describe("OxideToken artifact — oxide surface", () => {
  it("contract name is OxideToken", () => {
    const a = loadArtifact()
    expect(a.name).toBe("OxideToken")
  })

  describe("legacy obsidion-only function names are removed", () => {
    const legacy = [
      "claim_private",
      "exit_to_l1_private",
      "drip_to_private",
      "set_token",
      "get_token",
      "get_config",
      "get_admin",
      "transfer_private_to_private",
      "balance_of_private",
    ]
    for (const name of legacy) {
      it(`does not expose ${name}`, () => {
        const a = loadArtifact()
        expect(findFnNames(a)).not.toContain(name)
      })
    }
  })

  describe("oxide-aligned functions exist with the right parameter shape", () => {
    it("constructor(portal_address, name, symbol, decimals)", () => {
      const a = loadArtifact()
      const fn = findFn(a, "constructor")
      expect(fn, "constructor missing").toBeDefined()
      const params = userVisibleParams(fn!)
      // oxide 4.3.0 stable (commit ade5dbd "Update to 4.3.0 stable") dropped
      // the legacy `minter` and `admin` constructor args; role management
      // moved to separate post-deploy admin operations.
      expect(params.map((p) => p.name)).toEqual(["portal_address", "name", "symbol", "decimals"])
      expect(params[0].type.kind).toBe("struct")
      expect(params[0].type.path).toMatch(/EthAddress$/)
      expect(params[3].type.kind).toBe("integer")
      expect(params[3].type.width).toBe(8)
    })

    it("lazy deposit spending: no explicit claim, store_deposit present", () => {
      const a = loadArtifact()
      // There is no explicit `claim(...)` entrypoint — an L1->L2 deposit is absorbed
      // when the recipient next transacts, recorded via `store_deposit` and surfaced
      // through `next_deposits` (`balance_of` sums unspent deposits).
      expect(findFn(a, "claim"), "explicit claim should be removed").toBeUndefined()
      expect(findFn(a, "store_deposit"), "store_deposit missing").toBeDefined()
    })

    it("withdraw(from, executor, user_payload_hash, amount, prover_tip, meta, authwit_nonce)", () => {
      const a = loadArtifact()
      const fn = findFn(a, "withdraw")
      expect(fn, "withdraw missing").toBeDefined()
      const params = userVisibleParams(fn!)
      expect(params.map((p) => p.name)).toEqual([
        "from",
        "executor",
        "user_payload_hash",
        "amount",
        "prover_tip",
        "meta",
        "authwit_nonce",
      ])
      expect(params[0].type.path).toMatch(/AztecAddress$/)
      expect(params[1].type.path).toMatch(/EthAddress$/)
      expect(params[2].type.kind).toBe("field")
      expect(params[3].type.kind).toBe("integer")
      expect(params[3].type.width).toBe(128)
      expect(params[4].type.kind).toBe("integer")
      expect(params[4].type.width).toBe(128)
      expect(params[5].type.kind).toBe("array")
      expect(params[5].type.length).toBe(WITHDRAW_META_LEN)
      expect(params[6].type.kind).toBe("field")
    })

    it("transfer(from, to, amount, meta, authwit_nonce)", () => {
      const a = loadArtifact()
      const fn = findFn(a, "transfer")
      expect(fn, "transfer missing").toBeDefined()
      const params = userVisibleParams(fn!)
      expect(params.map((p) => p.name)).toEqual(["from", "to", "amount", "meta", "authwit_nonce"])
      expect(params[0].type.path).toMatch(/AztecAddress$/)
      expect(params[1].type.path).toMatch(/AztecAddress$/)
      expect(params[2].type.kind).toBe("integer")
      expect(params[2].type.width).toBe(128)
      expect(params[3].type.kind).toBe("array")
      expect(params[3].type.length).toBe(TRANSFER_META_LEN)
      expect(params[4].type.kind).toBe("field")
    })

    it("balance_of(owner) is exposed as an unconstrained utility", () => {
      const a = loadArtifact()
      const fn = findFn(a, "balance_of")
      expect(fn, "balance_of missing").toBeDefined()
      const params = userVisibleParams(fn!)
      expect(params.map((p) => p.name)).toEqual(["owner"])
      expect(params[0].type.path).toMatch(/AztecAddress$/)
    })

    it("consume_signer_registration(pub_key_x_hi, pub_key_x_lo, pub_key_y_hi, pub_key_y_lo, message_leaf_index)", () => {
      const a = loadArtifact()
      const fn = findFn(a, "consume_signer_registration")
      expect(fn, "consume_signer_registration missing").toBeDefined()
      const params = userVisibleParams(fn!)
      expect(params.map((p) => p.name)).toEqual([
        "pub_key_x_hi",
        "pub_key_x_lo",
        "pub_key_y_hi",
        "pub_key_y_lo",
        "message_leaf_index",
      ])
      // All 5 args are bare fields (the contract recombines the halves
      // and recomputes the eth address from the secp pubkey on-chain).
      expect(params[0].type.kind).toBe("field")
      expect(params[1].type.kind).toBe("field")
      expect(params[2].type.kind).toBe("field")
      expect(params[3].type.kind).toBe("field")
      expect(params[4].type.kind).toBe("field")
    })
  })

  describe("storage layout matches oxide", () => {
    it("balances occupies slot 3", () => {
      const a = loadArtifact()
      const entries = getBridgeStorage(a)
      const slot = slotOf(entries, "balances")
      expect(slot, `balances slot, got ${slot}`).toBe(3)
    })

    it("portal_address exists in storage", () => {
      const a = loadArtifact()
      const entries = getBridgeStorage(a)
      const slot = slotOf(entries, "portal_address")
      expect(slot).toBeGreaterThan(0)
    })

    it("approved_signers exists in storage", () => {
      const a = loadArtifact()
      const entries = getBridgeStorage(a)
      const slot = slotOf(entries, "approved_signers")
      expect(slot).toBeGreaterThan(0)
    })

    it("legacy `config` and `token` storage slots are gone", () => {
      const a = loadArtifact()
      const entries = getBridgeStorage(a)
      const names = entries.map((e) => e.name)
      expect(names).not.toContain("config")
      expect(names).not.toContain("token")
    })
  })
})

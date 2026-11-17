import assert from "node:assert/strict"
import { test } from "node:test"
import { scrubErrorText } from "../../dist/errors/index.js"

const ADDRESS = "0x" + "ab12".repeat(10)
const HASH = "0x" + "9f".repeat(32)
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 Instagram 338.0.3 (iPhone14,5; en_US; scale=3.00)"

const cases = [
  [
    "a URL and its key",
    "HTTP request failed. URL: https://eth.example/v2/s3cr3tKey?x=1",
    "HTTP request failed. URL: [url]",
  ],
  ["a websocket URL", "closed wss://node.example:8546/ws early", "closed [url] early"],
  ["an email", "Failed to fetch alice@private.example", "Failed to fetch [email]"],
  ["an account on a host", "denied for alice@localhost", "denied for [email]"],
  ["a tag", "@alice.zk is no longer registered", "[tag] is no longer registered"],
  ["an address", `insufficient funds for ${ADDRESS}`, "insufficient funds for [hex]"],
  ["a shortened address", "sent to 0x12ab…cd34 and 0x12ab...cd34", "sent to [hex] and [hex]"],
  ["a transaction hash", `tx ${HASH} dropped`, "tx [hex] dropped"],
  [
    "an address inside an id",
    `broadcast_${ADDRESS}_1731700000000`,
    "broadcast_[hex]_1731700000000",
  ],
  ["an amount in base units", "have 1500000 want 25000000000", "have [number] want [number]"],
  ["an amount of any length", `allowance ${"7".repeat(40)} left`, "allowance [number] left"],
  [
    "a range of amounts",
    "between 1500000000000000000-2500000000000000000",
    "between [number]-[number]",
  ],
  ...["=", "/", "+"].map((join) => [
    `an amount joined to a long name by ${join}`,
    `transferAmountInBaseUnits${join}1500000000000000000`,
    `transferAmountInBaseUnits${join}[number]`,
  ]),
  [
    "an amount as a person writes it",
    "have 1500.25 USDC, need 2,300,000.00 USDC",
    "have [number] USDC, need [number] USDC",
  ],
  ["a user agent", `unsupported: ${IPHONE}\nat boot`, "unsupported: [user-agent]\nat boot"],
]

test("replaces what could name a user or a secret", () => {
  for (const [name, text, scrubbed] of cases) assert.equal(scrubErrorText(text), scrubbed, name)
})

test("keeps what names the failure or traces it", () => {
  for (const text of [
    "execution reverted with custom error 0x08c379a0",
    "reverted with selector 0x12345678",
    "RPC error -32000 on chain 0xaa36a7",
    "ContractFunctionExecutionError: the contract function reverted",
    "Request failed with status 503 after 30s",
    `key ${"0f".repeat(32)} rejected`,
    // Its leading digits alone would read as an amount.
    "operation 12345678-d584-4270-9aa2-123456789abc is running",
    // The shortest run that stays whole.
    "event 12345678d58442709aa2123456789abc sent",
    "bad fragment eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9_x-y",
  ])
    assert.equal(scrubErrorText(text), text)
})

test("drops what follows its limit, with the word the limit cuts", () => {
  const key = "0f".repeat(32)
  assert.equal(scrubErrorText(`${"word ".repeat(816)}${key} tail`), "word ".repeat(816).trimEnd())
  for (const start of ["", " ", "\n"])
    assert.equal(scrubErrorText(start + "ab".repeat(4_000)), "[truncated]")
})

test("scrubs text of any length, however it is built, without stalling", () => {
  for (const part of ["a@", "@", "a.@", "a", "://", "0x", "a:", "1a-", "1.", "1", "1-", "a."]) {
    // The limit's worth in one run is the most work a rule can meet.
    for (const text of [part.repeat(4_096).slice(0, 4_096), `${part.repeat(2_000)} `.repeat(50)]) {
      const started = performance.now()
      scrubErrorText(text)
      assert.ok(performance.now() - started < 1000, part)
    }
  }
})

test("leaves its own labels as they are", () => {
  for (const [, text] of cases) {
    const once = scrubErrorText(text)
    assert.equal(scrubErrorText(once), once)
  }
})

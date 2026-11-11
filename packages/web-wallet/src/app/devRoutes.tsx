/**
 * Dev `/dev/mock/<area>/<name>`: a production screen opened where a demo page's mock starts it, on
 * the Page's fake reads and seeded records. `/dev/mock/<area>` links every mock. The demo seed reads
 * the same URL at boot, so each link loads the page afresh.
 */
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { ChainIdentity } from "@obsidion/core/types"
import { useParams } from "react-router-dom"
import { showReportableError } from "../errors/errorModal"
import { useSession } from "../session/session"
import { useOpened } from "../ui/useScreenFlow"
import { DepositScreen } from "../features/deposit/DepositScreen/DepositScreen"
import { WithdrawMethodScreen } from "../features/withdraw/WithdrawMethodScreen/WithdrawMethodScreen"
import { RequestLandingScreen } from "../features/requests/RequestLandingScreen"
import { claimChosenName } from "../features/onboarding/oxideOnboarding"
import copy from "./devRoutes.copy"

export type MockArea = "deposit" | "withdraw" | "pay"

/** A mock's list entry, and the reportable error a failure mock raises as it opens. */
interface MockListing {
  group: string
  about: string
  error?: { context: string; text: string }
}

const SEND = "Send from wallet (Ethereum)"
const BRIDGE = "Bridge in"
const PAY = "Pay a request"

const DEPOSIT_MOCKS = {
  "landing-empty": { group: "Landing", about: "New address only, no saved wallets" },
  "landing-saved": { group: "Landing", about: "New address and two saved wallets" },
  "landing-held": {
    group: "Landing",
    about: "Deposits paused: a browser-wallet send may still land",
  },
  "picker": { group: "Flow steps", about: "Network and coin picker, the bridge chain preselected" },
  "method": {
    group: "Flow steps",
    about: "Address or wallet (try ?network=base: address is Ethereum only)",
  },
  "privacy": { group: "Flow steps", about: "Privacy notice with minimum, fee and limit" },
  "about-limits": { group: "Flow steps", about: "About limits sheet over the privacy step" },
  "about-capacity": {
    group: "Flow steps",
    about: "About network capacity sheet over the privacy step",
  },
  "address-creating": { group: "Deposit address", about: "Creating your address" },
  "address-capped": {
    group: "Deposit address",
    about: "Creating, held by addresses still publishing",
  },
  "address": { group: "Deposit address", about: "Address and QR to copy" },
  "address-waiting": { group: "Deposit address", about: "Copied, waiting for the deposit" },
  "address-read-error": {
    group: "Deposit address",
    about: "Waiting, the last balance read failed",
  },
  "address-spotted": { group: "Deposit address", about: "500 USDC spotted" },
  "address-arrived": { group: "Deposit address", about: "Arrived in the private funds" },
  "address-over-limit": { group: "Deposit address", about: "Spotted over the deposit limit" },
  "send-eth": { group: SEND, about: "Amount: 500 USDC from MetaMask" },
  "send-eth-over-limit": { group: SEND, about: "Amount over the deposit limit" },
  "send-eth-fee-changed": { group: SEND, about: "Review: the fee changed before sending" },
  "send-eth-review": { group: SEND, about: "Review, ready to send" },
  "send-eth-approving": { group: SEND, about: "Approve the transfer in your wallet" },
  "send-eth-switching": { group: SEND, about: "Switch to Ethereum in your wallet" },
  "send-eth-failed": {
    group: SEND,
    about: "The transfer failed: error over the review",
    error: {
      context: "deposit:send",
      text: "The transfer reverted on Ethereum: transfer amount exceeds balance.",
    },
  },
  "waiting-eth": { group: SEND, about: "Sent, confirming on Ethereum" },
  "arrived-eth": { group: SEND, about: "Confirmed, arriving in the private funds" },
  "landed-eth": { group: SEND, about: "In the private funds" },
  "sent-journey": { group: SEND, about: "Sent, confirms at 4s, arrives at 10s" },
  "deposit-failed": { group: SEND, about: "Failed deposit: status with an Activity link" },
  "deposit-recoverable": { group: SEND, about: "Recoverable deposit: detail sheet with Recover" },
  "bridge-in": { group: BRIDGE, about: "Amount: 500 USDC on Base" },
  "bridge-review": { group: BRIDGE, about: "Review before approving" },
  "bridging-approving": { group: BRIDGE, about: "Approve the bridge in your wallet" },
  "bridging-failed": {
    group: BRIDGE,
    about: "The bridge call failed: error over the review",
    error: { context: "deposit:bridge-in", text: "The bridge transaction reverted on Base." },
  },
  "bridging": { group: BRIDGE, about: "Bridging: the coin flips with its chain" },
  "bridged": { group: BRIDGE, about: "Filled on Ethereum, arriving in the private funds" },
  "bridge-arrived": { group: BRIDGE, about: "In the private funds" },
  "bridge-journey": { group: BRIDGE, about: "Plays bridging → arriving → arrived" },
  "bridge-refunded": { group: BRIDGE, about: "Refunded on the origin chain" },
  "bridge-expired": { group: BRIDGE, about: "Expired before it filled" },
  "bridge-not-sent": { group: BRIDGE, about: "The bridge call never went through" },
  "switch-account": { group: BRIDGE, about: "Saved Ledger is not the connected account" },
} satisfies Record<string, MockListing>

const WITHDRAW_MOCKS = {
  "landing": { group: "Landing", about: "Banners and New address, no saved wallets" },
  "landing-saved": { group: "Landing", about: "Two saved wallets with privacy rings" },
  "landing-no-bridge": { group: "Landing", about: "No bridge routes" },
  "address": { group: "Address", about: "Empty field" },
  "address-fresh": { group: "Address", about: "Resolved, High privacy" },
  "address-used": { group: "Address", about: "Has transactions, Medium privacy" },
  "address-exposed": { group: "Address", about: "Linked deposit, Exposed" },
  "address-ens": { group: "Address", about: "rainbow.eth resolved" },
  "address-screened": {
    group: "Address",
    about: "Screening refuses the address: its message in red, Continue off",
  },
  "address-screen-error": {
    group: "Address",
    about: "Screening didn't answer: Couldn't verify, Retry, Continue off",
  },
  "address-timeout": {
    group: "Address",
    about: "The address read timed out: Couldn't verify, Retry, Continue on",
  },
  "address-checking": { group: "Address", about: "Reads still running" },
  "etherfi": { group: "ether.fi", about: "Empty field, the three steps" },
  "etherfi-saved": { group: "ether.fi", about: "The saved ether.fi Cash address with Change" },
  "etherfi-confirmed": { group: "ether.fi", about: "Address confirmed" },
  "etherfi-account": {
    group: "ether.fi",
    about: "Cash account with no Ethereum deposit yet: confirm it",
  },
  "etherfi-rejected": { group: "ether.fi", about: "Not an ether.fi address: Continue off" },
  "etherfi-unknown": { group: "ether.fi", about: "The check didn't finish: Continue on" },
  "amount": { group: "Amount", about: "Ethereum, DAI, empty" },
  "amount-typed": { group: "Amount", about: "500 DAI typed, the quote in" },
  "amount-swap": { group: "Amount", about: "500 DAI to USDC on Ethereum" },
  "amount-bridge": { group: "Amount", about: "500 DAI to USDC on Base, bridge quote in" },
  "amount-etherfi": {
    group: "Amount",
    about: "ether.fi Cash address: USDC or USDT only",
  },
  "amount-max": { group: "Amount", about: "MAX: the whole balance, every fee inside it" },
  "amount-to-typed": {
    group: "Amount",
    about: "100 USDC typed in To: From solves to what yields it",
  },
  "amount-fee-floor": {
    group: "Amount",
    about: "0.30 DAI, under the $0.50 fee: To 0, Continue off, a press names the fee",
  },
  "amount-fast-checking": {
    group: "Amount",
    about: "The speed offer still loading: both cards disabled, checking",
  },
  "amount-fast-none": {
    group: "Amount",
    about: "Zero tip: Fast not available, Standard about 30 min",
  },
  "amount-eta-none": {
    group: "Amount",
    about: "The speed read fails: Fast not available, Standard with no ETA",
  },
  "picker": { group: "Amount", about: "Network and coin picker over the amount" },
  "amount-over-balance": { group: "Amount", about: "2,000 DAI over a 1,240.50 balance" },
  "gas": { group: "Gas", about: "No ETH on the address, $5 default" },
  "gas-has-eth": { group: "Gas", about: "The address holds ETH, None preselected" },
  "gas-short": {
    group: "Gas",
    about: "A 503 DAI balance covers $1 of gas but not $5: $1 preselected",
  },
  "review": { group: "Review", about: "Ethereum, USDC, $5 gas, Fast" },
  "review-dai": { group: "Review", about: "DAI direct, Standard" },
  "review-bridge": { group: "Review", about: "USDC on Base, no gas" },
  "review-fee-changed": { group: "Review", about: "Review: the fee changed before confirming" },
  "status-building": { group: "Status", about: "Building the proof: the keep-open banner" },
  "status-passkey": {
    group: "Status",
    about: "The passkey prompt is up: the Confirm with your passkey chip",
  },
  "status-proving": { group: "Status", about: "Proving: the keep-open banner" },
  "status-submitting": { group: "Status", about: "Sending the proof: the keep-open banner" },
  "status-l2-mined": { group: "Status", about: "Mined on L2: releasing to Ethereum" },
  "status-awaiting-proven": {
    group: "Status",
    about: "Waiting for the proof: releasing to Ethereum",
  },
  "status-finalizing": { group: "Status", about: "Releasing to Ethereum" },
  "status-swapping": { group: "Status", about: "Swapping to USDC: releasing to Ethereum" },
  "withdraw-journey": {
    group: "Status",
    about: "Plays withdrawing (passkey, then proof) → releasing → done",
  },
  "status-bridging": { group: "Status", about: "Bridging: releasing to Base" },
  "done": { group: "Done", about: "USDC on Ethereum with $5 of gas" },
  "done-bridge": { group: "Done", about: "USDC on Base" },
  "done-dai": { group: "Done", about: "DAI on Ethereum" },
  "failed": { group: "Done", about: "The withdrawal didn't complete" },
  "recoverable": { group: "Done", about: "The swap didn't complete" },
} satisfies Record<string, MockListing>

const PAY_MOCKS = {
  "pay-sheet": {
    group: PAY,
    about: "The pay flow: network and coin, then the address or a wallet",
  },
  "pay-unresolved": { group: PAY, about: "A payment may already be on its way: Pay again" },
  "pay-bridge-amount": { group: PAY, about: "Bridge amount: $26 from Base" },
  "pay-bridge-review": { group: PAY, about: "Review before approving" },
  "pay-bridge-approving": { group: PAY, about: "Approve the bridge in your wallet" },
  "pay-bridge-pending": { group: PAY, about: "Paying the requester: bridging" },
  "pay-bridge-filled": { group: PAY, about: "On its way to the requester" },
  "pay-bridge-failed": { group: PAY, about: "The bridge didn't go through: Try again" },
  "pay-bridge-expired": { group: PAY, about: "Expired before it filled: Try again" },
  "pay-bridge-refunded": { group: PAY, about: "Refunded on the origin chain: Try again" },
} satisfies Record<string, MockListing>

export type DepositMockName = keyof typeof DEPOSIT_MOCKS
export type WithdrawMockName = keyof typeof WITHDRAW_MOCKS
export type PayMockName = keyof typeof PAY_MOCKS

const LISTS: Record<MockArea, Record<string, MockListing>> = {
  deposit: DEPOSIT_MOCKS,
  withdraw: WITHDRAW_MOCKS,
  pay: PAY_MOCKS,
}

/** The mock a dev URL opens; undefined for any other URL. */
export function devMockRoute(
  pathname: string,
  search: string,
): { area: MockArea; name: string; query: URLSearchParams } | undefined {
  const match = /^\/dev\/mock\/(deposit|withdraw|pay)\/([^/]+)\/?$/.exec(pathname)
  if (!match) return undefined
  return { area: match[1] as MockArea, name: match[2]!, query: new URLSearchParams(search) }
}

/** The mock the route names, or the list of its area's mocks. */
export function DevMock({
  area,
  node,
  chainIdentity,
}: {
  area: MockArea
  node: AztecNode
  chainIdentity?: ChainIdentity
}) {
  const { name } = useParams()
  const { page } = useSession()
  const error = name ? LISTS[area][name]?.error : undefined
  useOpened(() => error && showReportableError(new Error(error.text), error.context))
  if (!name) return <MockList area={area} />
  const { screens } = page
  if (!screens) return <p className="ww-move-landing">{copy.notSeeded}</p>
  if (area === "deposit")
    return <DepositScreen claimName={claimChosenName} start={screens.deposit} />
  if (area === "withdraw") return <WithdrawMethodScreen start={screens.withdraw} />
  return <RequestLandingScreen node={node} chainIdentity={chainIdentity} start={screens.pay} />
}

/** A link to every mock of `area`, each loading the page afresh. */
function MockList({ area }: { area: MockArea }) {
  const groups = Object.entries(LISTS[area]).reduce<Record<string, [string, MockListing][]>>(
    (acc, entry) => ({ ...acc, [entry[1].group]: [...(acc[entry[1].group] ?? []), entry] }),
    {},
  )
  return (
    <div className="ww-move-landing" style={{ gap: 16 }}>
      <h1>{copy.title[area]}</h1>
      {copy.hint[area] && <p style={{ color: "var(--text-secondary)" }}>{copy.hint[area]}</p>}
      {Object.entries(groups).map(([group, entries]) => (
        <section key={group}>
          <h2 style={{ fontSize: 16, margin: "8px 0" }}>{group}</h2>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            {entries.map(([name, def]) => (
              <li key={name}>
                <a href={`/dev/mock/${area}/${name}`} style={{ color: "var(--accent-gold)" }}>
                  {name}
                </a>{" "}
                <span style={{ color: "var(--text-secondary)" }}>· {def.about}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

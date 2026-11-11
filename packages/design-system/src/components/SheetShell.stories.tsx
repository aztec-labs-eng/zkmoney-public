import type { Meta, StoryObj } from "@storybook/react-vite"
import type { TrackerStep } from "@obsidion/web-ds"
import type { CSSProperties, ReactNode } from "react"
import { useState } from "react"
import {
  ChecklistRow,
  ChoiceCard,
  FactBox,
  InfoBox,
  KeyStatusRow,
  NextStepsDisclosure,
  SheetCard,
  SheetLink,
  SheetShell,
  StepTracker,
  TopNavIconButton,
} from "@obsidion/web-ds"

// Each story rebuilds one frame of Figma Web Wallet › Settings › Passkeys: A = adding a backup,
// B = can't start yet, C = errors while adding.
const noop = () => {}

// Mirrors the wallet's `Modal variant="create"` card, which hosts the shell.
const desktopCard: CSSProperties = {
  position: "relative",
  boxSizing: "border-box",
  width: 500,
  padding: "40px 64px",
  border: "1px solid #303030",
  borderRadius: 24,
  background: "var(--surface-sheet)",
  boxShadow: "0 0 40px 33px rgba(0, 0, 0, 0.15)",
}
// The same card on a phone (<= 640px): docked as the bottom sheet.
const phoneScreen: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  width: 402,
  minHeight: 879,
  background: "rgba(7, 7, 7, 0.65)",
}
const phoneCard: CSSProperties = {
  ...desktopCard,
  width: "100%",
  padding: "32px 24px",
  border: "none",
  borderRadius: "32px 32px 0 0",
}
const close: CSSProperties = { position: "absolute", top: 20, right: 20 }

function HostCard({ phone, children }: { phone: boolean; children: ReactNode }) {
  const card = (
    <div style={phone ? phoneCard : desktopCard}>
      <div style={close}>
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={noop} />
      </div>
      {children}
    </div>
  )
  return phone ? <div style={phoneScreen}>{card}</div> : card
}

const meta = {
  title: "Sheets & Modals/SheetShell",
  component: SheetShell,
  decorators: [
    (Story, { parameters }) => <HostCard phone={parameters.phone === true}>{Story()}</HostCard>,
  ],
} satisfies Meta<typeof SheetShell>

export default meta
type Story = StoryObj<typeof meta>

const tracker = (current: 1 | 2 | 3 | 4, overrides: Partial<TrackerStep> = {}): TrackerStep[] => {
  const steps: TrackerStep[] = [
    { label: "Backup saved", detail: "On your phone", state: "done" },
    { label: "Approve with This Mac", state: "todo" },
    { label: "Wait for the network", state: "todo" },
    { label: "Approve to finish", state: "todo" },
  ]
  if (current > 2)
    steps[1] = { label: "Approved with This Mac", detail: "Paid $0.70", state: "done" }
  if (current > 3) steps[2] = { label: "Network confirmed", detail: "Done", state: "done" }
  steps[current - 1] = { ...steps[current - 1], state: "current", ...overrides }
  return steps
}

/** A1 */
export const Keys: Story = {
  args: {
    hero: "warning",
    title: "Protect your account",
    lead: "Add a second passkey on another device so you can always recover your funds.",
    primary: { label: "Add a backup passkey", onClick: noop },
    children: (
      <SheetCard label="On this account">
        <KeyStatusRow name="Sign-up passkey" detail="This Mac · iCloud Keychain" status="added" />
        <KeyStatusRow name="Backup passkey" detail="Not added" status="missing" />
      </SheetCard>
    ),
  },
}

/** A2 (A2′: hover or tap the info icon beside Cost) */
export const Intro: Story = {
  args: {
    hero: "key",
    title: "Add a backup passkey",
    lead: "A backup passkey lets you recover your funds if you lose access to your sign-up passkey.",
    primary: { label: "Continue", onClick: noop },
    children: (
      <>
        <FactBox
          facts={[
            {
              label: "Cost",
              value: "About $0.70",
              hint: {
                label: "How the cost adds up",
                title: "How the cost adds up",
                rows: [
                  { label: "Account update", value: "$0.70" },
                  { label: "Network fee", value: "Varies" },
                ],
                note: "You'll see the exact amount before you pay.",
              },
            },
            { label: "Time", value: "Up to 45 min" },
          ]}
        />
        <NextStepsDisclosure
          title="What happens next?"
          steps={[
            { label: "Save the backup", detail: "On your phone or a security key" },
            { label: "Approve with This Mac", detail: "The passkey you signed in with" },
            { label: "Wait for the network", detail: "Up to 40 min. Feel free to close this tab." },
            { label: "Approve to finish", detail: "We'll remind you on Home" },
          ]}
        />
        <InfoBox title="Old request links will stop working">
          Once your backup is set up, create new ones.
        </InfoBox>
      </>
    ),
  },
}

function PlaceChoices() {
  const [place, setPlace] = useState("phone")
  return (
    <>
      <ChoiceCard
        name="place"
        value="phone"
        checked={place === "phone"}
        onChange={setPlace}
        label="Your phone"
        badge="Recommended"
        description="Scan a QR code and save it to iCloud Keychain, Google Password Manager or 1Password."
      />
      <ChoiceCard
        name="place"
        value="key"
        checked={place === "key"}
        onChange={setPlace}
        label="Security key"
        description="A YubiKey 5 or newer. Some older keys can't hold a backup."
      />
      <ChoiceCard
        name="place"
        value="mac"
        checked={place === "mac"}
        onChange={setPlace}
        label="This Mac"
        description="Only works if this Mac syncs passkeys to your other devices."
      />
      <SheetLink label="Which passkey managers work?" onClick={noop} />
    </>
  )
}

/** A3 */
export const Place: Story = {
  args: {
    hero: "key",
    title: "Where should your backup live?",
    lead: "Pick something other than this Mac. That way, losing one device won't lock you out.",
    primary: { label: "Save backup passkey", onClick: noop },
    children: <PlaceChoices />,
  },
}

/** A4 */
export const Approve: Story = {
  args: {
    hero: "key",
    title: "Approve with This Mac",
    lead: "Your backup's saved. Now confirm it with the passkey you signed in with.",
    primary: { label: "Approve with This Mac", onClick: noop },
    children: (
      <StepTracker
        label="Adding a backup"
        progress="Step 2 of 4"
        steps={tracker(2, {
          detail: "When your browser asks, pick your sign-up passkey, not the new one",
        })}
      />
    ),
  },
}

/** A5 */
export const Adding: Story = {
  args: {
    hero: "key",
    title: "Adding your backup",
    lead: "This can take up to 40 min. Go ahead and close the tab. We'll keep working on it.",
    primary: { label: "Close", onClick: noop, style: "plain" },
    children: (
      <StepTracker
        label="Adding a backup"
        progress="Step 3 of 4"
        steps={tracker(3, { label: "Waiting for the network", detail: "About 25 min left" })}
      />
    ),
  },
}

/** A6 */
export const Finish: Story = {
  args: {
    hero: "key",
    title: "Approve to finish",
    lead: "Almost there. One last approval with This Mac and you're done.",
    primary: { label: "Approve with This Mac", onClick: noop },
    children: (
      <StepTracker
        label="Adding a backup"
        progress="Step 4 of 4"
        steps={tracker(4, { detail: "One more passkey prompt" })}
      />
    ),
  },
}

/** A7 */
export const Done: Story = {
  args: {
    hero: "success",
    title: "Your account is protected",
    lead: "If you lose access to your sign-up passkey, you can recover your funds with your backup passkey.",
    primary: { label: "Done", onClick: noop },
    children: (
      <>
        <SheetCard label="On this account">
          <KeyStatusRow name="Sign-up passkey" detail="This Mac · iCloud Keychain" status="added" />
          <KeyStatusRow
            name="Backup passkey"
            detail="Your phone · Google Password Manager"
            status="added"
          />
        </SheetCard>
        <FactBox facts={[{ label: "Cost", value: "$0.70" }]} />
      </>
    ),
  },
}

/** B1 */
export const Blocked: Story = {
  args: {
    hero: "key",
    title: "A few things first",
    lead: "Take care of these first, then come back to add your backup.",
    primary: { label: "Add a backup passkey", onClick: noop, disabled: true },
    children: (
      <SheetCard>
        <ChecklistRow done muted label="Account registered" detail="Done" />
        <ChecklistRow
          done={false}
          label="Finish your withdrawal"
          detail="$40.00 to Base is on its way. About 20 min."
          action={{ label: "View", onClick: noop }}
        />
        <ChecklistRow
          done={false}
          label="Close your 2 open paylinks"
          detail="Once you add a backup, you can't cancel or take back older links."
          action={{ label: "Review", onClick: noop }}
        />
        <ChecklistRow
          done={false}
          label="Have at least $1.30"
          detail="You have $0.90."
          action={{ label: "Deposit", onClick: noop }}
        />
      </SheetCard>
    ),
  },
}

/** B2 */
export const Unavailable: Story = {
  args: {
    hero: "warning",
    title: "Backups aren't available here yet",
    lead: "Your passkey still works as usual.",
    primary: { label: "Close", onClick: noop, style: "plain" },
  },
}

/** B3 */
export const Unreadable: Story = {
  args: {
    hero: "error",
    title: "We couldn't load your passkeys",
    lead: "Check your connection and try again. Nothing on your account has changed.",
    primary: { label: "Try again", onClick: noop },
    secondary: { label: "Close", onClick: noop },
  },
}

/** B4 */
export const FirstPasskey: Story = {
  args: {
    hero: "warning",
    title: "Sign in with your sign-up passkey",
    lead: "Only the passkey you created your account with can add a backup.",
    primary: { label: "Sign out and sign in again", onClick: noop },
    secondary: { label: "Close", onClick: noop },
    children: (
      <SheetCard>
        <ChecklistRow done label="Backup passkey" detail="Your phone · signed in now" />
        <ChecklistRow done={false} label="Sign-up passkey" detail="This Mac · use this one" />
      </SheetCard>
    ),
  },
}

const chargedNothing = <FactBox facts={[{ label: "Charged", value: "Nothing" }]} />

/** C1 */
export const PromptClosed: Story = {
  args: {
    hero: "warning",
    title: "The passkey window was closed",
    lead: "No backup was saved and nothing was charged. Try again when you're ready.",
    primary: { label: "Try again", onClick: noop },
    secondary: { label: "Choose another place", onClick: noop },
    children: chargedNothing,
  },
}

/** C2 */
export const CantBeBackup: Story = {
  args: {
    hero: "warning",
    title: "Your security key can't hold a backup",
    lead: "It's missing a feature backups need. Most people use their phone instead.",
    primary: { label: "Use my phone instead", onClick: noop },
    secondary: { label: "Choose another place", onClick: noop },
    children: (
      <>
        {chargedNothing}
        <InfoBox title="Quick cleanup">
          There's now a passkey on your security key that isn't linked to this account. You can
          delete it in the key's settings.
        </InfoBox>
      </>
    ),
  },
}

/** C3 */
export const WrongPasskey: Story = {
  args: {
    hero: "warning",
    title: "Approve with This Mac",
    lead: "That was your new backup, and it can't approve itself. Pick your sign-up passkey this time.",
    primary: { label: "Approve with This Mac", onClick: noop },
    secondary: { label: "Cancel", onClick: noop },
    children: (
      <StepTracker
        label="Adding a backup"
        progress="Step 2 of 4"
        steps={tracker(2, { detail: "Try again with This Mac", tone: "error", failed: true })}
      />
    ),
  },
}

/** C4 */
export const ChangedElsewhere: Story = {
  args: {
    hero: "warning",
    title: "Your passkeys changed on another device",
    lead: "Nothing was charged. Check your passkeys, then start again.",
    primary: { label: "Check my passkeys", onClick: noop },
    children: chargedNothing,
  },
}

/** C5 */
export const Failed: Story = {
  args: {
    hero: "error",
    title: "We couldn't add your backup",
    lead: "Something went wrong on our side. Nothing was charged. Try again in a moment.",
    primary: { label: "Try again", onClick: noop },
    secondary: { label: "Report a bug", onClick: noop },
  },
}

/** C6 */
export const Delayed: Story = {
  args: {
    hero: "warning",
    title: "This is taking longer than usual",
    lead: "The network is slow right now. Your $98.80 is safe, and we'll keep trying.",
    primary: { label: "Check again", onClick: noop },
    secondary: { label: "Close", onClick: noop },
    children: (
      <>
        <StepTracker
          label="Adding a backup"
          progress="Step 3 of 4"
          steps={tracker(3, {
            label: "Waiting for the network",
            detail: "Delayed · last checked 2 min ago",
            tone: "warning",
          })}
        />
        <FactBox facts={[{ label: "Can I cancel?", value: "Not after paying" }]} />
      </>
    ),
  },
}

/** C7 */
export const LastPromptClosed: Story = {
  args: {
    hero: "warning",
    title: "Approve to finish",
    lead: "The window closed before you approved. Your backup won't work until you do.",
    primary: { label: "Approve with This Mac", onClick: noop },
    children: (
      <StepTracker
        label="Adding a backup"
        progress="Step 4 of 4"
        steps={tracker(4, { detail: "Prompt closed, try again", tone: "warning", failed: true })}
      />
    ),
  },
}

/** C8 */
export const FeesHigh: Story = {
  args: {
    hero: "warning",
    title: "Network fees are high right now",
    lead: "Ethereum is busy, so a backup costs more than usual. Nothing was charged. Try again a bit later.",
    primary: { label: "Try again", onClick: noop },
    secondary: { label: "Close", onClick: noop },
    children: chargedNothing,
  },
}

const onPhone = { phone: true }

/** D5: on a phone the wallet's dialog docks the same sheet at the bottom. */
export const IntroOnPhone: Story = { ...Intro, parameters: onPhone }

export const DelayedOnPhone: Story = { ...Delayed, parameters: onPhone }

export const BlockedOnPhone: Story = { ...Blocked, parameters: onPhone }

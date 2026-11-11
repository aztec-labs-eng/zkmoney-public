import type { Meta, StoryObj } from "@storybook/react-vite"
import { StepTracker } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/StepTracker",
  component: StepTracker,
  decorators: [
    (Story) => (
      <div
        style={{ width: 372, padding: 24, borderRadius: 24, background: "var(--surface-sheet)" }}
      >
        {Story()}
      </div>
    ),
  ],
} satisfies Meta<typeof StepTracker>

export default meta
type Story = StoryObj<typeof meta>

const saved = { label: "Backup saved", detail: "On your phone", state: "done" } as const
const approved = { label: "Approved with This Mac", detail: "Paid $0.70", state: "done" } as const

export const Approving: Story = {
  args: {
    label: "Adding a backup",
    progress: "Step 2 of 4",
    steps: [
      saved,
      {
        label: "Approve with This Mac",
        detail: "When your browser asks, pick your sign-up passkey, not the new one",
        state: "current",
      },
      { label: "Wait for the network", state: "todo" },
      { label: "Approve to finish", state: "todo" },
    ],
  },
}

export const Waiting: Story = {
  args: {
    label: "Adding a backup",
    progress: "Step 3 of 4",
    steps: [
      saved,
      approved,
      { label: "Waiting for the network", detail: "About 25 min left", state: "current" },
      { label: "Approve to finish", state: "todo" },
    ],
  },
}

export const Delayed: Story = {
  args: {
    ...Waiting.args,
    steps: [
      saved,
      approved,
      {
        label: "Waiting for the network",
        detail: "Delayed · last checked 2 min ago",
        state: "current",
        tone: "warning",
      },
      { label: "Approve to finish", state: "todo" },
    ],
  },
}

export const WrongPasskey: Story = {
  args: {
    label: "Adding a backup",
    progress: "Step 2 of 4",
    steps: [
      saved,
      {
        label: "Approve with This Mac",
        detail: "Try again with This Mac",
        state: "current",
        tone: "error",
        failed: true,
      },
      { label: "Wait for the network", state: "todo" },
      { label: "Approve to finish", state: "todo" },
    ],
  },
}

export const LastPromptClosed: Story = {
  args: {
    label: "Adding a backup",
    progress: "Step 4 of 4",
    steps: [
      saved,
      approved,
      { label: "Network confirmed", detail: "Done", state: "done" },
      {
        label: "Approve to finish",
        detail: "Prompt closed, try again",
        state: "current",
        tone: "warning",
        failed: true,
      },
    ],
  },
}

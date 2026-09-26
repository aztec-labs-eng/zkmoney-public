import type { Meta, StoryObj } from "@storybook/react-vite"
import { TransactionKindChip } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/TransactionKindChip",
  component: TransactionKindChip,
} satisfies Meta<typeof TransactionKindChip>

export default meta
type Story = StoryObj<typeof meta>

export const Received: Story = {
  args: { kind: "received" },
}

export const Sent: Story = {
  args: { kind: "sent" },
}

export const Deposit: Story = {
  args: { kind: "deposit" },
}

export const Withdrawal: Story = {
  args: { kind: "withdraw" },
}

export const YouOwe: Story = {
  args: { kind: "incomingRequest" },
}

export const OwesYou: Story = {
  args: { kind: "outgoingRequest" },
}

export const PaylinkSend: Story = {
  args: { kind: "outgoingLink" },
}

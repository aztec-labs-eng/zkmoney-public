import type { Meta, StoryObj } from "@storybook/react-vite"
import { StatusBadge } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/StatusBadge",
  component: StatusBadge,
} satisfies Meta<typeof StatusBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Pending: Story = {
  args: { label: "Pending", badgeStyle: "pending" },
}

export const Unclaimed: Story = {
  args: { label: "Unclaimed", badgeStyle: "awaitingClaim" },
}

export const YouOwe: Story = {
  args: { label: "You owe", badgeStyle: "request" },
}

export const Failed: Story = {
  args: { label: "Failed", badgeStyle: "failed" },
}

export const Cancelled: Story = {
  args: { label: "Cancelled", badgeStyle: "cancelled" },
}

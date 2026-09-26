import type { Meta, StoryObj } from "@storybook/react-vite"
import { ActivityListRow } from "@obsidion/web-ds"

const meta = {
  title: "Rows & Lists/ActivityListRow",
  component: ActivityListRow,
} satisfies Meta<typeof ActivityListRow>

export default meta
type Story = StoryObj<typeof meta>

export const Received: Story = {
  args: { counterparty: "@cyphergirl", timestamp: "Today, 11:15", amount: "+$25.23" },
}

export const SentPending: Story = {
  args: {
    counterparty: "@honktheg00se",
    timestamp: "Today, 09:41",
    amount: "-$23.57",
    statusLabel: "Pending",
  },
}

export const UnclaimedPaylink: Story = {
  args: {
    counterparty: "Payment link",
    avatarIcon: "link",
    timestamp: "12 Jul, 18:02",
    amount: "-$50.00",
    statusLabel: "Unclaimed",
    actions: [
      { title: "Share", icon: "share", actionStyle: "gradient" },
      { title: "Cancel", actionStyle: "neutral" },
    ],
  },
}

export const UnpaidRequestLink: Story = {
  args: {
    counterparty: "Requested via paylink",
    avatarIcon: "link",
    timestamp: "Today, 18:00",
    amount: "+$10.00",
    statusLabel: "Unpaid",
    actions: [
      { title: "Cancel", actionStyle: "neutral" },
      { title: "Share", actionStyle: "gradient" },
    ],
  },
}

export const RequestYouOwe: Story = {
  args: {
    counterparty: "@archie",
    counterpartyBadge: "Requested",
    timestamp: "Yesterday, 16:20",
    amount: "$12.00",
    statusLabel: "You owe",
    actions: [
      { title: "Pay", actionStyle: "gradient" },
      { title: "Decline", actionStyle: "neutral" },
    ],
  },
}

export const Failed: Story = {
  args: {
    counterparty: "@dana",
    timestamp: "8 Jul, 10:12",
    amount: "-$4.20",
    statusLabel: "Failed",
  },
}

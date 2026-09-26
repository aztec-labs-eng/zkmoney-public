import type { Meta, StoryObj } from "@storybook/react-vite"
import { HomeQuickActionsRow } from "@obsidion/web-ds"

const meta = {
  title: "Buttons/HomeQuickActionsRow",
  component: HomeQuickActionsRow,
} satisfies Meta<typeof HomeQuickActionsRow>

export default meta
type Story = StoryObj<typeof meta>

export const FourActions: Story = {
  args: {
    actions: [
      { title: "Send", icon: "send" },
      { title: "Scan", icon: "scan" },
      { title: "Add funds", icon: "arrow-down-circle" },
      { title: "Withdraw", icon: "arrow-up-circle" },
    ],
  },
}

export const ThreeActions: Story = {
  args: {
    actions: [
      { title: "Send", icon: "send" },
      { title: "Request", icon: "receive" },
      { title: "Scan", icon: "qr-code" },
    ],
  },
}

export const WithDisabled: Story = {
  args: {
    actions: [
      { title: "Send", icon: "send" },
      { title: "Request", icon: "receive", disabled: true },
      { title: "Add funds", icon: "arrow-down-circle", disabled: true },
      { title: "Withdraw", icon: "arrow-up-circle", disabled: true },
    ],
  },
}

import type { Meta, StoryObj } from "@storybook/react-vite"
import { DestructiveActionButton } from "@obsidion/web-ds"

const meta = {
  title: "Buttons/DestructiveActionButton",
  component: DestructiveActionButton,
} satisfies Meta<typeof DestructiveActionButton>

export default meta
type Story = StoryObj<typeof meta>

export const DeleteWallet: Story = {
  args: { title: "Delete wallet" },
}

export const CancelPayment: Story = {
  args: { title: "Cancel payment", icon: "x-circle" },
}

export const RemoveContact: Story = {
  args: { title: "Remove @honktheg00se" },
}

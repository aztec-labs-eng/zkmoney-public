import type { Meta, StoryObj } from "@storybook/react-vite"
import { ContactRow } from "@obsidion/web-ds"

const meta = {
  title: "Rows & Lists/ContactRow",
  component: ContactRow,
} satisfies Meta<typeof ContactRow>

export default meta
type Story = StoryObj<typeof meta>

export const L2Handle: Story = {
  args: { tag: "cyphergirl", onClick: () => {} },
}

export const L2Renamed: Story = {
  args: { tag: "cyphergirl", name: "Maya", onClick: () => {} },
}

export const L1LabeledWallet: Story = {
  args: { tag: "0x8f31…c2ab", name: "Trading Wallet", isL1: true, onClick: () => {} },
}

export const L1UnlabeledAddress: Story = {
  args: { tag: "0x1a2…9fe3", name: "External Wallet", isL1: true, onClick: () => {} },
}

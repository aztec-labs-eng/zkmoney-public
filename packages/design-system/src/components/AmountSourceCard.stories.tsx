import type { Meta, StoryObj } from "@storybook/react-vite"
import { AmountSourceCard } from "@obsidion/web-ds"

const amount = (text: string) => (
  <span style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 600 }}>{text}</span>
)

const meta = {
  title: "Payments/AmountSourceCard",
  component: AmountSourceCard,
} satisfies Meta<typeof AmountSourceCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { senderName: "You", senderHandle: "@cyphergirl", balance: 245.5, amount: amount("$50") },
}

export const WholeBalance: Story = {
  args: {
    senderName: "Goose",
    senderHandle: "@honktheg00se",
    balance: 500,
    amount: amount("$120"),
  },
}

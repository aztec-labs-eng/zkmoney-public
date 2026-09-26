import type { Meta, StoryObj } from "@storybook/react-vite"
import { TwoPartyAmountCard } from "@obsidion/web-ds"

const amount = (text: string) => (
  <span style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 600 }}>{text}</span>
)

const meta = {
  title: "Payments/TwoPartyAmountCard",
  component: TwoPartyAmountCard,
} satisfies Meta<typeof TwoPartyAmountCard>

export default meta
type Story = StoryObj<typeof meta>

export const SendReceivePair: Story = {
  args: {
    role: "youSend",
    cornerStyle: "top",
    person: { name: "You", handle: "@cyphergirl", ringed: true },
    amount: amount("$120"),
  },
  render: (args) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <TwoPartyAmountCard {...args} />
      <TwoPartyAmountCard
        role="receive"
        cornerStyle="bottom"
        person={{ name: "Goose", handle: "@honktheg00se" }}
        amount={amount("$120")}
      />
    </div>
  ),
}

export const SingleWithBalance: Story = {
  args: {
    role: "youSend",
    cornerStyle: "all",
    balance: 245.5,
    person: { name: "You", handle: "@cyphergirl", ringed: true },
    amount: amount("$50"),
  },
}

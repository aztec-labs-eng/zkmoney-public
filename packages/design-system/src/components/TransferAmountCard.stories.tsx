import type { Meta, StoryObj } from "@storybook/react-vite"
import { TransferAmountCard } from "@obsidion/web-ds"

const amount = (text: string) => (
  <span style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 600 }}>{text}</span>
)

const meta = {
  title: "Payments/TransferAmountCard",
  component: TransferAmountCard,
} satisfies Meta<typeof TransferAmountCard>

export default meta
type Story = StoryObj<typeof meta>

export const FromToPair: Story = {
  args: {
    roleLabel: "From:",
    cornerStyle: "top",
    person: { name: "You", handle: "@cyphergirl" },
    balanceText: "$245.50",
    amount: amount("$50"),
  },
  render: (args) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <TransferAmountCard {...args} />
      <TransferAmountCard
        roleLabel="To:"
        cornerStyle="bottom"
        person={{ name: "External Wallet", handle: "0x1a2…9fe3" }}
        balanceText="$0"
        amount={amount("$50")}
        amountCaption="≈ 0.0128 ETH"
      />
    </div>
  ),
}

export const BalanceLoading: Story = {
  args: {
    roleLabel: "From:",
    person: { name: "You", handle: "@cyphergirl" },
    balanceLoading: true,
    amount: amount("$50"),
  },
}

export const WithCaption: Story = {
  args: {
    roleLabel: "To:",
    person: { name: "External Wallet", handle: "0x1a2…9fe3" },
    balanceText: "$1,024",
    amount: amount("$50"),
    amountCaption: "≈ 0.0128 ETH",
  },
}

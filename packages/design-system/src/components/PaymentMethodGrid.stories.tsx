import type { Meta, StoryObj } from "@storybook/react-vite"
import { PaymentMethodGrid } from "@obsidion/web-ds"

const meta = {
  title: "Payments/PaymentMethodGrid",
  component: PaymentMethodGrid,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof PaymentMethodGrid>

export default meta
type Story = StoryObj<typeof meta>

export const NewPayment: Story = {
  args: {
    methods: [
      { label: "Send", icon: "send" },
      { label: "Receive", icon: "receive" },
      { label: "Link", icon: "link" },
      { label: "Scan", icon: "scan" },
      { label: "Bank", icon: "bank" },
      { label: "Email", icon: "mail" },
      { label: "Card", icon: "wallet", disabled: true },
      { label: "Deposit", icon: "tray-deposit" },
      { label: "Withdraw", icon: "tray-withdraw" },
    ],
  },
}

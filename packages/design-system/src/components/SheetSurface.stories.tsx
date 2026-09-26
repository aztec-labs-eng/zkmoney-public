import type { Meta, StoryObj } from "@storybook/react-vite"
import { SheetSurface } from "@obsidion/web-ds"

const body = {
  padding: "32px 24px 24px",
  display: "flex",
  flexDirection: "column" as const,
  gap: 8,
}
const title = { fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600, color: "#fff" }
const line = { fontFamily: "var(--font-body)", fontSize: 14, color: "var(--text-secondary)" }

const meta = {
  title: "Sheets & Modals/SheetSurface",
  component: SheetSurface,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof SheetSurface>

export default meta
type Story = StoryObj<typeof meta>

export const FloatingCard: Story = {
  args: {
    corners: "all",
    children: (
      <div style={body}>
        <span style={title}>Payment received</span>
        <span style={line}>@cyphergirl sent you $25.00.</span>
        <span style={line}>Funds are already private and spendable.</span>
      </div>
    ),
  },
}

export const BottomDocked: Story = {
  args: {
    corners: "top",
    children: (
      <div style={body}>
        <span style={title}>Withdraw to Ethereum</span>
        <span style={line}>Withdrawals exit through a one-time stealth address.</span>
        <span style={line}>Finalization on L1 usually takes a few minutes.</span>
      </div>
    ),
  },
}

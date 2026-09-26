import type { Meta, StoryObj } from "@storybook/react-vite"
import { GlassRowCard } from "@obsidion/web-ds"

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{value}</span>
    </div>
  )
}

const meta = {
  title: "Rows & Lists/GlassRowCard",
  component: GlassRowCard,
} satisfies Meta<typeof GlassRowCard>

export default meta
type Story = StoryObj<typeof meta>

export const PaymentDetails: Story = {
  args: {
    children: (
      <>
        <DetailRow label="To" value="@honktheg00se" />
        <DetailRow label="Amount" value="$50.00" />
        <DetailRow label="Network fee" value="$0.12" />
        <DetailRow label="Total" value="$50.12" />
      </>
    ),
  },
}

export const CompactSpacing: Story = {
  args: {
    rowSpacing: 10,
    padding: 14,
    radius: 16,
    children: (
      <>
        <DetailRow label="From" value="@cyphergirl" />
        <DetailRow label="Sent" value="Today, 11:15" />
      </>
    ),
  },
}

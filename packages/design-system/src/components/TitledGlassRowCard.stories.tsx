import type { Meta, StoryObj } from "@storybook/react-vite"
import { RowChevron, SettingsRow, TitledGlassRowCard } from "@obsidion/web-ds"

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{value}</span>
    </div>
  )
}

const meta = {
  title: "Rows & Lists/TitledGlassRowCard",
  component: TitledGlassRowCard,
} satisfies Meta<typeof TitledGlassRowCard>

export default meta
type Story = StoryObj<typeof meta>

export const TransactionDetails: Story = {
  args: {
    title: "Details",
    children: (
      <>
        <DetailRow label="To" value="@honktheg00se" />
        <DetailRow label="Amount" value="$50.00" />
        <DetailRow label="Network fee" value="$0.12" />
      </>
    ),
  },
}

export const SecurityGroup: Story = {
  args: {
    title: "Security",
    children: (
      <>
        <SettingsRow
          icon="lock"
          label="Change passcode"
          onClick={() => {}}
          trailing={<RowChevron />}
        />
        <SettingsRow
          icon="fingerprint"
          label="Face ID"
          trailing={<span style={{ color: "var(--text-secondary)", fontSize: 14 }}>On</span>}
        />
      </>
    ),
  },
}

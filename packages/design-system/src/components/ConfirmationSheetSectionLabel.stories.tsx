import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  ConfirmationSheetDetailRow,
  ConfirmationSheetPartyCard,
  ConfirmationSheetSectionLabel,
  GradientInitialAvatar,
} from "@obsidion/web-ds"

const sheet = { background: "var(--surface-sheet)", borderRadius: 24, padding: 24 }

const meta = {
  title: "Sheets & Modals/ConfirmationSheetSectionLabel",
  component: ConfirmationSheetSectionLabel,
} satisfies Meta<typeof ConfirmationSheetSectionLabel>

export default meta
type Story = StoryObj<typeof meta>

export const AboveWhoCard: Story = {
  args: { children: "To" },
  render: (args) => (
    <div style={{ width: 360 }}>
      <div style={{ ...sheet, display: "flex", flexDirection: "column", gap: 8 }}>
        <ConfirmationSheetSectionLabel {...args} />
        <ConfirmationSheetPartyCard
          name="@cyphergirl"
          handle="zk.money"
          trailingText="$25.00"
          avatar={<GradientInitialAvatar name="cyphergirl" size={40} />}
        />
      </div>
    </div>
  ),
}

export const AboveDetails: Story = {
  args: { children: "Details" },
  render: (args) => (
    <div style={{ width: 360 }}>
      <div style={{ ...sheet, display: "flex", flexDirection: "column", gap: 8 }}>
        <ConfirmationSheetSectionLabel {...args} />
        <div>
          <ConfirmationSheetDetailRow label="Fee" value="$0.02" />
          <ConfirmationSheetDetailRow label="Time" value="~30s" />
        </div>
      </div>
    </div>
  ),
}

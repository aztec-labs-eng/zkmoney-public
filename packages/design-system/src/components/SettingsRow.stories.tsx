import type { Meta, StoryObj } from "@storybook/react-vite"
import { GlassRowCard, RowChevron, SettingsRow } from "@obsidion/web-ds"

const meta = {
  title: "Rows & Lists/SettingsRow",
  component: SettingsRow,
} satisfies Meta<typeof SettingsRow>

export default meta
type Story = StoryObj<typeof meta>

export const AccountGroup: Story = {
  args: { icon: "person", label: "Account", onClick: () => {}, trailing: <RowChevron /> },
  render: (args) => (
    <GlassRowCard>
      <SettingsRow {...args} />
      <SettingsRow icon="lock" label="Security" onClick={() => {}} trailing={<RowChevron />} />
      <SettingsRow icon="bell" label="Notifications" onClick={() => {}} trailing={<RowChevron />} />
    </GlassRowCard>
  ),
}

export const ValueRow: Story = {
  args: {
    icon: "wallet",
    label: "Network",
    trailing: <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>Aztec Mainnet</span>,
  },
}

export const DisabledRow: Story = {
  args: { icon: "fingerprint", label: "Face ID unlock", disabled: true, trailing: <RowChevron /> },
}

import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  ConfirmationSheetDetailRow,
  ConfirmationSheetPartyCard,
  ConfirmationSheetSectionLabel,
  ConfirmationSheetShell,
  GradientInitialAvatar,
  PrimaryGradientButton,
} from "@obsidion/web-ds"

const sheet = { background: "var(--surface-sheet)", borderRadius: 24 }

const meta = {
  title: "Sheets & Modals/ConfirmationSheetShell",
  component: ConfirmationSheetShell,
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <div style={sheet}>{Story()}</div>
      </div>
    ),
  ],
} satisfies Meta<typeof ConfirmationSheetShell>

export default meta
type Story = StoryObj<typeof meta>

export const ConfirmSend: Story = {
  args: {
    title: "Confirm send",
    onClose: () => {},
    primaryAction: <PrimaryGradientButton title="Confirm" />,
    children: (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ConfirmationSheetSectionLabel>To</ConfirmationSheetSectionLabel>
        <ConfirmationSheetPartyCard
          name="@cyphergirl"
          handle="zk.money"
          trailingText="$25.00"
          avatar={<GradientInitialAvatar name="cyphergirl" size={40} />}
        />
        <div style={{ marginTop: 8 }}>
          <ConfirmationSheetDetailRow label="Fee" value="$0.02" />
          <ConfirmationSheetDetailRow label="Total" value="$25.02" />
          <ConfirmationSheetDetailRow label="Time" value="~30s" />
        </div>
      </div>
    ),
  },
}

export const ConfirmWithdrawNoBack: Story = {
  args: {
    title: "Confirm withdrawal",
    primaryAction: <PrimaryGradientButton title="Withdraw" />,
    children: (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ConfirmationSheetSectionLabel>Withdraw to</ConfirmationSheetSectionLabel>
        <ConfirmationSheetPartyCard
          name="Ethereum wallet"
          handle="0x84f3…9c21"
          trailingText="$110.00"
          avatar={<GradientInitialAvatar name="Ethereum" size={40} />}
        />
        <div style={{ marginTop: 8 }}>
          <ConfirmationSheetDetailRow label="Network fee" value="$0.85" />
          <ConfirmationSheetDetailRow label="Total" value="$110.85" />
        </div>
      </div>
    ),
  },
}

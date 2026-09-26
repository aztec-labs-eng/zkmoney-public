import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConfirmationSheetPartyCard, GradientInitialAvatar } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/ConfirmationSheetPartyCard",
  component: ConfirmationSheetPartyCard,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof ConfirmationSheetPartyCard>

export default meta
type Story = StoryObj<typeof meta>

export const Plain: Story = {
  args: {
    name: "@cyphergirl",
    handle: "zk.money",
    trailingText: "$25.00",
    avatar: <GradientInitialAvatar name="cyphergirl" size={40} />,
  },
}

export const LinkedBadge: Story = {
  args: {
    name: "@archie",
    nameBadge: "Linked",
    handle: "archie.zk.money",
    trailingText: "$12.00",
    avatar: <GradientInitialAvatar name="archie" size={40} />,
  },
}

export const IncomingGreen: Story = {
  args: {
    name: "@honktheg00se",
    handle: "zk.money",
    trailingText: "+$50.00",
    trailingColor: "#56E79D",
    trailingSubtitle: "zkUSD",
    avatar: <GradientInitialAvatar name="honktheg00se" size={40} />,
  },
}

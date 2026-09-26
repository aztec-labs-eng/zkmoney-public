import type { Meta, StoryObj } from "@storybook/react-vite"
import { PromoBanner } from "@obsidion/web-ds"

const meta = {
  title: "Banners/PromoBanner",
  component: PromoBanner,
  decorators: [(Story) => <div style={{ width: 340 }}>{Story()}</div>],
} satisfies Meta<typeof PromoBanner>

export default meta
type Story = StoryObj<typeof meta>

export const InviteFriends: Story = {
  args: {
    title: "Invite friends and earn up to $50.",
    ctaLabel: "Invite friends",
    onCta: () => {},
    onDismiss: () => {},
  },
}

export const Notifications: Story = {
  args: {
    icon: "bell",
    title: "Catch incoming payments the moment they land.",
    ctaLabel: "Enable notifications",
    onCta: () => {},
  },
}

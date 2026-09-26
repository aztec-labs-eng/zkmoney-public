import type { Meta, StoryObj } from "@storybook/react-vite"
import { StoryRingAvatar } from "@obsidion/web-ds"

const meta = {
  title: "Avatars/StoryRingAvatar",
  component: StoryRingAvatar,
} satisfies Meta<typeof StoryRingAvatar>

export default meta
type Story = StoryObj<typeof meta>

export const UnviewedGold: Story = {
  args: { name: "@cyphergirl" },
}

export const HomeTopBar: Story = {
  args: { name: "@archie", unviewedRingColor: "#A000FF", showNotificationDot: true },
}

export const Viewed: Story = {
  args: { name: "@honktheg00se", hasUnviewedStory: false },
}

export const Large: Story = {
  args: { name: "@dana", size: 64, ringWidth: 3, ringGap: 3 },
}

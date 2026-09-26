import type { Meta, StoryObj } from "@storybook/react-vite"
import { LiquidGlassPill } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/LiquidGlassPill",
  component: LiquidGlassPill,
} satisfies Meta<typeof LiquidGlassPill>

export default meta
type Story = StoryObj<typeof meta>

export const Neutral: Story = {
  args: { label: "Received", icon: "reply", iconLeading: true },
}

export const GoldRequest: Story = {
  args: {
    label: "Owes you",
    icon: "clock",
    foreground: "#EED04E",
    tint: "#EED04E",
    tintOpacity: 0.18,
    fallbackFill: "rgba(238,208,78,0.08)",
  },
}

export const RoleChip: Story = {
  args: { label: "You send", icon: "arrowshape-right", labelTracking: -0.11, shadowRadius: 10.9 },
}

export const LabelOnly: Story = {
  args: { label: "zk.money" },
}

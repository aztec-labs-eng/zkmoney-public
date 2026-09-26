import type { Meta, StoryObj } from "@storybook/react-vite"
import { GradientText } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/GradientText",
  component: GradientText,
} satisfies Meta<typeof GradientText>

export default meta
type Story = StoryObj<typeof meta>

export const BrandLabel: Story = {
  args: { gradient: "brand", children: "zk.money" },
}

export const BrandTitle: Story = {
  args: { gradient: "brand", size: 28, weight: 600, children: "zk.money" },
}

export const TitleGradient: Story = {
  args: { size: 20, children: "Payments" },
}

export const TitleAmount: Story = {
  args: { size: 32, weight: 700, children: "$1,024.00" },
}

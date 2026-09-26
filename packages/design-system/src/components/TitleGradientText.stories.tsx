import type { Meta, StoryObj } from "@storybook/react-vite"
import { TitleGradientText } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/TitleGradientText",
  component: TitleGradientText,
} satisfies Meta<typeof TitleGradientText>

export default meta
type Story = StoryObj<typeof meta>

export const SectionTitle: Story = {
  args: { children: "Payments" },
}

export const CardTitle: Story = {
  args: { size: 16, children: "Recent activity" },
}

export const ContactHandle: Story = {
  args: { size: 16, weight: 500, family: "body", children: "@cyphergirl" },
}

export const HeroAmount: Story = {
  args: { size: 34, weight: 700, children: "$1,024.00" },
}

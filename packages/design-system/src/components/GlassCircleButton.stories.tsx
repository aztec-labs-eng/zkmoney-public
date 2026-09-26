import type { Meta, StoryObj } from "@storybook/react-vite"
import { GlassCircleButton, Icon } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/GlassCircleButton",
  component: GlassCircleButton,
} satisfies Meta<typeof GlassCircleButton>

export default meta
type Story = StoryObj<typeof meta>

export const Close: Story = {
  args: {
    onClick: () => {},
    ariaLabel: "Close",
    children: <Icon name="x" size={14} color="#fff" />,
  },
}

export const Profile: Story = {
  args: {
    onClick: () => {},
    ariaLabel: "Profile",
    children: <Icon name="person" size={16} color="#fff" />,
  },
}

export const Decorative: Story = {
  args: { children: <Icon name="bell" size={16} color="#fff" /> },
}

export const Large: Story = {
  args: {
    onClick: () => {},
    size: 56,
    ariaLabel: "Scan QR",
    children: <Icon name="scan" size={20} color="#fff" />,
  },
}

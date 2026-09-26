import type { Meta, StoryObj } from "@storybook/react-vite"
import { GradientInitialAvatar } from "@obsidion/web-ds"

const meta = {
  title: "Avatars/GradientInitialAvatar",
  component: GradientInitialAvatar,
} satisfies Meta<typeof GradientInitialAvatar>

export default meta
type Story = StoryObj<typeof meta>

export const Contact: Story = {
  args: { name: "@cyphergirl" },
}

export const CurrentUserRinged: Story = {
  args: { name: "@archie", size: 64, ringed: true },
}

export const CustomColors: Story = {
  args: { name: "@honktheg00se", colors: ["#FF7A00", "#FE708B"] },
}

export const Sizes: Story = {
  args: { name: "@cyphergirl" },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <GradientInitialAvatar name="@cyphergirl" size={32} />
      <GradientInitialAvatar name="@honktheg00se" size={44} />
      <GradientInitialAvatar name="@archie" size={64} />
      <GradientInitialAvatar name="@dana" size={96} />
    </div>
  ),
}

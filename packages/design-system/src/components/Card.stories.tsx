import type { Meta, StoryObj } from "@storybook/react-vite"
import { Card, TitleGradientText } from "@obsidion/web-ds"

const meta = {
  title: "Foundations/Card",
  component: Card,
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Basic: Story = {
  args: {
    style: { width: 300 },
    children: (
      <>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Payment sent</div>
        <div style={{ fontSize: 12, color: "#BFC2D7", marginTop: 4 }}>
          @honktheg00se &middot; Today, 09:41
        </div>
      </>
    ),
  },
}

export const TitledPanel: Story = {
  args: {
    radius: 16,
    padding: 16,
    style: { width: 300 },
    children: (
      <>
        <TitleGradientText size={16}>Recent activity</TitleGradientText>
        <div style={{ fontSize: 12, color: "#BFC2D7", marginTop: 8 }}>
          3 payments this week &middot; $87.80 total
        </div>
      </>
    ),
  },
}

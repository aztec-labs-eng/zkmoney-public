import type { Meta, StoryObj } from "@storybook/react-vite"
import { TopNavIconButton } from "@obsidion/web-ds"

const meta = {
  title: "Buttons/TopNavIconButton",
  component: TopNavIconButton,
} satisfies Meta<typeof TopNavIconButton>

export default meta
type Story = StoryObj<typeof meta>

export const Search: Story = {
  args: { icon: "search", ariaLabel: "Search" },
}

export const Filter: Story = {
  args: { icon: "filter", ariaLabel: "Filter" },
}

export const TrailingCluster: Story = {
  args: { icon: "qr-code", ariaLabel: "Show QR" },
  render: () => (
    <div style={{ display: "flex", gap: 8 }}>
      <TopNavIconButton icon="qr-code" ariaLabel="Show QR" />
      <TopNavIconButton icon="bell" ariaLabel="Notifications" />
      <TopNavIconButton icon="ellipsis" ariaLabel="More" />
    </div>
  ),
}

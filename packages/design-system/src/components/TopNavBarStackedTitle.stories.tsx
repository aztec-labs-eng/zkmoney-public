import type { Meta, StoryObj } from "@storybook/react-vite"
import { TopNavBar, TopNavBarStackedTitle, TopNavIconButton } from "@obsidion/web-ds"

const meta = {
  title: "Navigation/TopNavBarStackedTitle",
  component: TopNavBarStackedTitle,
} satisfies Meta<typeof TopNavBarStackedTitle>

export default meta
type Story = StoryObj<typeof meta>

export const Standalone: Story = {
  args: { name: "@cyphergirl", handle: "cyphergirl.zk.money" },
}

export const InNavBar: Story = {
  args: { name: "@archie", handle: "archie.zk.money" },
  render: (args) => (
    <div style={{ width: 360 }}>
      <TopNavBar
        titleNode={<TopNavBarStackedTitle {...args} />}
        leading={<TopNavIconButton icon="arrow-left" ariaLabel="Back" />}
        trailing={<TopNavIconButton icon="ellipsis" ariaLabel="More" />}
      />
    </div>
  ),
}

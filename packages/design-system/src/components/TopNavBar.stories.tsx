import type { Meta, StoryObj } from "@storybook/react-vite"
import { action } from "storybook/actions"
import { TopNavBar, TopNavBarStackedTitle, TopNavIconButton } from "@obsidion/web-ds"

const meta = {
  title: "Navigation/TopNavBar",
  component: TopNavBar,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof TopNavBar>

export default meta
type Story = StoryObj<typeof meta>

export const ActivityTitle: Story = {
  args: {
    title: "Activity",
    leading: <TopNavIconButton icon="search" ariaLabel="Search" onClick={action("search")} />,
    trailing: <TopNavIconButton icon="filter" ariaLabel="Filter" onClick={action("filter")} />,
  },
}

export const ContactStackedTitle: Story = {
  args: {
    titleNode: <TopNavBarStackedTitle name="@cyphergirl" handle="cyphergirl.zk.money" />,
    leading: <TopNavIconButton icon="arrow-left" ariaLabel="Back" onClick={action("back")} />,
    trailing: <TopNavIconButton icon="ellipsis" ariaLabel="More" onClick={action("more")} />,
  },
}

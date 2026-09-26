import type { Meta, StoryObj } from "@storybook/react-vite"
import { ScreenNavBar, TopNavIconButton } from "@obsidion/web-ds"

const meta = {
  title: "Navigation/ScreenNavBar",
  component: ScreenNavBar,
  decorators: [(Story) => <div style={{ width: 360 }}>{Story()}</div>],
} satisfies Meta<typeof ScreenNavBar>

export default meta
type Story = StoryObj<typeof meta>

export const CenteredBack: Story = {
  args: { title: "Send", onLeading: () => {} },
}

export const LeadingCloseWithSubtitle: Story = {
  args: {
    title: "New payment",
    subtitle: "Choose who to pay",
    leadingIcon: "close",
    titleAlignment: "leading",
    onLeading: () => {},
  },
}

export const WithTrailingAction: Story = {
  args: {
    title: "@archie",
    onLeading: () => {},
    trailing: <TopNavIconButton icon="ellipsis" ariaLabel="More" />,
  },
}

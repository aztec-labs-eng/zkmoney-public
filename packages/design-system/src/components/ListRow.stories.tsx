import type { Meta, StoryObj } from "@storybook/react-vite"
import { ComingSoonPill, IconCircle, ListRow, RowChevron } from "@obsidion/web-ds"

const meta = {
  title: "Rows & Lists/ListRow",
  component: ListRow,
} satisfies Meta<typeof ListRow>

export default meta
type Story = StoryObj<typeof meta>

export const TagMethod: Story = {
  args: {
    title: "zk.money tag",
    subtitle: "Send instantly to any @tag",
    leading: <IconCircle name="at" />,
    trailing: <RowChevron />,
  },
}

export const EmailMethod: Story = {
  args: {
    title: "Email",
    subtitle: "Send to anyone with an email address",
    leading: <IconCircle name="mail" />,
    trailing: <RowChevron />,
  },
}

export const CardComingSoon: Story = {
  args: {
    title: "Card payment",
    subtitle: "Top up with a debit card",
    disabled: true,
    floatingTrailing: true,
    leading: <IconCircle name="wallet" />,
    trailing: <ComingSoonPill />,
  },
}

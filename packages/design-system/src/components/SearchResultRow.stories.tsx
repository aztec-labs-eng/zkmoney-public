import type { Meta, StoryObj } from "@storybook/react-vite"
import { SearchResultRow } from "@obsidion/web-ds"

const meta = {
  title: "Rows & Lists/SearchResultRow",
  component: SearchResultRow,
} satisfies Meta<typeof SearchResultRow>

export default meta
type Story = StoryObj<typeof meta>

export const TagResult: Story = {
  args: { title: "@honktheg00se", subtitle: "zk.money", onClick: () => {} },
}

export const EmailResult: Story = {
  args: { title: "goose@gmail.com", subtitle: "Send via email paylink", onClick: () => {} },
}

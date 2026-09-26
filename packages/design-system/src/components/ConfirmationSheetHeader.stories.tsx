import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConfirmationSheetHeader } from "@obsidion/web-ds"

const sheet = { background: "var(--surface-sheet)", borderRadius: 24, padding: "16px 24px" }

const meta = {
  title: "Sheets & Modals/ConfirmationSheetHeader",
  component: ConfirmationSheetHeader,
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <div style={sheet}>{Story()}</div>
      </div>
    ),
  ],
} satisfies Meta<typeof ConfirmationSheetHeader>

export default meta
type Story = StoryObj<typeof meta>

export const WithBack: Story = {
  args: { title: "Confirm send", onClose: () => {} },
}

export const TitleOnly: Story = {
  args: { title: "Review request" },
}

import type { Meta, StoryObj } from "@storybook/react-vite"
import { InfoBox } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/InfoBox",
  component: InfoBox,
  decorators: [
    (Story) => (
      <div
        style={{ width: 372, padding: 24, borderRadius: 24, background: "var(--surface-sheet)" }}
      >
        {Story()}
      </div>
    ),
  ],
} satisfies Meta<typeof InfoBox>

export default meta
type Story = StoryObj<typeof meta>

export const OldLinks: Story = {
  args: {
    title: "Old request links will stop working",
    children: "Once your backup is set up, create new ones.",
  },
}

export const QuickCleanup: Story = {
  args: {
    title: "Quick cleanup",
    children:
      "There's now a passkey on your security key that isn't linked to this account. You can delete it in the key's settings.",
  },
}

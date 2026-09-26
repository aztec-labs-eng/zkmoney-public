import type { Meta, StoryObj } from "@storybook/react-vite"
import { Toast } from "@obsidion/web-ds"

const meta = {
  title: "Status & Feedback/Toast",
  component: Toast,
} satisfies Meta<typeof Toast>

export default meta
type Story = StoryObj<typeof meta>

export const Success: Story = {
  args: { kind: "success", message: "All set, sending now.", onDismiss: () => {} },
}

export const ErrorState: Story = {
  args: { kind: "error", message: "Something went wrong!" },
}

export const Progress: Story = {
  args: {
    kind: "progress",
    message: "Keeping it private…",
    actionLabel: "Open",
    onAction: () => {},
  },
}

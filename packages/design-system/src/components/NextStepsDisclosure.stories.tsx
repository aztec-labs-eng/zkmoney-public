import type { Meta, StoryObj } from "@storybook/react-vite"
import { NextStepsDisclosure } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/NextStepsDisclosure",
  component: NextStepsDisclosure,
  decorators: [
    (Story) => (
      <div
        style={{ width: 372, padding: 24, borderRadius: 24, background: "var(--surface-sheet)" }}
      >
        {Story()}
      </div>
    ),
  ],
} satisfies Meta<typeof NextStepsDisclosure>

export default meta
type Story = StoryObj<typeof meta>

export const WhatHappensNext: Story = {
  args: {
    title: "What happens next?",
    steps: [
      { label: "Save the backup", detail: "On your phone or a security key" },
      { label: "Approve with This Mac", detail: "The passkey you signed in with" },
      { label: "Wait for the network", detail: "Up to 40 min. Feel free to close this tab." },
      { label: "Approve to finish", detail: "We'll remind you on Home" },
    ],
  },
}

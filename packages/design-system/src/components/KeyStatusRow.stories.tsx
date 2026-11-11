import type { Meta, StoryObj } from "@storybook/react-vite"
import { KeyStatusRow, SheetCard } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/KeyStatusRow",
  component: KeyStatusRow,
  decorators: [
    (Story) => (
      <div
        style={{ width: 372, padding: 24, borderRadius: 24, background: "var(--surface-sheet)" }}
      >
        <SheetCard label="On this account">{Story()}</SheetCard>
      </div>
    ),
  ],
} satisfies Meta<typeof KeyStatusRow>

export default meta
type Story = StoryObj<typeof meta>

export const Added: Story = {
  args: { name: "Sign-up passkey", detail: "This Mac · iCloud Keychain", status: "added" },
}

export const Missing: Story = {
  args: { name: "Backup passkey", detail: "Not added", status: "missing" },
}

export const BothKeys: Story = {
  args: Added.args,
  render: () => (
    <>
      <KeyStatusRow {...Added.args} />
      <KeyStatusRow
        name="Backup passkey"
        detail="Your phone · Google Password Manager"
        status="added"
      />
    </>
  ),
}

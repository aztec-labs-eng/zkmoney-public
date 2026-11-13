import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { ChoiceCard, SheetLink } from "@obsidion/web-ds"

const meta = {
  title: "Sheets & Modals/ChoiceCard",
  component: ChoiceCard,
  decorators: [
    (Story) => (
      <div
        style={{
          width: 372,
          padding: 24,
          borderRadius: 24,
          background: "var(--surface-sheet)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {Story()}
      </div>
    ),
  ],
} satisfies Meta<typeof ChoiceCard>

export default meta
type Story = StoryObj<typeof meta>

export const Checked: Story = {
  args: {
    name: "place",
    value: "phone",
    checked: true,
    onChange: () => {},
    label: "Your phone",
    badge: "Recommended",
    description:
      "Scan a QR code and save it to iCloud Keychain, Google Password Manager or 1Password.",
  },
}

export const Unchecked: Story = {
  args: {
    name: "place",
    value: "key",
    checked: false,
    onChange: () => {},
    label: "Security key",
    description: "A YubiKey 5 or newer. Some older keys can't hold a backup.",
  },
}

export const Disabled: Story = {
  args: { ...Unchecked.args, disabled: true },
}

/** Help under the description: following the link leaves the choice as it was. */
export const WithHelp: Story = {
  args: {
    ...Checked.args,
    description: "Scan a QR code and save it on your phone.",
    children: <SheetLink label="Which passkey managers work?" href="https://zk.money" />,
  },
}

function Group() {
  const [place, setPlace] = useState("phone")
  const options = [
    {
      value: "phone",
      label: "Your phone",
      badge: "Recommended",
      description: Checked.args.description,
    },
    { value: "key", label: "Security key", description: Unchecked.args.description },
    {
      value: "mac",
      label: "This Mac",
      description: "Only works if this Mac syncs passkeys to your other devices.",
    },
  ]
  return (
    <>
      {options.map((option) => (
        <ChoiceCard
          key={option.value}
          name="place-group"
          checked={place === option.value}
          onChange={setPlace}
          {...option}
        />
      ))}
    </>
  )
}

/** Three cards sharing one name: picking one unpicks the others. */
export const OneChoice: Story = {
  args: Checked.args,
  render: () => <Group />,
}

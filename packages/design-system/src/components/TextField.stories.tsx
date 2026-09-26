import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { TextField, type TextFieldProps } from "@obsidion/web-ds"

const meta = {
  title: "Forms/TextField",
  component: TextField,
} satisfies Meta<typeof TextField>

export default meta
type Story = StoryObj<typeof meta>

function Controlled(props: Omit<TextFieldProps, "value" | "onChange">) {
  const [value, setValue] = useState("")
  return <TextField {...props} value={value} onChange={setValue} style={{ width: 340 }} />
}

export const Email: Story = {
  args: { value: "", onChange: () => {} },
  render: () => <Controlled label="Email" placeholder="example@email.com" type="email" inputMode="email" />,
}

export const WithTrailingChip: Story = {
  args: { value: "", onChange: () => {} },
  render: () => (
    <Controlled
      label="Payment link"
      placeholder="Paste your link"
      trailing={
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#fff",
            background: "var(--surface-strong)",
            borderRadius: "var(--radius-full)",
            padding: "4px 12px",
            cursor: "pointer",
          }}
        >
          Paste
        </span>
      }
    />
  ),
}

export const ErrorState: Story = {
  args: {
    value: "not-an-email",
    onChange: () => {},
    label: "Email",
    error: "That doesn't look like an email address.",
    style: { width: 340 },
  },
}

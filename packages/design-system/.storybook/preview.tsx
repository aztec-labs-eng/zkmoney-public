import type { Preview } from "@storybook/react-vite"
import { ZkMoneyRoot } from "@obsidion/web-ds"

import "../src/styles/styles.css"
import "../src/styles/cards-modals.css"
import "../fonts/fonts.css"

const preview: Preview = {
  parameters: {
    options: {
      storySort: {
        order: [
          "Overview",
          "Foundations",
          "Buttons",
          "Avatars",
          "Status & Feedback",
          "Rows & Lists",
          "Navigation",
          "Payments",
          "Sheets & Modals",
          "Banners",
          "Backgrounds",
        ],
      },
    },
    backgrounds: {
      options: {
        canvas: { name: "Canvas", value: "#181818" },
        sheet: { name: "Sheet", value: "#212121" },
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  initialGlobals: {
    backgrounds: { value: "canvas" },
  },
  decorators: [
    (Story) => (
      <ZkMoneyRoot>
        <Story />
      </ZkMoneyRoot>
    ),
  ],
}

export default preview

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
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: { icon: "contrast", items: ["dark", "light"], dynamicTitle: true },
    },
  },
  initialGlobals: {
    backgrounds: { value: "canvas" },
    theme: "dark",
  },
  decorators: [
    (Story, { globals }) => {
      if (globals.theme === "light") document.documentElement.dataset.theme = "light"
      else delete document.documentElement.dataset.theme
      return (
        <ZkMoneyRoot>
          <Story />
        </ZkMoneyRoot>
      )
    },
  ],
}

export default preview

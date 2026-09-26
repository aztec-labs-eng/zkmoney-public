---
category: Backgrounds
---
The app-wide dark "aurora" screen background: three stacked radial washes (violet, indigo, cyan) descending down the canvas over `#070707`. This is the default canvas for the home and activity tabs.

Absolutely fills its nearest positioned ancestor, so wrap it in a `position: relative; overflow: hidden` container sized to the screen or frame. Screen content goes in `children`, which renders above the washes.

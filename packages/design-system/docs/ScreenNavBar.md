---
category: Navigation
---
Standard nav bar for pushed and modal screens: a glass back/close circle, title (optional subtitle), and an optional trailing slot. `leadingIcon` picks "back" or "close"; omit `onLeading` to hide the button while keeping the title position stable. Default is a true-centered title; `titleAlignment="leading"` left-aligns title + subtitle next to the button, which suits modal flows like "New payment".

Put a `TopNavIconButton` in `trailing` for screen-level actions (e.g. "ellipsis").

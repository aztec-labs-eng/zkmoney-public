---
category: Foundations
---
The vector icon set: custom glyphs traced from the iOS app plus generic 24x24 line icons. `name` takes a canonical name ("send", "qr-code") or an SF Symbol alias from the SwiftUI app ("paperplane.fill"); unknown names render nothing. `size` sets height (width follows the glyph's aspect ratio); color inherits from text color unless `color` is set.

Every icon slot in the system (buttons, rows, pills, nav bars) renders through this component. Never inline your own SVGs.

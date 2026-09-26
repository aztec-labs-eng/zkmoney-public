---
category: Navigation
---
Top nav for tab-root screens (Activity, contact detail). The title stays at true center regardless of how wide the `leading`/`trailing` slots are; fill those slots with `TopNavIconButton` glass circles ("search", "filter", "ellipsis", "arrow-left"). For contact screens pass `titleNode={<TopNavBarStackedTitle …/>}` instead of a plain `title` to show name over handle.

Use `ScreenNavBar` instead on pushed/modal screens that need a back or close affordance.

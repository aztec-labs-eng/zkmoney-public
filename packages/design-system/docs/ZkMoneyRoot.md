---
category: Foundations
---
The dark app canvas every zk.money surface sits on: #181818 background, primary text color, Sen body font, 16px padding (`flush` removes it). Wrap the whole screen in it exactly once; components are designed for dark surfaces and are illegible on white.

All other DS components assume they render inside this provider.

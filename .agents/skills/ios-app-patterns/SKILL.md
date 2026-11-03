---
name: ios-app-patterns
description: Tested SwiftUI patterns for the Cloud SWE iOS app (ios/). Covers bottom-pinned views and safeAreaInset stacking, accessibility (VoiceOver, Dynamic Type, reduced motion), image caching, scroll and grid performance, Swift Testing, XCUITest smoke tests, launch-time and signpost profiling, and cancelling Tasks in @Observable models. Use when building or reviewing a SwiftUI screen, a feed or grid, tests, or performance work in the iOS app.
---

# iOS app patterns

Eight documents from [alpozcan/iOSAgentSkills](https://github.com/alpozcan/iOSAgentSkills) (MIT, see LICENSE), picked
for this app. Read only the one the task needs.

| Task | Read |
| --- | --- |
| Pinning controls above the tab bar or home indicator; views hidden behind a `safeAreaInset` | `references/17-safe-area-inset-stacking-and-bottom-pinned-views.md` |
| VoiceOver order, Dynamic Type, reduced motion, contrast, accessibility identifiers | `references/21-accessibility-voiceover-dynamic-type-patterns.md` |
| Thumbnail loading and `URLCache` limits in long grids | `references/28-asyncimage-cache-management.md` |
| Jank or layout jumps in a `LazyVStack` or `LazyVGrid` | `references/29-scroll-performance-layout-stability.md` |
| Unit tests with Swift Testing | `references/05-swift-testing-and-tdd-patterns.md` |
| XCUITest smoke tests driven by launch arguments | `references/18-ui-testing-regression-and-smoke.md` |
| Launch time, `OSSignposter` intervals, MetricKit | `references/25-performance-monitoring-and-profiling-patterns.md` |
| Tasks that outlive their view or model; leaks | `references/27-task-cancellation-and-deinit-patterns.md` |

## Adapting them to this app

The documents come from a different app, with Tuist modules, a service catalog, a custom design system and an
on-device LLM. Take the pattern, not that app's scaffolding:

- **The project:** the app is one target in `ios/CloudSWE.xcodeproj`, in Xcode 27's own format. Files in
  `ios/CloudSWE/` join the target automatically. There are no Tuist modules and no `Catalog` registrations. Inject
  dependencies through initializers or `@Environment`.
- **Links between documents:** `[[wikilinks]]` point to documents that weren't copied. Skip them.
- **Navigation:** use the system's `NavigationStack`, sheets and menus. They give Liquid Glass on iOS 27. Don't build
  custom bars.

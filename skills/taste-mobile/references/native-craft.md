# Native mobile craft — iOS, Android and React Native bare

Design for a hand-held, interruption-prone tool with real input methods,
not a miniaturized marketing page. Respect existing app architecture first.

## Information architecture

- A screen has a dominant job. Start with the task, not an oversized heading.
- Primary navigation reflects distinct destinations. Do not make an action
  behave like a destination tab. Use back behavior consistent with each OS.
- Keep the primary action reachable; don't require awkward one-handed reach
  where the use case favors one hand.
- For object collections, show actual objects before metrics. For creators,
  center the canvas/input. For utility tools, foreground the action and result.
- Contextual toolbars and sheets should do scoped work; don't put an entire
  navigation hierarchy inside nested sheets.

## Layout and typography

- Use logical density-independent layout values. Test small screens, larger
  phones, landscape only when supported, and OS display/font-size adjustments.
- Honor notch/island, bottom home indicator, status bar, keyboard and
  Android gesture navigation insets. Avoid fixed vertical screen heights.
- Prefer a small intentional type scale with strong hierarchy over many
  near-identical font sizes; typography must remain usable with system scaling.
- For React Native, preserve sensible `allowFontScaling` behavior and use
  content containers that can grow instead of truncating critical instructions.
- Use adequate text contrast and don't encode states using color alone.
- Prefer accessible touch regions: aim for **44×44 pt or larger on iOS** and
  **48×48 dp or larger on Android** for primary/custom interactive targets.
  Apple distinguishes default (44×44pt) from its minimum control guidance
  (28×28pt); do not misstate this as a universal legal minimum.
- Touch-area padding must not collide with adjacent controls; use hit slop
  sensibly and verify in the actual UI.

## Platform-specific behaviors

- **iOS:** back and modal dismissal, safe areas, Dynamic Type, VoiceOver,
  permission prompts and app-specific photo/camera access; native gestures.
- **Android:** hardware/system back, gesture navigation, predictive back as
  supported by the app stack, TalkBack, permission rationale, keyboard IME,
  edge-to-edge system bar contrast and elevation conventions.
- Share the product's visual DNA across platforms; allow navigation, sheets,
  menus, pickers and keyboard handling to feel native on each.

## Component/engineering requirements

- React Native bare CLI is the target when that's the repo stack. Do not
  silently migrate to Expo, Next.js, WebView or React Native Web.
- Reuse existing UI/styling/navigation/animation/icon libraries. Evaluate new
  dependencies for size, native setup, maintenance and actual need.
- Centralize semantic design tokens rather than distributing unexplained
  hex values and shadow recipes in components.
- Build with meaningful states: first use, populated, empty, search-no-results,
  loading/progress, errors, recoverability, offline, permissions denied,
  destructive confirmation and large text.
- Support actual localization expansion, not all-caps tiny tracked labels.
- Accessible names for icon-only buttons, grouping, selected/disabled states,
  focus order, dynamic type, screen reader narration, error identification.
- Test navigation transitions while the keyboard is open and with external
  permission flows; don't rely solely on static screen screenshots.

## Asset provenance

Use existing brand assets where possible. Source licensed imagery or create
original imagery with tools available to the agent. Record source/license when
needed. No fake brand logo/photo/screenshot passed off as real.

## Source guidance (check latest as needed)

- Apple HIG: https://developer.apple.com/design/human-interface-guidelines/
- Apple accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- Android accessibility: https://developer.android.com/guide/topics/ui/accessibility/views/apps-views
- Material Design: https://m3.material.io/
- React Native Accessibility: https://reactnative.dev/docs/accessibility
- React Native Text: https://reactnative.dev/docs/text

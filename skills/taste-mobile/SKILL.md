---
name: taste-mobile
description: >-
  Native mobile art direction and anti-slop design workflow for iOS, Android and
  React Native (including bare CLI). Use for designing, redesigning, polishing,
  implementing, or visually reviewing mobile apps when the goal is a distinctive,
  premium, coherent, world-class-feeling interface. Research product-specific
  references, explore three genuinely different visual directions, define a
  design system and signature interaction, then run and visually inspect the
  real app using the coding agent's existing tools. Avoid generic AI UI.
compatibility: >-
  Codex, Claude Code and other SKILL.md agents. No required MCP, browser,
  Maestro, Expo or UI-automation dependency. Node.js 18+ optional for the
  bundled direction selector.
---

# Taste Mobile

**Mission:** make an app feel designed *for its specific job and audience*, rather
than like a reusable AI-generated template. Produce a coherent design and a
working, inspectable native experience—not merely attractive mockups.

This is a mobile-first adaptation of the *method* behind
[Taste Skill](https://github.com/Leonxlnx/taste-skill): choose a direction,
extract a concept from the subject, reject generic defaults, then look at and
improve rendered work. It is not a drop-in port of Taste Skill's web scripts.
See `NOTICE.md` for attribution and scope.

## When invoked: pick the smallest appropriate mode

- **Explore** (new app, new visual identity, "find the right style"):
  research → three directions → decision → system → implementation if requested.
- **Build** (direction already selected): validate its design DNA → implement →
  inspect and refine. Do not reopen design discovery without a good reason.
- **Refine** (existing app looks generic/unfinished): inspect current screens
  *before changing them* → preserve what works → focused redesign → compare.
- **Audit** (review only): run/inspect if possible, issue a prioritized
  critique with evidence; do not change code without authorization.

For a small one-screen change, use a compact version of the process. Do not
force a full concept workshop or three directions for an icon alignment fix.

## Read supporting references on demand

| Need | Read |
|---|---|
| Research + creative discovery | `references/discovery.md` |
| Compose distinct mobile directions | `references/directions.md` |
| Native mobile craft, React Native and platform decisions | `references/native-craft.md` |
| Avoiding generic visual systems | `references/anti-slop.md` |
| Interactions, animation and haptics | `references/motion.md` |
| Real-device critique, acceptance gates and scorecard | `references/visual-qa.md` |

Use the **actual user's repository constraints** over defaults. For React Native
bare projects, **do not introduce Expo, webviews, a new UI kit, or a new testing
framework** merely to satisfy this skill. Use existing simulator/device/GUI
capabilities provided to the coding agent.

## The run

### 1. Discover the product before styling it

Read the brief and existing app/code/screenshots if present. Identify:

1. **Core job:** what the user does most, in plain words. Name the hero flow.
2. **Personality:** 3 specific emotional adjectives, with one explicit anti-goal.
3. **Material:** 8–12 things *unique* to this app—its objects, rituals, outputs,
   data shapes, photography, physical affordances, constraints, vocabulary.
4. **Constraints:** iOS/Android, user age, language, accessibility, offline,
   device sizes, existing brand/assets, platform conventions and tech stack.
5. **Truth:** what content/assets/data actually exist; do not fake a product
   library, reviews or benchmark findings.

For substantial work, create `.taste-mobile/brief.md`. Use
`templates/brief.md` as a starting point; do not fill it with boilerplate.

### 2. Research with intent (Explore or major Refine)

Find **4–8 relevant mobile references** where access permits. Prefer actual
screens and behavior over promotional Dribbble shots; mix direct competitors,
exceptional products in adjacent categories, and at least one different
visual language. Record source URLs and dates where known. For each, note the
*design decision* that works, not "looks premium." Use the research procedure
in `references/discovery.md`.

If live browsing or images are unavailable, say what is inferred, work from
existing app evidence and documented principles, and **never fabricate**
references or claim you saw screens you did not see.

### 3. Deal three directions; do not merge them

Optional, dependency-free direction prompt generator:

```bash
node <skill-folder>/scripts/draw.mjs \
  --product "OLFUNA: personal perfume collection and continuous scanner" \
  --category collection --mood refined --options 3 \
  --out .taste-mobile/directions.md
```

`<skill-folder>` is the directory containing this SKILL.md. The script deals
from **12 newly authored mobile-first direction families**; its scores are
heuristic prompts, **not** claims of design excellence. If Node is unavailable,
choose three contrasting directions manually using `references/directions.md`.

For **each** direction produce:

- A **one-sentence concept** tied to this app's unique material, not a style name.
- Distinct layout/composition, image treatment, typography, color *roles*,
  shape/material language, density and motion behavior.
- A home/hero screen and the decisive step of the main flow, with real
  screen anatomy and real-or-clearly-marked-sample content.
- One signature moment that improves feedback, recognition or delight.
- One **risk** and one competitor-swap test (if you replace this app's name
  with a competitor's, does the concept still work unchanged?).

When agent image or native preview tools exist, **render the candidate screens**
and compare actual pictures. A text-only direction list is insufficient for a
serious visual-design exploration unless rendering tools are unavailable; in
that case explicitly say so. Do not use speculative screenshots as evidence
of a working native UI.

Offer a concise recommendation with reasons. If the user is choosing a style,
stop at the choice point. If the user explicitly requested an end-to-end build,
select the strongest direction and proceed; do not block work waiting for
approval. Record the decision and tradeoffs in `.taste-mobile/DESIGN.md`.

### 4. Lock design DNA before coding production UI

Complete a coherent, app-specific design contract:

- **Thesis:** "In this app, [unique material/behavior] becomes [specific visual
  or interaction device] so that [core job] feels [chosen emotion]."
- **Hierarchy:** first thing to see, primary action, information to defer.
- **Tokens:** typography roles + dynamic type behavior, semantic colors and
  contrast, spacing scale, radii, elevation/surfaces, icon and imagery grammar.
- **System:** navigation/headers, controls, list/collection layouts, selection,
  modal/sheet patterns, loading/empty/error/permission states.
- **Motion:** purpose, trigger, feedback, duration *guidance*, reduced-motion
  behavior; haptics only where meaningful and available.
- **Platforms:** which patterns stay consistent and what behaves natively
  differently on iOS and Android.
- **Signature moment:** a real interaction tied to user value, not a decorative
  animation on every element.

The design system must be concrete enough to build, not a collection of
adjectives. Use `templates/design-decision.md`. Avoid making everything fit
one preset family if content or platform needs differ.

### 5. Implement with the existing stack

For RN bare: use repository navigation, styling, animation and state libraries
unless a demonstrated need requires otherwise. Respect safe areas, system
status/navigation bars, Android back, permissions, keyboard avoidance,
scrolling, responsive heights, font scaling, accessibility and offline behavior.
Read `references/native-craft.md` and `references/motion.md`.

Do not replace normal product flows with concept art. Design screens for
**real data and real touch use**. Add at least one useful, distinctive quality
moment without sacrificing speed or clarity.

### 6. Run, inspect, critique, fix

**Never announce visual completion based only on source code.** Use the
coding agent's existing capability to launch the app on simulator/emulator or
connected device, navigate flows, capture screenshots and visually examine
those screenshots. No specific inspection service or framework is required.

At minimum inspect:

- The main entry screen and the primary job's key transition/end state.
- One constrained/small phone and one larger phone when available.
- Both iOS and Android when available; otherwise identify the unverified one.
- Content edge cases and relevant empty, loading, denied-permission and error
  states; dynamic type and reduced motion where practical.

Every review round: (1) view actual screen images, (2) identify the **three
highest-impact concrete defects** with screen/location, (3) fix them, (4)
re-open and compare. Do up to **three rounds** or stop earlier when the high
impact defects are resolved. Prioritize composition/identity and main-task UX
before tiny styling tweaks. Follow `references/visual-qa.md`.

If device inspection is impossible, do a best-effort code review and state
**"visual inspection not performed"**, with the exact blocker. Do not invent
screenshots, device tests or scores. Do not install Maestro just because this
skill asks for inspection.

### 7. Deliver with evidence

Report succinctly:

1. **Chosen design thesis** and why it belongs to this app.
2. **What changed** (screens/flows/components), with relevant file paths.
3. **Visual evidence**: screenshot paths and device/OS when actually captured.
4. **Critique & improvements**: top defects found and changes across rounds.
5. **Known gaps**: untested devices/states and any unresolved problems.

For substantial design work, save `.taste-mobile/DESIGN.md` and
`.taste-mobile/audit.md`. For existing apps, avoid overwriting user-owned
artifacts without checking. Use project conventions for temporary screenshots.

## Non-negotiable craft rules

- **No default AI template:** don't automatically choose pastel gradients,
  uniformly rounded cards, centered headings, glow, glass or decorative badges.
  These are permitted *when the product makes them appropriate*.
- **Content determines composition:** collections are not dashboards, creation
  tools are not brochures, children are not finance users.
- **Never sacrifice legibility for aesthetic style.** Support real copy,
  localization, text growth and VoiceOver/TalkBack semantics.
- **No identical UI for every product.** Consistent principles across a studio;
  distinctive design DNA for each app.
- **Do not over-animate.** Every motion needs a user-facing purpose and a
  reduced-motion fallback.
- **No fabricated evidence.** Concepts, mockups, screenshots, references,
  test results and user feedback must be labeled accurately.
- **Native respect:** no mobile website disguised as a native app; no gratuitous
  custom navigation that breaks familiar back/sheet/keyboard behavior.

## Example calls

- "Use taste-mobile to explore three truly different visual styles for OLFUNA.
  I want to compare rendered concept screens before choosing one."
- "Use taste-mobile to redesign Modern Toybox using React Native bare CLI,
  then inspect iOS and Android screenshots and refine the result."
- "Audit the collection and share flows with taste-mobile. Do not change code;
  give me a visual critique with evidence."

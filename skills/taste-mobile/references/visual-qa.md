# Native visual inspection and design critique

The agent does the inspection using tools it already has for simulator,
emulator, connected phone, browser-hosted simulator if genuinely native, or
other supported UI access. **This skill does not require Maestro or a new MCP.**

## Inspection protocol

1. Build and **launch** the actual app, not merely compile. Identify device,
   OS, screen resolution/scale and app build if available.
2. Open entry screen and carry out the hero task end-to-end. Capture screenshots
   for starting screen, decisive task step and final/empty/error state.
3. Inspect a **compact phone** and a **larger phone** where available. Repeat
   the primary flow on iOS and Android where available.
4. Use real or realistic sample content clearly identified as sample; include
   long names, large text, zero objects, dense lists, permission denied,
   keyboard open and common errors. Avoid truncation that hides useful data.
5. Look at screenshots with vision, not just a file existence assertion.
   Locate defects **visually**: screen, region, consequence, proposed fix.
6. Fix the three largest meaningful defects, relaunch, recapture and compare.
   Maximum three loops unless user asks for additional refinement.
7. Save paths to observed screenshots and a concise before/after change list.

When a requested platform is unavailable, state precisely which environment
was missing. **Never** claim native verification from static component code.

## Critique rubric (heuristic; not proof of award-winning quality)

| Dimension | Weight | Evidence |
|---|---:|---|
| Primary-task clarity | 25 | Can user find/do main job with minimal confusion? |
| Product identity and fit | 20 | Does UI express this app's real material, not template? |
| Type, hierarchy and composition | 15 | Legibility, alignment, scale, meaningful focal point |
| Native interaction quality | 15 | Touch reach, navigation, back, sheets, keyboard, flow |
| Accessibility and edge states | 15 | Text scaling, contrast, error/empty/permission, screen readers |
| Motion and final craft | 10 | Purposeful feedback, consistency, polish, reduced motion |

Evaluate each dimension with evidence and explicit defects. A number without
specific screen observations is not useful. Avoid self-congratulatory grading.
A nominal **85/100** is a project-specific aspiration, not a real external
benchmark or proof of "world class".

## Gate failures trump total score

- Main job blocked or unclear.
- Important content clipped on common screen/font sizes.
- Broken native back, modal dismissal or keyboard handling.
- Unusable touch targets for main actions.
- Inaccessible key action or critical status.
- Design depends on missing/illegally reused imagery or fake records.
- No inspected actual output despite tools being available.

Do not describe work as visually complete while a gate failure remains.

## Audit entry format

Use `templates/audit.md`:
- Device / OS / app build / tool used / screenshot path.
- Main flow attempted and result.
- Observation: "On [screen], [element] [problem] causing [impact]".
- Fix with changed file references.
- Re-inspection status: verified / not verified / blocked.
- Outstanding concerns; no invented tests.

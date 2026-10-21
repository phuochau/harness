# Native visual directions

The 12 families in `scripts/direction-library.json` are **exploration
provocations**, not canned themes or proven benchmarks. The local generator
`node scripts/draw.mjs --help` proposes three contrasting families using a
transparent, lightweight affinity heuristic. Score != quality. An agent may
reject a suggestion with a documented product/brand reason.

## Diversity test (critical)

Three options **must** differ in underlying composition and experience, not
just color:

1. One should treat the **content/objects** as the visual hero.
2. One should emphasize an alternate **interaction or narrative metaphor**.
3. One should express a different **type/material/structural personality**.

Two alternatives fail diversity if they share the same page anatomy,
card-grid strategy, type hierarchy, hero action or signature motion. Pick new
families rather than recoloring.

## Slider guidance

Use these sliders *as parameters, not scores*; defaults are contextual:

- **DESIGN_VARIANCE 1–5:** from native familiar (1) to expressive/custom (5).
  Keep navigation and core accessibility conventional even at 5.
- **MOTION_INTENSITY 1–5:** from subtle feedback (1) to dynamic choreography
  (5). Reduced-motion fallback always required.
- **VISUAL_DENSITY 1–5:** spacious/selective (1) to compact/data-rich (5).
  Not a license to shrink text or tap targets.

For each direction, propose meaningful values and state *why*. E.g. a fast
utility usually needs density 3–4 and motion 1–2, while a children's creative
tool might warrant variance 5, motion 3 and density 2; the exact numbers must
come from real user tasks.

## Required concept anatomy

A. **Name + thesis:** product-specific, one sentence.
B. **Main flow:** screen 1, decisive action, success/result.
C. **Layout grammar:** dominant visual, primary action placement, hierarchy,
   list/grid treatment, navigation choice.
D. **Type:** families or categories, hierarchy and text-scaling behavior.
E. **Color roles:** surface, content, action, semantic/feedback; no arbitrary
   rainbow palette. Provide actual candidate hex values only after choosing.
F. **Material/imagery:** what *real* image/data objects carry personality.
G. **Motion:** a reasoned signature transition and reduced-motion alternative.
H. **Tradeoff:** what can go wrong and how to control it.
I. **Evidence:** reference URLs, observed vs hypothetical.

## Show, don't merely label

For serious exploration, render at least two **connected** screen concepts per
option, ideally in a shared device canvas for side-by-side comparison. Work
from the same content/user scenario across all three options so the differences
are attributable to design. Mark concepts as concepts.

Acceptable rendering methods depend on available tools: native preview builds,
image generation, graphic design tools, or lightweight design prototypes.
Never equate a generated concept with tested native implementation. If the
agent can run RN, the final chosen direction must be implemented in native
screens and inspected in the actual runtime.

## Decision memo

Compare alternatives against product-fit, originality, hierarchy, one-handed
operation, accessibility, feasibility with available assets, and signature
interaction usefulness. Recommend one, explicitly naming at least one thing
lost by not choosing each alternative.

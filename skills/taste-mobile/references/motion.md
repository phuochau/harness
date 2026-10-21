# Interaction, motion, haptics and sound

One memorable interaction is worth ten unrelated micro-animations.

## Signature moment design

Tie it to the user's main job: recognition succeeds, an item is added, layers
snap together, a comparison resolves, a scan becomes a collection object.
It must answer: **what happened, where did it go, and what can I do next?**

Specify: trigger → state change → spatial metaphor → feedback → recovery.
Never rely on an animation alone to communicate success or failure.

## Mobile motion budget

- Keep simple presses and toggles responsive; avoid delays that block touch.
- Animate continuity for meaningful object movement and screen transition;
  preserve the user's spatial mental model.
- Use spring-like motion where it clarifies direct manipulation, not as a
  universal flourish. Avoid bouncy finance/critical-action confirmation.
- Large layered animations must consider battery, older devices, frame drops,
  reduced-motion setting and rapid repeated actions.
- Avoid jumping content positions on async updates.
- Haptics are optional and used for a deliberate state boundary (successful
  acquisition, selection threshold, completed drag) rather than on every tap.
- Sounds should be optional and appropriate to context, with silent-mode and
  accessibility behavior considered.
- On reduced motion, retain instant/low-motion changes that communicate state.

## Prototype the decisive transition

Show at least: initial state, in-progress state, completion/error state.
For example, for continuous scanning: camera view with a clear target and
permission fallback; recognition confirmation without interrupting scanning;
visible addition to collection and a straightforward undo/review path.

Avoid implementing hypothetical backend or ML features just because a concept
animation suggests them. Motion must respect available functionality.

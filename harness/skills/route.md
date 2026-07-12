# Skill: Route

Use when an agent or human does not know what should happen next.

## Steps

1. Read the current artifact.
2. Identify current status: proposed, ready, in_progress, blocked, review,
   verify, done, rejected, accepted, or superseded.
3. Identify the current lane.
4. Identify the missing decision:
   - unclear outcome
   - unclear scope
   - unclear risk
   - unclear owner
   - unclear proof
   - blocked dependency
   - review finding
   - failed verification
   - workflow uncertainty
5. Choose the next role:
   - Scope Agent
   - Planner Agent
   - Builder Agent
   - Reviewer Agent
   - Verifier Agent
   - Security Agent
   - QA Agent
   - Recorder Agent
   - Orchestrator Agent
6. Choose the next skill.
7. Choose the rule files the next role must apply, using the role/skill/rule
   map in `harness/HOW_TO_USE.md`.
8. If a human decision is needed, ask one concrete question.
9. Record the routing note.

## Output

- Next role.
- Next skill.
- Rule files to apply.
- Next artifact.
- Continue, pause, escalate, or ask-human decision.

# Freelance Marketplace — Project Guide

## Project

A freelance marketplace platform with two sides (Client + Provider). Specifications live in [`/spec/`](./spec/) and follow the template in [`.claude/skills/create-specification/`](./.claude/skills/create-specification/).

Established decisions (do not re-litigate without cause):

- **Categories** — 3-level hierarchical tree; user-submitted categories require admin approval.
- **Deal state machine** — `pending → active → in_review → completed | disputed | cancelled`. Client initiates, Provider confirms.
- **KYC** — required before Provider **payout**, not before Deal creation.
- **Auth** — REST/JSON, access JWT (15 min, RS256) + rotating opaque refresh token (30 days). See [`spec/spec-architecture-users-authentication.md`](./spec/spec-architecture-users-authentication.md).

## Subagents

Two project-scoped subagents live in [`.claude/agents/`](./.claude/agents/):

- **`architect`** — proposes design decisions (schemas, APIs, state machines). Output is `[DECISION]` blocks.
- **`critic`** — adversarial review of ARCHITECT proposals. Output is `[RISK]` blocks + a verdict (`ACCEPT` / `ACCEPT WITH REFINEMENTS` / `REJECT`). Read-only tools by design.

### Orchestration protocol

Subagents do not talk to each other — each invocation is isolated and returns one message to the coordinator (the main session). The coordinator relays context between them.

For every new spec module, run this loop:

1. **Propose** — call `architect` with the module scope and project context. Capture its `[DECISION]` blocks verbatim.
2. **Critique** — call `critic` with the **full ARCHITECT output pasted verbatim** into the prompt (subagents start cold, no shared history). Capture `[RISK]` blocks and the verdict.
3. **Refine** — only if verdict is `REJECT` or `ACCEPT WITH REFINEMENTS`. Call `architect` again with both the original proposal and the critique, asking it to refine *only the flagged decisions*.
4. **Finalize** — the coordinator synthesizes the final `[DECISION]` + `[RISK]` set and calls `/create-specification`.

**Stopping rule:** stop at `ACCEPT`, or at `ACCEPT WITH REFINEMENTS` once every flagged risk has a matching refinement. Hard cap: two refinement rounds — if it still hasn't converged, escalate to the user rather than looping further.

**Tradeoff acknowledged:** passing ARCHITECT's full output into CRITIC's prompt costs tokens but preserves independent judgment. The coordinator must NOT summarize or pre-filter the proposal before handing it to CRITIC.

## Spec workflow

- One module per spec file in `/spec/`, named `spec-[category]-[topic].md` where category ∈ {architecture, data, process, schema, tool, infrastructure, design}.
- Use the `create-specification` skill to write/update spec files — do not hand-author the template structure.
- Cross-reference related modules in §11 of each spec.

## Conventions

- SQL examples default to PostgreSQL 15+ dialect.
- API examples default to REST/JSON over HTTPS.
- IDs are UUIDs unless there's a specific reason otherwise.
- Money is stored as integer minor units (cents), never floats.
- All timestamps are `TIMESTAMPTZ` in UTC.

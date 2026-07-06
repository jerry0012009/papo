# Papo Development Document

This document is maintained alongside the Goal spec. When product or architecture choices change, update this file before or during implementation.

## North Star

Papo Demo 1.0 is a mobile-first "minimum viable lifeform":

- It notices.
- It has drives and visible internal state.
- It forms episode memories from shared moments.
- It extracts long-term memory.
- It changes after feedback.
- It can later surface a memory from its own state and history.
- It supports multiple users with isolated creatures.

The product should feel like a weak but real companion growing a first small brain, not a chatbot UI, database UI, or productivity dashboard.

## Current Delivery Scope

Stage 1 must deliver:

- Multi-user creature profiles.
- Creature state: curiosity, attachment, energy, arousal, safety, confidence, mood.
- Button Capture for single text input.
- Curious Mode for multiple stream segments.
- Attention Events with source, trigger, reason, related memories, state snapshot, strength, privacy risk, suggested action.
- Episode memory cards.
- Long-term memories, including `creature_self_memory`.
- Feedback: understood, continue, not_now, remember, forget.
- Active emergence: "what is it thinking now?"
- Provider layer: Mimo, OpenRouter, generic OpenAI-compatible API, fallback.
- Provider config from environment or local config file.
- Fallback mode that can demonstrate the full loop without API keys.
- Mobile-first UI.
- Basic tests for the life loop.

Deferred:

- Real image understanding.
- Real audio transcription.
- Vector database / Mem0 integration.
- PWA and native Android.
- Background sensing and notifications.
- Full skill/action system.

## Taste And Architecture Decisions

### Mixed Lifeform Harness

Use a mixed harness rather than pure rules or pure LLM.

Rules own:

- State initialization and clamping.
- Multi-user isolation.
- Baseline attention scoring.
- Privacy and action guardrails.
- Memory write/promotion/deletion.
- Feedback reinforcement.
- Testable invariants.

LLM owns:

- Rich semantic interpretation.
- Better explanation of why something drew attention.
- Possible user intent.
- More natural creature response.
- Candidate action suggestions.
- More natural narration for feedback learning and active emergence.

Guardrails always run after LLM suggestions. LLM output cannot directly mutate state values, delete memory, bypass privacy, or write cross-user data.
LLM narration cannot change state, policy, action, memory ids, or persistence. Emergence narration is accepted only when it stays anchored to a real memory already selected by rules.

Harness stages:

1. `sense`: receive button or stream input.
2. `attend`: create rule-based candidate attention events.
3. `interpret`: LLM enriches semantics when available.
4. `guardrail`: validate action, privacy, and state boundaries.
5. `remember`: append episode memory.
6. `learn`: feedback updates state and memory weight.
7. `emerge`: state and memory trigger active resurfacing.
8. `wake`: app open/reopen applies deterministic time rhythm and shows a small presence note.
9. `narrate`: LLM may rewrite user-facing feedback/emergence text after rules have already decided the facts.

Wake rhythm split:

- Rules compute elapsed time, state deltas, history caps, and persistence.
- LLM may later rewrite the presence sentence, but cannot choose elapsed time or mutate state.
- Wake text should describe living presence, not use development notes as interaction material.

### Borrowed Lessons

LangGraph:

- Durable state and traceable transitions matter more than a heavy framework for 1.0.

Mem0:

- Episode memory should be append-first.
- Long-term memory can be extracted later.
- Agent-generated self-memory is first-class.

Swarm / Agents:

- Keep the execution loop lightweight and explicit.
- Make handoff/tool decisions inspectable.

ClawRouter:

- Keep provider selection separate from product logic.
- Prefer OpenAI-compatible boundaries for easy routing.

## Code Map

- `src/core/types.ts`: domain types.
- `src/core/state.ts`: creature drives and state updates.
- `src/core/attention.ts`: rule-based attention candidates.
- `src/core/harness.ts`: mixed rule + LLM semantic harness.
- `src/core/narration.ts`: guarded LLM narration for learning notes and emergence messages.
- `src/core/memory.ts`: episode and long-term memory.
- `src/core/feedback.ts`: reinforcement rules.
- `src/core/emergence.ts`: active resurfacing.
- `src/core/rhythm.ts`: app-open wake rhythm and time-based state recovery.
- `src/core/provider.ts`: Mimo/OpenRouter/generic/fallback provider layer.
- `src/server/app.ts`: API orchestration.
- `src/server/index.ts`: API listener, defaults to `127.0.0.1` for nginx proxying.
- `src/server/store.ts`: local profile persistence.
- `src/web/App.tsx`: mobile-first workbench UI.
- `tests/`: core, API, and UI protection tests.

## Current Implementation Status

Done:

- Project scaffold.
- Core domain types.
- Local JSON and memory stores.
- Fallback provider.
- OpenAI-compatible provider shell.
- Local provider config file support.
- Button Capture rule path.
- Curious Mode rule path.
- Harness enrichment path with LLM JSON and guardrails.
- Mobile-first workbench UI.
- Frontend can be built under `/papo/` with API under `/papo-api`.
- Initial tests.
- Runtime check: API remains usable when configured Mimo fails; harness records model failure and falls back to rule output.
- Creature Brain v0.2:
  - Curious Session audit with selected and ignored segments.
  - Segment score contributions: novelty, memory resonance, emotion, future value, identity, privacy, state bias, redundancy, fatigue.
  - Independent action selector with confidence, blocked actions, safety notes, and LLM-suggested action guardrails.
  - Feedback policy profile: depth, proactivity, privacy sensitivity, save threshold, ask threshold, recall tendency, quiet tendency.
  - Episode-level memory candidates with write policy before long-term promotion.
  - Drive-based, rhythm, and memory-resonance emergence records.
  - Brain page shows policy, recent decision, recent emergence, and memory candidates.
- Goal 3 experience layer:
  - Main UI uses creature experience language for attention and episodes.
  - Feedback immediately surfaces a user-facing "I learned" note.
  - Real-model providers can now rewrite feedback learning notes and active emergence messages while rules keep ownership of state, policy, actions, and memory ids.
  - App open/reopen creates a wake event: Papo reacts to time passing, recovers energy by rule, and shows a small "醒来时" presence note on Home.
  - Demo Mode uses life-context examples rather than Papo development text as interaction material.
  - Demo Mode includes Curious stream loading, A/B feedback conditioning, and active emergence.
  - Experimental voice companionship in Curious Mode: browser speech recognition can listen up to 3 minutes and split transcripts every 30 seconds into `audio_transcript` segments.

Verified:

- `npm test`: 27 tests passing across core, v0.2 brain behavior, Goal 3 experience, API, and UI.
- `npm run build`: TypeScript and production build passing.
- Dev API health returns 200.
- Dev web entry returns 200.
- Button Capture creates attention event, episode memory, state change, and harness trace.
- Curious Mode selected salient stream segments and ignored a low-salience ordinary segment.
- Feedback `remember` promoted an episode to long-term memory and changed state.
- Active emergence referenced an existing long-term memory.
- Curious Mode selects 1-3 salient segments from an 8-part stream and audits ignored segments.
- Feedback changes later policy and action style, so different users diverge.
- LLM invalid JSON falls back without breaking the life loop.
- LLM action suggestions go through rule guardrails.
- LLM feedback narration cannot mutate rule-owned state.
- LLM emergence narration must stay anchored to an existing long-term memory or it is rejected.
- Curious Mode creature report uses user-life material and explains selected/ignored segments.
- Feedback returns a visible learning note.
- Active emergence reads as inner resurfacing rather than a template reminder.
- Wake rhythm records an app-open presence event and applies rule-owned time-based state recovery.
- Public demo store was reset to a life-context profile so old development/investor smoke text is not used as creature interaction material.
- Public nginx deployment:
  - Web: `https://eu.jerrypsy.top/papo/`
  - API: `https://eu.jerrypsy.top/papo-api/health`
  - systemd service: `papo-api`
  - static root: `/var/www/papo`

Next:

1. Improve real Mimo/OpenRouter connectivity diagnostics and surface model errors in Brain page.
2. Replace browser-only speech recognition with a robust transcription backend for audio chunks where needed.
3. Add real image upload with model-created image summaries.
4. Add stronger browser visual QA with mobile screenshots.
5. Add a guided 4-minute investor demo seed/reset flow.

Demo material rule:

- Default inputs and Demo Mode scenarios should use ordinary user-life material.
- Do not use our development notes, product planning text, or investor-pitch wording as the creature's interaction material.

## Verification Checklist

- State initializes correctly and stays 0-100.
- Different users do not share state or memory.
- Button Capture creates attention event and episode.
- Curious Mode selects 1-3 salient segments.
- Attention event includes required fields.
- Feedback changes state and memory weights.
- Remember promotes to long-term memory.
- Forget deletes or downranks memory.
- Active emergence references existing memory.
- Fallback mode runs without API keys.
- Provider selection is isolated from product logic.
- API endpoints return expected payloads.
- UI renders core workbench pages.
- Demo can run in 3 minutes.

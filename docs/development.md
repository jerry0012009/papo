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
- Conversation timeline that includes both multimodal inputs and Papo utterances.
- Episode memory cards.
- Long-term memories, including `creature_self_memory`.
- Feedback: understood, continue, not_now, remember, forget.
- Active emergence: "what is it thinking now?"
- Provider layer: Mimo, OpenRouter, generic OpenAI-compatible API, fallback.
- Provider config from environment or local config file.
- Separate provider config for text, vision, and audio model ids.
- Fallback mode that can demonstrate the full loop without API keys.
- Mobile-first UI.
- Basic tests for the life loop.

Deferred:

- Vector database / Mem0 integration.
- PWA and native Android.
- Background sensing and native notifications.
- Full skill/action system.

## Taste And Architecture Decisions

### Mixed Lifeform Harness

Use a mixed harness rather than pure rules or pure LLM.

Rules own:

- State initialization and clamping.
- The final action enum and guardrails, including whether a proposed `respond` action is allowed.
- Multi-user isolation.
- Baseline attention scoring.
- Privacy and action guardrails.
- Memory write/promotion/deletion.
- Feedback reinforcement.
- Testable invariants.
- Minimal fallback repair only when the semantic model is unavailable or fails; keyword heuristics must not be treated as the primary understanding path.

LLM owns:

- Rich semantic interpretation.
- Structured interaction understanding: user intent, emotional tone, whether Papo should reply now, candidate reply text, and a memory candidate for the shared moment.
- Visual/audio sensing adapters that compress raw screenshots or recordings into editable life-context segments.
- Better explanation of why something drew attention.
- Creature-facing Curious Mode narration for why existing rule-selected segments were noticed or let go.
- Possible user intent.
- More natural creature response.
- Candidate action suggestions.
- More natural narration for feedback learning and active emergence.

Guardrails always run after LLM suggestions. LLM output cannot directly mutate state values, delete memory, bypass privacy, or write cross-user data. LLM can propose actions such as `respond`, `ask`, `recall`, save, review, or reminders, but rules re-run action guardrails before persistence.
In the normal production path, LLM structured interaction understanding decides which business flow should be proposed. Rule keywords are allowed only as fallback repair after model unavailability/failure, and that fallback status must be visible in diagnostics.
LLM narration cannot change state, policy, action, memory ids, or persistence. Emergence narration is accepted only when it stays anchored to a real memory already selected by rules.
Visual and audio models are treated as `sense` adapters only: they may create `image_summary` and `audio_transcript` text, but they do not choose memories, actions, or state changes. Those generated segments remain user-editable before entering Curious Mode.
Attention is a conversation phase, not a separate product mode: user/world multimodal inputs enter the conversation timeline first, then the harness decides what Papo attends to, remembers, says, or ignores.
Button Capture remains a harness primitive, but it is no longer a standalone user-facing mode. Direct text input should appear in the dialogue composer and then flow through the same attention/memory/action loop.
The user-facing conversation unit should often be a short shared moment, not a single database row: text, photo summaries, and audio transcripts with the same 30-second `batchId` are presented together before Papo's attention response.
Episode memories keep provenance back to their source segment/batch/time/location when available, so a memory card can show the shared moment that gave birth to it.
Feedback is also conversation input: button taps, typed feedback, and audio-transcribed feedback are recorded in the same timeline before Papo's learning response, then rule-owned state/policy/memory changes apply.
Feedback responses have a rule-owned `responseAction`: Papo may simply acknowledge, ask one light follow-up, quiet itself, or attach the feedback content to memory. LLM narration may rewrite the learning/follow-up text, but not the action, deltas, or memory writes.
Forget is two-stage for memories: first feedback lowers the target weight to zero and teaches caution; a later forget on the zero-weight target purges it.
Active emergence treats zero-weight memories as unavailable: a memory that has been forgotten but not yet purged cannot be resurfaced as Papo's inner thought.
Unread dialogue state is a perception layer for new Papo utterances, not an action planner: rules decide persisted `papo` messages, while the UI only shows a small unread dot on the dialogue entry. Wake notes are presence state and do not create unread notifications.
Internal channel names, memory kinds, batch ids, and numeric weights are developer facts. User-facing dialogue and memory pages should default to natural creature language; raw `channel`, `kind`, `batchId`, and `weight` belong in details or Brain views.

Harness stages:

1. `sense`: receive button or 30-second multimodal stream input and record it as conversation context.
2. `attend`: create rule-based candidate attention events.
3. `interpret`: LLM creates structured interaction understanding when available, including whether the natural action is to answer the user.
4. `guardrail`: validate action, privacy, and state boundaries.
5. `remember`: append episode memory.
6. `learn`: feedback updates state and memory weight.
7. `emerge`: state and memory trigger active resurfacing.
8. `wake`: app open/reopen applies deterministic time rhythm and shows a small presence note.
9. `narrate`: LLM may rewrite user-facing feedback/emergence text after rules have already decided the facts.

Wake rhythm split:

- Rules compute elapsed time, state deltas, history caps, and persistence.
- Rules choose any wake-time memory resurfacing from existing non-self long-term memories.
- LLM may later rewrite the presence or resurfacing sentence, but cannot choose elapsed time, memory ids, or mutate state.
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

OpenRouter multimodal routing:

- Keep text, vision, and audio model ids separately configurable.
- OpenRouter is the preferred production semantic provider when an `OPENROUTER_API_KEY` is present; Mimo and generic OpenAI-compatible providers are fallback provider families.
- Default text model is `openai/gpt-5.5` for the semantic brain. Cheaper models may be set explicitly per deployment, but the demo should not silently present fallback output as evidence of lifeform quality.
- Default vision/audio model ids prefer a Flash-class multimodal model for cost-effective sensing; deployments can override them per account capability.
- Model call timeouts are configurable with `PAPO_MODEL_TIMEOUT_MS`, `PAPO_VISION_TIMEOUT_MS`, and `PAPO_AUDIO_TIMEOUT_MS`; default semantic/vision/audio limits are 45 seconds so real Curious Mode prompts do not silently degrade to fallback after a short wait.
- Provider failures return editable fallback segments so the life loop stays demonstrable without raw model success.
Fallback provider is a degradation path only. It must be visible in health/provider diagnostics and should never be treated as proof that Papo truly understood the user.

## Code Map

- `src/core/types.ts`: domain types.
- `src/core/state.ts`: creature drives and state updates.
- `src/core/attention.ts`: rule-based attention candidates.
- `src/core/harness.ts`: mixed rule + LLM semantic harness.
- `src/core/narration.ts`: guarded LLM narration for learning notes and emergence messages.
- `src/core/conversation.ts`: persistent Papo utterance timeline.
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
  - Brain page shows semantic brain diagnostics, policy, recent decision, recent emergence, and memory candidates.
- Goal 3 experience layer:
  - Main UI uses creature experience language for attention and episodes.
  - Feedback immediately surfaces a user-facing "I learned" note.
  - Real-model providers can now rewrite feedback learning notes and active emergence messages while rules keep ownership of state, policy, actions, and memory ids.
  - Semantic brain runs are persisted as diagnostics: fallback/skipped, applied, empty, invalid JSON, and failed model calls are visible in Brain page.
  - App open/reopen creates a wake event: Papo reacts to time passing, recovers energy by rule, and shows a small presence note on Home.
  - After a long enough absence, wake can create a rhythm emergence from a real non-self long-term memory, so opening the app can feel like it quietly remembered something.
  - Demo Mode uses life-context examples rather than Papo development text as interaction material.
  - Demo Mode includes Curious stream loading, A/B feedback conditioning, and active emergence.
  - Demo Mode now has a guided 4-minute run that creates a fresh main creature, runs the 8-part Curious script, applies remember/continue feedback, creates A/B conditioned creatures, and surfaces a real emergence summary without exposing a public reset endpoint.
  - Demo Mode A/B contrast now shows policy differences and inner-choice wording for the two conditioned creatures, not just action names.
  - Experimental voice companionship in Curious Mode: browser speech recognition can listen up to 3 minutes and split transcripts every 30 seconds into `audio_transcript` segments.
  - OpenRouter/OpenAI-compatible visual sensing endpoint: uploaded screenshots are summarized into editable `image_summary` segments.
  - OpenRouter/OpenAI-compatible audio sensing endpoint: uploaded recordings are transcribed into editable `audio_transcript` segments.
  - Papo conversation timeline: multimodal inputs plus wake notes, attention responses, feedback learning, and active emergence are persisted into `conversation`, with a dedicated dialogue history page.
  - Curious Mode continuous recording: MediaRecorder records up to 3 minutes, requests audio chunks every 30 seconds, sends chunks to `/api/audio-transcript`, and keeps browser speech recognition only as a local fallback transcript source.
  - Multimodal 30-second batches: text, photo summaries, and audio transcripts carry `batchId` and `observedAt`; photo uploads also carry available browser geolocation so later memories can include time/place.
  - Papo is now rendered as a stateful cartoon Shiba Inu SVG: triangular ears, curled tail, urajiro face/chest, breathing, blinking, tired/alert/attached/careful motion states are bound to `CreatureState`.
  - Conversation and attention are unified in the UI: the dialogue page shows user/world inputs as attention material and Papo utterances as outputs in one timeline.
  - Dialogue inputs with the same 30-second batch are grouped as one shared moment, so multimodal fragments feel like one thing Papo experienced with the user.
  - Episode memories preserve source segment/batch/time/location metadata and memory cards can show the exact shared moment that created them.
  - Feedback is integrated into the conversation timeline: buttons, typed notes, and audio-transcribed notes become user feedback inputs before Papo replies with a learning note.
  - Feedback can now advance the interaction instead of only issuing a receipt: rules choose acknowledge/follow-up/quiet/memory-note behavior, and substantive feedback can attach a new memory candidate or strengthen a promoted memory.
  - Feedback records expose rule-owned state and policy deltas so users can see how they are raising Papo.
  - Forget feedback is staged: it first downranks memory weight to zero, then a repeated forget purges the zero-weight target.
  - New non-wake Papo utterances show a small unread dot on the dialogue tab; entering the dialogue clears it. Wake notes stay in the wake surface and conversation history only.
  - Conversation bubbles no longer show system-channel labels such as "认真注意后"; Papo replies are shown as Papo speaking, with light context only for user/world inputs.
  - Memory page no longer defaults to database labels such as `future_review`, batch ids, or numeric weights. It shows "Papo remembers..." language, keeps time/location as part of the shared moment, and puts raw details behind expandable diagnostics.
  - Active emergence on Home now shows Papo's resurfaced thought plus why it surfaced and which drive brought it back, while technical trace remains in Brain.
  - Direct text input now lives in the dialogue page composer, then routes through the Button Capture harness and returns to the same conversation timeline; the old standalone Button Capture page was removed from the user-facing navigation.
  - Direct calls such as asking Papo to speak now map to a first-class `respond` action, so the harness can choose to answer before it asks, saves, recalls, or stays quiet.
  - Semantic brain output now includes structured interaction understanding and can update the episode response plus memory candidate text before rule-owned persistence completes.
  - Semantic brain can rewrite Curious Mode selected/ignored reasons and the session creature report, while rules still own the selected set, ignored set, scores, attention budget, and guardrails.
  - Direct-call keyword handling was moved out of the primary action selector and into fallback repair only; successful LLM runs own the proposed interaction/action path.
  - Provider defaults now prefer OpenRouter `openai/gpt-5.5` when configured, with `.env` support for local/production deployment and visible fallback diagnostics.
  - Initial creature state has small deterministic per-user variation, and Home state copy is driven by recent wake/conversation/feedback state changes instead of only a static mood label.

Verified:

- `npm test`: 32 tests passing across core, v0.2 brain behavior, Goal 3 experience, API, and UI.
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
- LLM invalid JSON is recorded in `semanticBrainHistory` and surfaced in Brain page diagnostics.
- LLM action suggestions go through rule guardrails.
- LLM feedback narration cannot mutate rule-owned state.
- LLM emergence narration must stay anchored to an existing long-term memory or it is rejected.
- Curious Mode creature report uses user-life material and explains selected/ignored segments.
- Feedback returns a visible learning note.
- Active emergence reads as inner resurfacing rather than a template reminder.
- Wake rhythm records an app-open presence event, applies rule-owned time-based state recovery, and can resurface a real user memory after absence.
- Papo utterances are visible in persisted dialogue history, and new non-wake replies mark the dialogue tab unread.
- Active emergence ignores zero-weight forgotten memories; it may use a derived safety rule, but it will not resurface the forgotten target itself.
- Curious Mode can create `audio_transcript` segments from real 30-second audio chunks without storing raw audio.
- Curious Mode can preserve photo upload time/place and batch text/photo/audio as one stream before attention selection.
- Home renders Papo as an animated Shiba Inu SVG whose visible posture changes with mood, energy, curiosity, attachment, and safety.
- The Home "Papo new said" surface only selects `role=papo` messages even when newer user/world inputs exist.
- The dialogue page presents one attention/conversation timeline with counts for attention material and Papo responses.
- The dialogue page groups same-batch multimodal inputs into a "30-second shared moment" before Papo's response.
- Episode cards can trace a memory back to the source shared moment, including batch, observed time, location, and matching conversation input when present.
- Feedback text and audio transcript content are persisted as conversation input, and Papo's learning response follows it in the same timeline.
- Feedback with substantive text can produce a rule-owned follow-up or memory note, and the persisted Papo reply includes that continuation.
- Feedback responses include visible state/policy deltas, and forget feedback requires a second click to purge a zero-weight memory.
- The Home "single input" path opens the dialogue composer, and a submitted text message appears in the same attention/conversation timeline as Papo's response.
- A direct "say something to me" input selects `respond`, produces a Papo reply, and creates a memory candidate for that small shared moment.
- Real online model smoke passed through the OpenAI-compatible generic provider with `gpt-5.5`: semantic brain status `applied`, action `respond`, LLM-written reply, and LLM-written memory candidate.
- Real online Curious smoke passed through the OpenAI-compatible generic provider with `gpt-5.5`: semantic brain status `applied`, source `llm`, rule-owned event count stayed fixed, and LLM rewrote selected/ignored reasons into creature-facing narration.
- Real online feedback narration smoke passed through the OpenAI-compatible generic provider with `gpt-5.5`: LLM rewrote learning/follow-up text while rule-owned `responseAction`, state, and memory candidate ids stayed fixed.
- Guided Demo Mode can run the Goal 3 acceptance flow through real API calls using ordinary life-context material.
- Guided Demo Mode's A/B section displays how feedback changed the two creatures' depth/recall/quiet/proactivity tendencies and how their inner choices differ on the same input.
- Public demo store was reset to a life-context profile so old development/investor smoke text is not used as creature interaction material.
- Public nginx deployment:
  - Web: `https://eu.jerrypsy.top/papo/`
  - API: `https://eu.jerrypsy.top/papo-api/health`
  - systemd service: `papo-api`
  - static root: `/var/www/papo`

Next:

1. Add stronger browser visual QA with mobile screenshots for the Shiba Inu avatar, conversation timeline, source-linked episode cards, unread dialogue dot, feedback input, and Curious recording flow.
2. Tune OpenRouter audio model defaults after testing real account model availability.
3. Consider a small generated Shiba sprite sheet later if SVG statefulness becomes limiting.

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
- Papo messages are persisted and visible in conversation history.
- Curious Mode can segment live recording into audio transcripts.
- Curious Mode records multimodal input metadata: 30-second batch id, observed time, and photo location when permitted.
- Papo's visible Shiba Inu SVG avatar reflects state and remains readable on mobile.
- Conversation timeline treats attention as part of dialogue, and only non-wake Papo utterances create an unread dialogue indicator.
- Same-batch multimodal inputs are visible as one shared moment in the conversation timeline.
- Episode memory provenance links back to the source shared moment where available.
- Feedback itself is dialogue input, including text and audio transcript feedback, and visible raising deltas are shown after feedback.
- Forget downranks to zero before purge.

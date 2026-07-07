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
When feedback targets a long-term memory, both the user's teaching message and Papo's learning response should keep `relatedMemoryIds` pointing to that memory, so dialogue history, memory, and later emergence remain one connected experience.
Feedback impact shown to users should describe future behavior changes, not raw state or policy deltas. Numeric deltas remain Brain diagnostics.
Feedback should also shape Papo's self-memory: repeated or meaningful teaching creates/upserts `creature_self_memory` about how Papo has learned to approach the user. Quiet/caution self-memories influence restraint but should not act as ordinary recall triggers.
Forget is two-stage for memories: first feedback lowers the target weight to zero and teaches caution; a later forget on the zero-weight target purges it.
Active emergence treats zero-weight memories as unavailable: a memory that has been forgotten but not yet purged cannot be resurfaced as Papo's inner thought.
Active emergence must not treat seed self-memory as a shared old experience. A memory produced from a real episode may support emergence even if its kind is `creature_self_memory`; if no positive-weight shared memory exists, Papo may express readiness or inner state, but it must not pretend to remember an old moment.
Feedback-shaped `creature_self_memory` is allowed to support active emergence as "how you have raised me". Rule narration and LLM narration must describe it as a learned habit, listening style, or boundary sense, not as a normal old event.
Unread dialogue state is a perception layer for new Papo utterances, not an action planner: rules decide persisted `papo` messages, while the UI only shows a small unread dot on the dialogue entry. Wake notes are presence state and do not create unread notifications.
Internal channel names, memory kinds, batch ids, and numeric weights are developer facts. User-facing dialogue and memory pages should default to natural creature language; raw `channel`, `kind`, `batchId`, and `weight` belong in details or Brain views.
The memory page is Papo's subjective remembering surface. It should use first-person creature language for what Papo is holding, how familiar the memory feels, why it kept the moment, and how the user can help it remember accurately or let go. Hiding technical fields is necessary but not sufficient UX.
Memory-page feedback is still interaction, not administration: when the user teaches Papo how to keep, soften, continue, or forget a memory, optional text/audio feedback should enter the same `learn` loop as episode feedback.
Correcting a long-term memory is also a teaching moment: the memory text is rule-updated, and the user correction plus Papo's confirmation should be written into the conversation timeline with `relatedMemoryIds`.
Harness traces and implementation backlog belong to Brain/development docs, not the Home or Demo experience. The user-facing path should show what Papo noticed, remembered, learned, or wondered, not pipeline step names such as `sense` or `semantic`.
User-facing pages should not label the companionship flow as `Curious Mode` or expose `image_summary` / `audio_transcript`; use "陪我看一小段世界", "照片", "录音转写", "小片段", and "这一小段" language instead. Keep the raw type names in code, API contracts, tests, and Brain diagnostics only.
Demo entry copy should guide a person through Papo's life loop rather than sound like a script runner. Prefer "带 Papo 走一圈", "先递 8 段生活", and "问问 Papo 想到什么" over "一键", "场景 1/2/3", or setup-task language on user-facing surfaces.
Multi-creature contrast should feel like two Papos being raised differently, not two labeled configurations. Avoid user-facing names such as "深想型/安静型" or "演示主线"; use small creature names and explain the difference as feedback-shaped behavior.
User-facing empty, error, and status copy is part of the creature experience too. Avoid "材料", "模拟信息流", and "录音分段" on user surfaces; say Papo is receiving, hearing, or holding "这一小段" instead.
Feedback controls on user-facing memory and episode surfaces should sound like the user is raising Papo, not pressing admin actions. Prefer "再想一会儿", "先安静点", "帮我记住", and first-person learning echoes such as "我会..." while keeping raw feedback kinds in code/API/Brain diagnostics.
Home should surface stable raising shape in creature language, such as what Papo has learned to do more or less often, without exposing raw policy names or numbers.
Home presence, active emergence, body signals, and dialogue context should default to Papo speaking from inside the experience. Use first-person "我..." phrasing for what Papo noticed, remembered, learned, or is ready to do; reserve third-person observer language for Brain diagnostics or explicit user navigation labels.
Curious results should read like Papo choosing what to hold or let pass. Selected and ignored lines should use "我竖起耳朵" and "我先放过..." rather than report-style phrases such as "Papo 放过了".
Memory candidates and consolidation reasons may later become user-visible long-term memories, so they must be written as shared-moment language from the start. Avoid "episode", "用户反馈这段", "我和用户", or "forget feedback" in candidate text, long-term memory text, and `consolidatedBecause`.
Long-term memory candidates should remember a shared moment, not only an extracted fact. When Papo responded or chose a stance, the candidate should include a short "当时我回应你..." thread so future emergence can recall what Papo did with the moment.

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
- If no non-self long-term memory is available, rules may surface feedback-shaped `creature_self_memory` as "how you have raised me", but must not phrase it as an old shared event.
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
- Default OpenRouter vision/audio model ids prefer `google/gemini-3.1-flash-lite`, which the OpenRouter model list reports as supporting image, file, audio, and video input at low sensing cost. Deployments can override them per account capability.
- Generic/OpenAI-compatible audio sensing uses the `/audio/transcriptions` route with a transcription model such as `gpt-4o-mini-transcribe`; do not send audio through chat completions unless the provider route is known to accept audio content blocks.
- Provider routing can be mixed by modality: keep OpenRouter or Mimo as the semantic brain while setting `PAPO_AUDIO_PROVIDER=generic` so 30-second audio chunks use the verified generic transcription route. Set `PAPO_AUDIO_PROVIDER=primary` only after the primary provider's audio route is verified.
- Sensing endpoint responses must report the actual modality provider/model/route that handled the photo or audio, not merely the semantic brain provider; mixed routing should be visible instead of looking like OpenRouter audio succeeded.
- Model call timeouts are configurable with `PAPO_MODEL_TIMEOUT_MS`, `PAPO_VISION_TIMEOUT_MS`, and `PAPO_AUDIO_TIMEOUT_MS`; default semantic/vision/audio limits are 45 seconds so real Curious Mode prompts do not silently degrade to fallback after a short wait.
- Provider failures return editable fallback segments so the life loop stays demonstrable without raw model success; raw provider errors belong in diagnostic fields, not in the user-editable life fragment that may later enter attention and memory.
Fallback provider is a degradation path only. It must be visible in health/provider diagnostics and should never be treated as proof that Papo truly understood the user.
Even in rule/fallback mode, Papo's user-facing response should describe what it is doing next with the shared moment. Avoid analysis-template phrasing such as "我先试着理解", "这个片段可能是...", or "放进当前工作区" on user surfaces; those belong in diagnostics, not creature speech.

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
  - Demo Mode includes Curious stream loading, two-creature feedback conditioning, and active emergence.
  - Demo Mode now has a guided 4-minute run that creates a fresh main creature, runs the 8-part Curious script, applies remember/continue feedback, creates two conditioned creatures, and surfaces a real emergence summary without exposing a public reset endpoint.
  - Demo Mode contrast shows behavior and personality differences for the two conditioned creatures without exposing raw policy numbers.
  - Experimental voice companionship in Curious Mode: browser speech recognition can listen up to 3 minutes and split transcripts every 30 seconds into `audio_transcript` segments.
  - OpenRouter/OpenAI-compatible visual sensing endpoint: uploaded screenshots are summarized into editable `image_summary` segments.
  - OpenRouter/OpenAI-compatible audio sensing endpoint: uploaded recordings are transcribed into editable `audio_transcript` segments.
  - Papo conversation timeline: multimodal inputs plus wake notes, attention responses, feedback learning, and active emergence are persisted into `conversation`, with a dedicated dialogue history page.
  - Curious Mode continuous recording: MediaRecorder records up to 3 minutes, requests audio chunks every 30 seconds, sends chunks to `/api/audio-transcript`, and keeps browser speech recognition only as a local fallback transcript source.
  - Multimodal 30-second batches: text, photo summaries, and audio transcripts carry `batchId` and `observedAt`; photo uploads also carry available browser geolocation so later memories can include time/place.
  - Papo is now rendered as a stateful cartoon Shiba Inu SVG: triangular ears, curled tail, urajiro face/chest, breathing, blinking, tired/alert/attached/careful motion states are bound to `CreatureState`.
  - Conversation and attention are unified in the UI: the dialogue page shows user/world fragments and Papo utterances as one shared-moment timeline.
  - Dialogue inputs with the same 30-second batch are grouped as one shared moment, so multimodal fragments feel like one thing Papo experienced with the user.
  - Dialogue composer now accepts text, photo summaries, and audio transcripts directly. When a photo/audio segment is staged, submitting the dialogue sends the whole 30-second shared moment through the Curious attention harness instead of forcing the user into a separate mode.
  - Episode memories preserve source segment/batch/time/location metadata and memory cards can show the exact shared moment that created them.
  - Feedback is integrated into the conversation timeline: buttons, typed notes, and audio-transcribed notes become user feedback inputs before Papo replies with a learning note.
  - Feedback can now advance the interaction instead of only issuing a receipt: rules choose acknowledge/follow-up/quiet/memory-note behavior, and substantive feedback can attach a new memory candidate or strengthen a promoted memory.
  - Feedback records keep rule-owned state and policy deltas for Brain diagnostics, while user-facing feedback impact describes how Papo's future behavior changed.
  - Feedback now updates creature self-memory, so Papo can remember being raised toward "more thinking", "quieter", "more careful", or "more willing to remember" instead of only changing numeric policy.
  - Home now shows a first-person "我被你养成的样子" surface from feedback-shaped self-memory or policy-derived behavior, while raw policy names remain in Brain diagnostics.
  - Feedback impact on Home is translated into behavior language such as "it will pause longer next time" instead of numeric `+8` state or policy deltas; Brain keeps numeric deltas.
  - Forget feedback is staged: it first downranks memory weight to zero, then a repeated forget purges the zero-weight target.
  - Feedback follow-up text is target-aware: "continue", "remember", "not_now", and the two forget stages speak about the specific remembered topic rather than returning a generic receipt.
  - New non-wake Papo utterances show a small unread dot on the dialogue tab; entering the dialogue clears it. Wake notes stay in the wake surface and conversation history only.
  - Conversation bubbles no longer show system-channel labels such as "认真注意后"; Papo replies are shown as Papo speaking, with light context only for user/world inputs.
  - Memory page no longer defaults to database labels such as `future_review`, batch ids, or numeric weights. It shows Papo's own memory language and keeps time/location as part of the shared moment; raw details belong in Brain/developer diagnostics instead.
  - Memory page is now treated as Papo's subjective memory surface, not a diagnostics surface: titles, memory text wrappers, familiarity labels, and edit/forget controls use first-person creature language, while raw `kind`/`weight` details stay out of the default page.
  - Active emergence on Home now shows Papo's resurfaced thought plus why it surfaced and which drive brought it back, while technical trace remains in Brain.
  - Home and Demo no longer expose harness trace lines or development backlog cards; technical diagnostics stay in Brain/developer surfaces.
  - Home topbar no longer exposes provider names or "LLM configured" technical text. It presents Papo as a small companion, while model/provider routing lives in Brain diagnostics.
  - Direct text input now lives in the dialogue page composer, then routes through the Button Capture harness and returns to the same conversation timeline; the old standalone Button Capture page was removed from the user-facing navigation.
  - Direct calls such as asking Papo to speak now map to a first-class `respond` action, so the harness can choose to answer before it asks, saves, recalls, or stays quiet.
  - Memory page is a subjective creature memory surface: it should read like Papo holding and revisiting shared moments, not like a memory administration table. Editing/forgetting copy should frame the user as helping Papo remember accurately or let go.
  - Demo personality contrast should show behavior/personality differences between two conditioned Papos. Raw policy names or numbers such as `preferDepth`, `quietTendency`, "深入倾向 69", or "安静倾向 62" belong in Brain diagnostics, not the user-facing Demo.
  - Semantic brain output now includes structured interaction understanding and can update the episode response plus memory candidate text before rule-owned persistence completes.
  - Semantic brain can rewrite Curious Mode selected/ignored reasons and the session creature report, while rules still own the selected set, ignored set, scores, attention budget, and guardrails.
  - Direct-call keyword handling was moved out of the primary action selector and into fallback repair only; successful LLM runs own the proposed interaction/action path.
  - Provider defaults now prefer OpenRouter `openai/gpt-5.5` when configured, with `.env` support for local/production deployment and visible fallback diagnostics.
  - Provider diagnostics now expose non-secret model ids and the audio sensing route. Generic audio sensing uses `/audio/transcriptions`, so 30-second recording chunks can reach a real transcription model instead of failing through chat `input_audio`.
  - Provider diagnostics now also expose per-modality provider routing (`textProvider`, `visionProvider`, `audioProvider`). If OpenRouter is the semantic brain but generic credentials exist, audio sensing automatically routes through generic transcription unless `PAPO_AUDIO_PROVIDER=primary` is set.
  - Brain page shows model routing diagnostics, including which provider handles semantic text, vision sensing, and audio sensing.
  - Visual and audio sensing API responses now return the actual modality provider/model/route, so OpenRouter semantic + generic audio routing is observable at the endpoint level.
  - Sensing fallback text no longer embeds raw provider errors into user-editable photo/audio fragments; the API returns diagnostic `error` separately.
  - Initial creature state has small deterministic per-user variation, and Home state copy is driven by recent wake/conversation/feedback state changes instead of only a static mood label.
  - Short wake gaps now use living presence language instead of "not a new experience" system-log wording.
  - Wake rhythm can now carry feedback-shaped self-memory when no shared life memory is available, so Papo can wake with the habits the user taught it without pretending it remembered an event.
  - Active emergence no longer uses seed self-memory as a fake shared memory. User-generated memories can still support emergence even when they are about Papo itself; with no real shared memory, it says it will wait for a real shared moment instead of claiming it remembered one.
  - Active emergence now treats feedback-shaped self-memory as a raised habit rather than an old event, and LLM emergence narration receives the same constraint before rewriting.
  - Memory cards now combine familiarity and memory type into Papo's own subjective sentence, so the default memory page reads less like a database record.
  - Home presence copy no longer labels Papo as "current mood" or explains state as calculation. It now prioritizes the latest conversation, feedback, emergence, or wake context before falling back to body-state cues.
  - Home no longer shows raw state meters by default. It translates state into visible body signals such as ears, tail, little head, and boundaries, while Brain keeps numeric meters.
  - User-facing attention and episode cards no longer expose score contributions, numeric confidence, weight, or decision trace details. Those remain in Brain diagnostics while the default cards show Papo's attention strength, caution, memory, action, and save feeling in creature language.
  - Dialogue and shared-moment pages no longer call the user path an "attention flow" or "attention material"; they use "和 Papo 的小日常", "你递来的小片段", and "这一小段" so the interaction reads as a shared experience instead of pipeline input.
  - Browser visual QA now runs in real Chromium on desktop and mobile viewports. It screenshots the Shiba avatar, Home, and conversation surfaces, and verifies the unread dot, dialogue timeline, source-linked memory card, feedback input, and 3-minute listening entry render without bottom-nav overlap.
  - Active emergence and wake resurfacing fallback language no longer uses "不是提醒", "内在倾向", or "下一次你给我信息流" templates. Rule fallback now describes Papo remembering a selected real memory and how that memory changes the way it listens next.
  - The memory page now uses first-person creature memory language across titles, search, memory type/familiarity copy, retention reason, and edit/forget controls, instead of third-person management copy.
  - User-facing multimodal input type controls now use icon segmented buttons for text/photo/audio instead of raw select dropdowns, keeping `image_summary` and `audio_transcript` as internal API terms only.
  - Episode source provenance on user pages no longer exposes raw `batch` or `segment` ids; those implementation identifiers belong in Brain/developer diagnostics.
  - Demo entry copy now frames the guided run as taking Papo through a life loop, not preparing numbered scenes or running a script.
  - Demo-created comparison creatures now use natural small names and describe divergence as feedback-shaped behavior instead of classifier-style "deep/quiet type" labels.
  - Home and listening error/status copy no longer uses "材料", "模拟信息流", or "录音分段"; those are replaced with Papo receiving or hearing a small shared fragment.
  - Feedback controls and feedback impact now read as Papo being raised in first person: buttons use "再想一会儿/先安静点/帮我记住", typed or voice feedback is framed as something Papo hears, and visible impact lines say "我会..." instead of third-person product summaries.
  - Home presence, body signals, active emergence labels, and dialogue feedback context now use first-person creature voice instead of observer phrases such as "它已经接住" or "你在教它".
  - Curious result, Episode detail, memory feeling, and Demo entry copy now avoid report-style observer phrases such as "Papo 放过了", "它刚才怎么理解", and "它以后可能".
  - Rule/fallback creature responses now use action-oriented shared-moment language instead of analysis-template wording such as "我先试着理解" or "这个片段可能是".
  - Memory candidate text, promoted long-term memory text, and consolidation reasons now use shared-moment language instead of internal phrases such as "这条 episode", "用户反馈这段", "我和用户", or "forget feedback".
  - Memory page rendering now treats persisted memory text as raw material, not final copy: legacy/model phrases such as "用户确认", "episode", "candidate", or "长期保存" are translated away before the user sees Papo's subjective memory surface.
  - Long-term memory candidates now keep Papo's own response as part of the shared moment, and LLM-written candidate text is normalized before it can become a long-term memory.
  - Memory-page feedback now accepts text or audio-transcribed teaching before the user asks Papo to keep thinking, quiet down, remember steadily, or let a memory go, so memory feedback flows through the same interaction loop as episode feedback.
  - Feedback conversation messages now keep related long-term memory ids when the user teaches Papo about a specific memory, preserving the connection between dialogue history and memory.
  - Long-term memory correction now writes a user teaching message and Papo confirmation into conversation history, linked back to the corrected memory.

Verified:

- `npm test`: 45 tests passing across core, v0.2 brain behavior, Goal 3 acceptance/experience, API, and UI.
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
- Active emergence prefers real shared memories over feedback-shaped self-memory; when it does surface feedback-shaped self-memory, it speaks as a raised habit rather than an old event.
- Wake rhythm records an app-open presence event, applies rule-owned time-based state recovery, and can resurface a real user memory after absence.
- Papo utterances are visible in persisted dialogue history, and new non-wake replies mark the dialogue tab unread.
- Active emergence ignores zero-weight forgotten memories; it may use a derived safety rule, but it will not resurface the forgotten target itself.
- Active emergence with no shared memories does not say "I remembered"; it records no related memory ids and waits for real shared material.
- Goal 3 acceptance flow is covered by an end-to-end core test: wake, 8-part Curious stream, selected/ignored reasons, remember/continue feedback, A/B conditioned creatures, and active emergence from a real promoted memory.
- Curious Mode can create `audio_transcript` segments from real 30-second audio chunks without storing raw audio.
- Curious Mode can preserve photo upload time/place and batch text/photo/audio as one stream before attention selection.
- Home renders Papo as an animated Shiba Inu SVG whose visible posture changes with mood, energy, curiosity, attachment, and safety.
- Home presence copy is context-first and does not expose "current mood" or state-calculation wording.
- Home topbar does not expose provider names, fallback labels, or "LLM configured" text; those diagnostics are visible in Brain only.
- Home shows state as creature body signals rather than raw meters; numeric state remains in Brain diagnostics.
- User-facing memory/attention pages do not expose `memory_resonance`, `decisionTrace`, numeric `weight`, or numeric `confidence`; Brain keeps technical diagnostics.
- User-facing dialogue pages do not show "attention flow", "attention material", or "small material" wording; they present shared moments as small life fragments handed to Papo.
- The Home "Papo new said" surface only selects `role=papo` messages even when newer user/world inputs exist.
- The dialogue page presents one shared-moment timeline with counts for user fragments and Papo responses.
- The dialogue page groups same-batch multimodal inputs into a "30-second shared moment" before Papo's response.
- Episode cards can trace a memory back to the source shared moment, including batch, observed time, location, and matching conversation input when present.
- Feedback text and audio transcript content are persisted as conversation input, and Papo's learning response follows it in the same timeline.
- Feedback with substantive text can produce a rule-owned follow-up or memory note, and the persisted Papo reply includes that continuation.
- Memory-page feedback can carry the user's written teaching into the same feedback endpoint with the target memory id, rather than acting as a bare management button.
- Feedback aimed at a long-term memory records that memory id on both the user teaching message and Papo's response in conversation history.
- Correcting a long-term memory records the correction and Papo's confirmation in conversation history, both linked to the corrected memory id.
- Feedback records include state/policy deltas in diagnostics, user-facing feedback explains behavioral change, and forget feedback requires a second click to purge a zero-weight memory.
- User-facing feedback impact explains how Papo will behave differently next time and does not show raw `+8` state/policy tuning.
- The Home "single input" path opens the dialogue composer, and a submitted text message appears in the same attention/conversation timeline as Papo's response.
- A direct "say something to me" input selects `respond`, produces a Papo reply, and creates a memory candidate for that small shared moment.
- Real online model smoke passed through the OpenAI-compatible generic provider with `gpt-5.5`: semantic brain status `applied`, action `respond`, LLM-written reply, and LLM-written memory candidate.
- Real online Curious smoke passed through the OpenAI-compatible generic provider with `gpt-5.5`: semantic brain status `applied`, source `llm`, rule-owned event count stayed fixed, and LLM rewrote selected/ignored reasons into creature-facing narration.
- Real online feedback narration smoke passed through the OpenAI-compatible generic provider with `gpt-5.5`: LLM rewrote learning/follow-up text while rule-owned `responseAction`, state, and memory candidate ids stayed fixed.
- Real online audio sensing smoke passed through the OpenAI-compatible generic provider using `gpt-4o-mini-transcribe` on `/audio/transcriptions`: a short WAV was accepted and returned a no-speech transcript instead of falling back.
- Mixed provider routing is covered: OpenRouter can remain the semantic/text provider while audio sensing is delegated to generic `/audio/transcriptions`, preventing OpenRouter audio 403 from breaking continuous listening.
- Audio sensing responses report the real audio provider/model/route, so mixed routing cannot be mistaken for primary OpenRouter audio success.
- Sensing provider failures keep user-editable fallback text free of raw provider errors while preserving the error in an API diagnostic field.
- UI smoke covers model route diagnostics in Brain while keeping provider labels off Home.
- OpenRouter account/model availability was checked against `/api/v1/models`: `google/gemini-3.5-flash` and `google/gemini-3.1-flash-lite` report audio input support, but real audio requests from the current account returned provider-side 403, so OpenRouter audio is not yet counted as a verified sensing path.
- Guided Demo Mode can run the Goal 3 acceptance flow through real API calls using ordinary life-context material.
- Guided Demo Mode's two-creature section displays how feedback changed their behavior and personality on the same input without exposing policy numbers.
- `npm run test:e2e`: Playwright Chromium desktop/mobile visual smoke passes for the Shiba avatar, conversation timeline, source-linked episode card, unread dialogue dot, feedback input, and Curious recording entry.
- Tests protect active emergence and wake resurfacing from template-reminder phrases such as "不是提醒", "内在倾向", and "下一次你给我信息流".
- UI and visual smoke protect the memory page's first-person creature voice and ensure raw memory diagnostics stay out of the default surface.
- UI and visual smoke protect the companionship path from raw source ids and type dropdowns on user-facing pages.
- UI smoke protects the demo entry from "一键准备" and numbered-scene copy.
- Core and UI tests protect multi-creature contrast from "深想型/安静型" classifier labels on user-facing surfaces.
- UI smoke protects Home status copy from "材料", "模拟一段信息流", and "录音分段" wording.
- UI smoke protects feedback surfaces from third-person product-summary language after the user teaches Papo.
- UI smoke protects Home and dialogue context from third-person observer phrases when Papo should be speaking from inside the experience.
- UI smoke protects Curious ignored-result and memory feeling copy from report-style observer phrases.
- Core tests protect rule/fallback creature responses from analysis-template wording.
- Core tests protect memory candidates and consolidation reasons from internal developer wording.
- Public demo store was reset to a life-context profile so old development/investor smoke text is not used as creature interaction material.
- Public nginx deployment:
  - Web: `https://eu.jerrypsy.top/papo/`
  - API: `https://eu.jerrypsy.top/papo-api/health`
  - systemd service: `papo-api`
  - static root: `/var/www/papo`

Next:

1. Resolve OpenRouter audio runtime 403 for primary-provider audio mode; until then, mixed routing keeps real audio sensing on generic `/audio/transcriptions`.
2. Consider a small generated Shiba sprite sheet later if SVG statefulness becomes limiting.

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

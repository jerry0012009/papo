# Papo Development Document

This document is maintained alongside the active Goal. Keep it truthful: if the product needs a real model, the document must say so.

## North Star

Papo is a mobile-first minimum viable lifeform: a small Shiba companion that can hear text, photos, and audio; understand a shared moment; choose whether to respond; remember what matters; learn from feedback; and later surface a real memory.

The product should feel like raising a small creature, not watching a database, a pipeline demo, or a scripted chatbot.

## Current Goal

The current goal is "LLM as Papo's brain".

- Real model calls are required for cognition, action selection, memory decisions, feedback reflection, emergence, vision, and audio sensing.
- If a required model call fails, returns empty output, returns invalid JSON, or selects a visible action without a visible reply, the system must fail loudly.
- Quiet listening is valid only when the model explicitly chooses it. It is not a degraded local substitute for understanding.
- No local semantic keyword rule should pretend to understand what the user meant. Rules may create candidates and enforce boundaries; the model owns meaning and wording.
- Privacy guardrails are structural only: obvious secrets, tokens, passwords, private keys, and government/payment identifiers are marked high privacy and cannot be auto-promoted into long-term memory.

## Harness Contract

Rules own only engineering structure:

- State initialization and clamping.
- Multi-user isolation.
- Candidate event creation.
- Attention budgets and source ids.
- Action enum whitelists.
- Memory persistence, deletion, and cross-user safety.
- Feedback bounds and numeric state/policy limits.
- Diagnostics for real provider failures.

LLM owns semantic work:

- What happened in the user's text/photo/audio.
- Whether Papo should respond, ask, stay quiet, remember, recall, or review.
- Whether an attended input should become an episode or only remain in the conversation timeline.
- Whether an episode should enter memory-candidate review.
- Papo's visible reply.
- Papo's visible behavior phrase when needed.
- Structured action results for non-chat actions, such as reminder drafts and question-list drafts.
- Candidate memory wording and tags.
- Feedback reflection, learning language, and memory operations.
- Active emergence message and why it is surfacing.
- Vision summaries and audio observations.

The boundary is strict: rules do not judge user meaning or wording. LLM output is not locally rewritten with keyword filters.

## Product Shape

- Dialogue and companionship are one surface.
- Text, photo, uploaded audio, and continuous listening chunks enter the same conversation timeline.
- The default UI is the companion product, not a harness demo. Internal cognition, model calls, state, personality, and memory decisions belong behind small inspection controls; the first-view experience should show Papo, the conversation, and memories in ordinary user language.
- Continuous listening is internally batched around 30 seconds for up to 3 minutes, but the user should experience it as Papo listening with them.
- Continuous listening records audio chunks and sends them to the configured audio model. Browser/local speech recognition output must not bypass the model into the life stream.
- Browser `MediaRecorder` chunks may be `webm/opus` or another container. Provider code must convert chat-completions audio input to a model-readable format such as wav when the selected model rejects the browser container; this is an ingestion format fix, not a transcription fallback.
- Text typed while continuous listening is active is buffered into the current 30-second curious batch, not as a separate button-only dialogue path.
- Empty audio, silence, noise, and unclear speech are ordinary inputs for the model to ignore or use.
- Photo input records upload time and available browser location so memory can later keep natural provenance.
- Papo replies are model-written external behavior, not frontend templates.
- Developer inspection belongs behind a small per-message disclosure control. It should show the full cognition chain for that reply: attention, action selection, visible action result, episode persistence, memory candidate handling, feedback effects, emergence choice, model stages, structural checks, and memory outcomes. It must not become the default creature-facing experience.
- Memory cards default to what the user shared and what the model decided to remember.
- Feedback text/audio/buttons are all interaction input and may trigger learning, memory updates, or new dialogue. Buttons and memory edits should pass structured feedback kinds such as `important`, `remind`, or `correct`; the frontend/backend must not fake user feedback by injecting hardcoded semantic sentences.

## Provider Policy

- Supported real providers: OpenRouter, Mimo, and generic OpenAI-compatible APIs.
- Provider config comes from environment, `.env`, `papo.config.json`, or `.papo/provider.json`.
- `PAPO_PROVIDER` may explicitly select `openrouter`, `mimo`, or `generic`.
- `PAPO_VISION_PROVIDER`, `PAPO_AUDIO_PROVIDER`, and `PAPO_IMAGE_PROVIDER` may route sensing or generation to a different real provider than the semantic text brain when one provider is stronger for a modality.
- Model ids are configurable per modality.
- Default semantic models should prefer the strongest available configured model, currently `openai/gpt-5.5` for OpenRouter or `gpt-5.5` for generic.
- Vision sensing currently uses the verified OpenRouter default `nex-agi/nex-n2-mini`.
- Audio sensing should prefer native audio-capable multimodal models. The current OpenRouter default is `xiaomi/mimo-v2.5`, whose OpenRouter metadata exposes text+image+audio+video input. `xiaomi/mimo-v2.5-pro` remains a strong text model but is text-only on OpenRouter, so it should not be selected for audio sensing there.
- Audio chat models that only accept mp3/wav receive browser-recorded chunks after server-side wav transcoding.
- Mixed routing is allowed: for example, Mimo can be the semantic provider while OpenRouter handles image/audio sensing, or OpenRouter can be the semantic provider while generic audio uses a native audio chat model. Transcription endpoints are used only when explicitly configured with a transcription/whisper model id, not as the default listening path.
- Provider errors are product errors. They should be visible through API errors and diagnostics instead of being hidden behind local wording.
- Image generation is exposed through `ModelProvider.generateImage`. OpenRouter image-output models use the official `/api/v1/images` endpoint by default; OpenAI-compatible image endpoints use `/images/generations`; chat-completion image output remains a compatibility route only when explicitly configured. Current low-cost OpenRouter default is `google/gemini-3.1-flash-lite-image`, verified on 2026-07-08 with a real request returning a JPEG data URL. If the configured provider rejects image generation or lacks balance, the action must fail loudly rather than substituting a fake picture.
- If a real model repeatedly returns empty or invalid structured output for core cognition, switch to another configured real provider/model and verify it with scenario smoke tests. Do not add local semantic fallback to mask the model failure.

## Code Map

- `src/core/provider.ts`: real provider selection and OpenAI-compatible calls.
- `src/core/attention.ts`: structural input candidates and pacing primitives; no semantic scoring.
- `src/core/harness.ts`: semantic cognition loop and visible-output contract.
- `src/core/semantic-action.ts`: model action selection.
- `src/core/semantic-attention.ts`: model attention selection for direct text and stream inputs.
- `src/core/semantic-memory.ts`: model memory decisions.
- `src/core/feedback.ts`: feedback application plus model reflection.
- `src/core/emergence.ts`: active resurfacing through model decisions.
- `src/core/model-context.ts`: shared model context.
- `src/core/conversation.ts`: user/world/Papo timeline.
- `src/server/app.ts`: API orchestration.
- `src/web/App.tsx`: mobile-first interaction UI.
- Verification currently relies on TypeScript/build checks plus real provider smoke tests.

## Current Implementation Notes

- The provider layer throws when credentials are missing.
- `generateJson` must distinguish empty model content from invalid JSON content. Invalid JSON is a provider/model contract failure, not an empty result.
- `generateJson` may unwrap a JSON-encoded object string produced by a provider, but it must not synthesize missing semantic fields or repair invalid model decisions.
- Sensing endpoints call real model providers directly. Image/audio failures return errors.
- The semantic harness strips rule-created visible drafts before model action/wording. Papo's final visible reply must come from a model.
- `attention.ts` creates neutral candidates only. It must not write creature-facing replies, semantic "noticed" explanations, keyword tags, related-memory guesses, curious reports, or mixed-preference dialogue.
- Attention candidate scores are structural pacing only. They must not contain fake semantic dimensions such as novelty, emotional charge, memory resonance, local tags, or local related-memory guesses.
- Direct text and curious stream input start with zero attention events. `semanticDecideAttention` must select segments with the model and provide noticed content, user meaning, memory relation, valid related memory ids, and tags before episodes or memory candidates are created.
- Action selection code is an enum executor, not a semantic classifier. It must not locally replace a model-selected visible action because of mood, energy, keywords, or confidence heuristics.
- Pre-action structures may carry a placeholder `ActionDecision` only so the event is serializable. That placeholder must not be exposed to the action prompt as a suggested/current action, and it must not appear in Brain Mode as a final rule-selected action. The final action exists only after `semanticSelectAction` returns a model-selected whitelisted action.
- Attention selection must not apply fixed mood/state deltas just because something was noticed. The action model owns `stateDeltas` for the actual interaction; rules only clamp, save before/after, and expose the result in Brain Mode.
- Visible reply validation is structural only. Do not use local substring/keyword rules to block a model reply for echoing user text; repeating or quoting user text may be exactly what the user asked for, so that judgment belongs in the action prompt and the model decision.
- `draft_reminder` and `draft_question_list` are real action types, not alternate labels for a chat reply. The model must return `actionResult` with the reminder draft or question-list draft; otherwise the request fails loudly.
- Save actions may return `actionResult.kind=memory_intent` to show the action brain chose to hand the event to memory. This is not proof that long-term memory was written; the memory model result remains authoritative.
- Explicit user requests to remember or save something are semantic action requirements, not local keyword rules. The action model must normally keep an episode and hand it to memory consideration unless it judges the content unusable or inappropriate to save; real smoke tests should catch regressions here.
- `semanticSelectAction` owns the persistence decision for attended input. It must explicitly return whether to keep an episode and whether to keep a memory candidate; rules may prune temporary structures but must not default every input into memory.
- Memory candidates keep user text and provenance only. Initial kind, confidence, and write policy are storage placeholders, not cognition. Memory kind, tags, consolidation wording, write policy, and long-term meaning must come from `semanticDecideMemory` before they are treated as product cognition.
- Memory candidates are user-maintainable objects, not hidden internals. The memory page should let the user view candidates separately from long-term memories and give feedback on them. Candidate promotion, candidate rewriting, and candidate dismissal must go through `semanticReflectFeedback` or another LLM decision function, not direct frontend writes.
- Long-term memory tags are copied from the model-decided memory candidate only. Rules must not synthesize fallback tags from user text.
- Long-term memory writes happen only when the memory model returns `writePolicy=auto`. A model-selected action of `save_long_term` means the action brain strongly recommends handing the event to memory, but it does not override the memory brain. `ask_user`, `wait_feedback`, and `do_not_save` never auto-promote, and high-privacy candidates are forced away from `auto`.
- Dreaming is the LLM memory-organizing path. It may update, merge, dismiss candidates, promote candidates, or apply small state changes only through structured operations that rules validate by id. Rules must not perform semantic similarity merges or keyword-based pruning.
- Automatic dreaming runs in the server background when memory volume crosses structural thresholds, with a structural cooldown to prevent repeated model calls. The model still decides whether anything should be changed; a no-op model decision is stored as an internal quiet dream record, not as a Papo conversation message.
- The storage layer may merge exact duplicate long-term memory text into an existing active memory, updating weight/tags/lastReferencedAt instead of creating a second row. Semantic near-duplicate judgment still belongs to the memory model.
- There must be no public endpoint that directly promotes an episode to long-term memory without a model memory or feedback decision.
- The web UI must not fill empty Papo replies with "我听见了" or other local placeholder speech. If the model chose quiet or failed to provide a visible reply, the product should show no forged reply.
- The product UI should not ship seeded demo loops or fake life-material buttons. The user-facing flow starts from real user text, photos, audio, or continuous listening.
- Wake rhythm only updates presence/state. It must not pick memories, write emergence records, or feed wake text back into model conversation context.
- Active emergence has no rule-generated path. `/emergence` must call the model to decide quiet vs resurfacing and to choose a valid memory.
- The old "rules create emergence, model polishes narration" path is removed; polishing a fake decision is still fake cognition.
- Emergence guardrails validate that the chosen memory exists and is active; they must not use local keyword or token matching to decide whether the model's message semantically references the memory.
- Emergence has a structural cooldown after active resurfacing. The model is still called with the cooldown context and should choose quiet; if it selects active emergence during cooldown, the guardrail blocks the visible message.
- When there are no candidate memories, emergence still uses a compact model call that must choose quiet; this is not a local fake quiet response.
- Quiet emergence must not create a blank or fake Papo conversation message. `/emergence` returns the cognition trace with the response so Brain Mode can inspect the model decision even when there is no visible behavior.
- Proactive emergence runs server-side, independent of whether the web page is open. The scheduler only decides when a profile is due; `semanticDecideEmergence` still decides whether to speak, which memory to surface, why now, and the exact message.
- Proactive cadence is structural: normal due checks every 30 minutes; after one unanswered proactive message, skip the next 30-minute window and check 60 minutes after the message; after two unanswered proactive messages, wait 12 hours; after three unanswered proactive messages, pause proactive checks until the user sends any new input or feedback.
- Proactive messages are ordinary `emergence` Papo conversation messages with cognition traces. The UI should surface them with a small unread count and never with a disruptive modal or rule-written notification text.
- Feedback capture records the user's teaching. Explicit forget still performs the storage-layer weight/drop operation, but remembering, importance, reminder intent, memory correction, memory promotion, soft dismissal, state changes, policy changes, learning language, and creature self-memory must come from `semanticReflectFeedback`.
- Feedback reflection must receive a pre-operation target snapshot. This is especially important for explicit forget: the storage layer may lower weight to 0 or purge a memory before the model reflection runs, but the LLM still needs to understand what the user chose to let go, and Brain Mode must show the actual storage change.
- Creature self-memory created from feedback must use model-provided text, tags, consolidation reason, and weight. Rules may dedupe and clamp values, but must not inject hardcoded semantic tags or creature-voice explanations.
- Memory correction uses `FeedbackKind=correct`; for a long-term memory target, the feedback model must return `memoryOperation.update_memory` with corrected text before the stored memory changes.
- Feedback reflection may store internal learning notes and policy/state deltas, but ordinary chat only shows `replyText` when the model chooses a visible response.
- Feedback Brain Mode must show actual storage effects, including long-term memories created or updated from an episode promotion. A feedback trace that only says the feedback model ran, without showing the resulting memory/state/policy changes, is not enough for developer audit.
- If the model chooses a visible action such as `respond`, `ask`, `recall`, or `review`, a visible reply is required.
- If the model chooses `observe` or `quiet`, it must not provide a visible reply; the API may persist the user's input without adding a Papo reply.
- `use_hermes` is a real action selected by the action model when Papo needs external capabilities. The request path must be fire-and-forget: Papo immediately replies to the user, records a `hermes_task`, and lets a background dispatcher call Hermes. Hermes results re-enter the same attention/action/memory pipeline as a world input from "虾虾的回复".
- `generate_illustration` is a real action selected by the action/emergence model when Papo should turn a remembered or current moment into a hand-drawn/comic-style image. The model must provide the illustration prompt, title, caption, and source memory/episode hints; rules only call the image provider, save the generated asset, attach it to the conversation/emergence record, and expose the trace.
- Evening observation diary is a model-owned product behavior, not a cron-written template. Between local 19:00 and 24:00, proactive emergence may ask the model whether today's real episodes, conversation, audio observations, and photo attachments deserve one illustrated diary if none has been sent that local day. The model may choose quiet, a plain message, or an illustration. When images are available, prompts should prefer original image attachments as grounding context where the provider supports it; otherwise use factual summaries and provenance.
- Discord dispatch requires a Papo bot identity that Hermes Gateway treats as an inbound user, not the same bot identity Hermes uses to send replies. Reusing the Hermes bot token can create/send channels, but Hermes ignores its own messages. In that environment use `PAPO_HERMES_DISPATCH=cli` for a real local Hermes executor, or configure an independent `PAPO_DISCORD_BOT_TOKEN` and `PAPO_DISCORD_GUILD_ID`.
- CLI Hermes dispatch must preserve one Hermes conversation per Papo user. Use `hermes chat -Q --source tool` and persist `profile.hermes.sessionId/sessionName`; subsequent tasks for that user must use `--resume`. Do not use one-shot `-z` for production Papo dispatch because it discards per-user Hermes context.
- Recent conversation, memories, and feedback are passed into model prompts through `model-context.ts`.
- For button and curious captures, the current input is passed to the semantic brain as the current event/candidate, then appended to the conversation timeline after cognition. `recent_conversation` must represent prior context, not duplicate the current input.
- During live listening, audio capture, audio sensing, batch buffering, and cognition are separate steps. The browser must cut immutable audio slices on the 30-second rhythm even when earlier slices are still being sensed or processed.
- Continuous browser recording must close each 30-second `MediaRecorder` segment and immediately start a new recorder. Do not use `requestData()` chunks from one long WebM stream as independent files; later chunks may miss container headers and fail ffmpeg/model ingestion.
- Text, photo, and uploaded-audio inputs submitted during live listening enter the buffer for their current `batchId`. The batch is closed on the 30-second boundary, waits briefly for the audio model to settle, and then submits one ordered multimodal `/curious` request. If the audio model is slow, the batch may flush after a max wait and late audio can still arrive as a later input with the same batch id; raw captured blobs must not be dropped because cognition is busy.
- If one audio slice fails sensing at the network/provider layer, that slice settles its batch without adding fake content. Other text/photo/audio material in the same or later batches must continue into cognition.
- When live listening stops at the 3-minute boundary, the browser may emit duplicate or empty recorder data. Duplicate final slices should be suppressed, zero-byte slices should settle their batch immediately, and unassigned recorder tail data after stop should be ignored instead of becoming a new manual event.
- LLM prompts must carry source provenance for recent conversation and current candidates: `sourceId`, `batchId`, `observedAt`, `location`, modality, and related memory ids where available. This is harness context, not a local semantic rule.
- During feedback reflection, the current feedback is passed through the dedicated `feedback` field. `recent_feedback` must contain prior feedback only, not the same current feedback record repeated as history.
- Development planning text must not be used as creature interaction material.
- Real model smoke tests must not pollute the public profile store with development profiles or scripted life material. Use in-memory profiles or an isolated temporary store for dialogue, attention, action, memory, feedback, and emergence smoke tests. Public API smoke is limited to provider/health/page checks and sensing endpoints unless the created profile is immediately pruned from production data.
- `npm run smoke:real-cognition` starts an in-memory API and calls the configured real provider through a user scenario. It should verify attention, action, feedback, and emergence traces without writing to `data/papo-store.json`.
- Real cognition smoke must fail with a named scenario step and request timeout instead of hanging silently. Use `REAL_SMOKE_REQUEST_TIMEOUT_MS` to adjust the per-step HTTP timeout when debugging slow providers.
- Real cognition smoke should include at least one multi-turn context follow-up, such as asking what the previous user message said, so repeated-template replies and broken conversation context are caught by a real model call.
- New Papo messages persist `cognitionTrace` with the real model stages, attention/action/memory decisions, feedback effects, emergence choices, visible reply, persistence outcomes, and structural rule checks that produced that visible reply. This supports developer audit without proving the mechanism in the main UI.
- When the model chooses quiet, ignores input, or feedback produces no visible reply, the product must not create a blank/fake Papo message. The same cognition trace should attach to the relevant user/world input message so Brain Mode can still inspect the complete decision path.
- Audio and image segments that enter the conversation carry a sensing trace from the modality model before the attention trace. Brain Mode should show whether the model found usable life information, whether rules routed it into the 30-second attention batch, or whether the slice/upload was settled as empty/unreadable without creating a fake event.
- Browser audio chunks can be empty or container-incomplete. Format/conversion failures such as invalid WebM/EBML are treated as `sensingTrace.status=unreadable` and settle that audio slice without entering attention. This is not a semantic fallback and must not create user-visible Papo speech or memory.
- Photo uploads are usually deliberate life material. After visual sensing produces an `image_summary`, the action and memory models should usually preserve a meaningful photo as an episode/memory candidate unless the model judges it repeated, meaningless, accidental, private, or otherwise unsuitable. Photo memories should include visible image content plus user-provided text, time, and location provenance where available.
- Photo uploads are multimodal memory material, not just text summaries. `/api/image-summary` stores the original image as a local asset and returns a `MediaAttachment`; the web client attaches it to the `image_summary` segment with observed time/location. Attention events, episodes, memory candidates, long-term memories, and conversation messages all propagate that attachment. LLM stages still decide whether to attend, form an episode, and keep a memory candidate; the structural path only prevents uploaded images from being discarded before cognition.
- If the vision model returns an empty summary for an uploaded image, the web client must still send a truthful image segment with the original attachment and a "not clearly seen" observation. It must not silently drop the user's photo, and it must not invent visible image contents.
- Profile storage must be safe for asynchronous cognition. User input, Hermes replies, proactive emergence, and dreaming may save the same profile from different async paths; persistence must merge append-only records and preserve terminal `hermes_task` states instead of letting a stale request overwrite completed cognition.
- Users register or log in with a stable `userId`; the web client stores that id in `localStorage` and no longer creates or switches a shared Public Papo automatically. Each profile owns one Papo, one memory graph, one personality state, one proactive state, and one Hermes context.
- Registration stores `profile.petKind`. The default is the SVG Shiba, and additional selectable pets use MIT `agent-pet` sprite atlases under `public/pets/agent-pet`. Model prompts receive `pet_context` so cognition and visible behavior can account for the chosen companion type.
- Papo's visible idle/ambient state is a model-maintained profile field (`dogState`) refreshed by the server when due, normally around every hour. Rules provide a validated catalog and timing; the model chooses which state fits current time, memories, recent conversation, and profile state.
- Default user-visible and model-local time is `Asia/Shanghai`, configurable through `PAPO_TIME_ZONE` on the server and `VITE_PAPO_TIME_ZONE` in the web build. Recent conversation context includes local time in addition to ISO timestamps.

## Verification Checklist

- `npm run build`
- Public provider and page checks after deploy.
- Public provider check returns a real provider with `usesRealModel=true`.
- Real online smoke: direct dialogue should produce a context-specific reply, not repeated template wording.
- Real online smoke: photo/audio sensing should either return real model output or fail visibly.
- Real online smoke: noisy or empty audio should not become life content.
- Public nginx deployment:
  - Web: `https://eu.jerrypsy.top/papo/`
  - API: `https://eu.jerrypsy.top/papo-api/health`
  - systemd service: `papo-api`
  - static root: `/var/www/papo`

## Next Work

1. Run a real-user pilot on the deployed mobile UI and record friction in the first five minutes: first message, photo upload, continuous listening, memory feedback, and proactive unread flow.
2. Add real backend conversation pagination before user history grows large. The current web UI renders only the latest pages and can load older records, but the API still returns the full profile.
3. Add browser-level screenshot checks for mobile and desktop app states so future UI changes catch overflow, hidden composers, and broken Brain Mode popovers before demo use.
4. Verify OpenRouter vision/audio model routing with real accounts periodically, using cost-effective models first and switching only when a real scenario proves the current model weak.
5. Resolve real image generation provider availability. Current engineering path supports `generate_illustration`, but live smoke on 2026-07-08 showed OpenRouter image-output models returning provider 403 ToS errors and the generic OpenAI-compatible image route returning insufficient balance. Configure a funded/allowed image provider, then rerun a real illustration smoke before marking the illustration goal complete.
6. Improve the Shiba animation only where it helps the interaction, such as clearer listening, thinking, resting, and happy states tied to model-chosen actions.
7. Prepare a short demo script using real inputs and real model calls, not seeded fake life material, so the commercial demo proves the harness rather than the happy path.

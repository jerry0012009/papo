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
- Candidate memory wording and tags.
- Feedback reflection, learning language, and memory operations.
- Active emergence message and why it is surfacing.
- Vision summaries and audio observations.

The boundary is strict: rules do not judge user meaning or wording. LLM output is not locally rewritten with keyword filters.

## Product Shape

- Dialogue and companionship are one surface.
- Text, photo, uploaded audio, and continuous listening chunks enter the same conversation timeline.
- Continuous listening is internally batched around 30 seconds for up to 3 minutes, but the user should experience it as Papo listening with them.
- Continuous listening records audio chunks and sends them to the configured audio model. Browser/local speech recognition output must not bypass the model into the life stream.
- Empty audio, silence, noise, and unclear speech are ordinary inputs for the model to ignore or use.
- Photo input records upload time and available browser location so memory can later keep natural provenance.
- Papo replies are model-written external behavior, not frontend templates.
- Developer inspection belongs behind a small per-message disclosure control. It should show the full cognition chain for that reply: attention, action selection, visible action result, episode persistence, memory candidate handling, model stages, structural checks, and memory outcomes. It must not become the default creature-facing experience.
- Memory cards default to what the user shared and what the model decided to remember.
- Feedback text/audio/buttons are all interaction input and may trigger learning, memory updates, or new dialogue.

## Provider Policy

- Supported real providers: OpenRouter, Mimo, and generic OpenAI-compatible APIs.
- Provider config comes from environment, `.env`, `papo.config.json`, or `.papo/provider.json`.
- `PAPO_PROVIDER` may explicitly select `openrouter`, `mimo`, or `generic`.
- Model ids are configurable per modality.
- Default semantic models should prefer the strongest available configured model, currently `openai/gpt-5.5` for OpenRouter or `gpt-5.5` for generic.
- Audio sensing should prefer native audio-capable multimodal models. The current OpenRouter default is `xiaomi/mimo-v2.5`, verified through chat completions audio input.
- Mixed routing is allowed: for example, OpenRouter can be the semantic provider while generic audio uses a transcription endpoint as its provider route.
- Provider errors are product errors. They should be visible through API errors and diagnostics instead of being hidden behind local wording.

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
- Sensing endpoints call real model providers directly. Image/audio failures return errors.
- The semantic harness strips rule-created visible drafts before model action/wording. Papo's final visible reply must come from a model.
- `attention.ts` creates neutral candidates only. It must not write creature-facing replies, semantic "noticed" explanations, keyword tags, related-memory guesses, curious reports, or mixed-preference dialogue.
- Attention candidate scores are structural pacing only. They must not contain fake semantic dimensions such as novelty, emotional charge, memory resonance, local tags, or local related-memory guesses.
- Direct text and curious stream input start with zero attention events. `semanticDecideAttention` must select segments with the model and provide noticed content, user meaning, memory relation, valid related memory ids, and tags before episodes or memory candidates are created.
- Action selection code is an enum executor, not a semantic classifier. It must not locally replace a model-selected visible action because of mood, energy, keywords, or confidence heuristics.
- `semanticSelectAction` owns the persistence decision for attended input. It must explicitly return whether to keep an episode and whether to keep a memory candidate; rules may prune temporary structures but must not default every input into memory.
- Memory candidates keep user text and provenance only. Initial kind, confidence, and write policy are storage placeholders, not cognition. Memory kind, tags, consolidation wording, write policy, and long-term meaning must come from `semanticDecideMemory` before they are treated as product cognition.
- Long-term memory tags are copied from the model-decided memory candidate only. Rules must not synthesize fallback tags from user text.
- Long-term memory writes happen only when the model-selected action is `save_long_term` or the model-selected memory `writePolicy` is `auto`; `ask_user` and `do_not_save` never auto-promote, and high-privacy candidates are forced away from `auto`.
- There must be no public endpoint that directly promotes an episode to long-term memory without a model memory or feedback decision.
- The web UI must not fill empty Papo replies with "我听见了" or other local placeholder speech. If the model chose quiet or failed to provide a visible reply, the product should show no forged reply.
- The product UI should not ship seeded demo loops or fake life-material buttons. The user-facing flow starts from real user text, photos, audio, or continuous listening.
- Wake rhythm only updates presence/state. It must not pick memories, write emergence records, or feed wake text back into model conversation context.
- Active emergence has no rule-generated path. `/emergence` must call the model to decide quiet vs resurfacing and to choose a valid memory.
- The old "rules create emergence, model polishes narration" path is removed; polishing a fake decision is still fake cognition.
- Emergence guardrails validate that the chosen memory exists and is active; they must not use local keyword or token matching to decide whether the model's message semantically references the memory.
- When there are no candidate memories, emergence still uses a compact model call that must choose quiet; this is not a local fake quiet response.
- Feedback capture records the user's teaching. Explicit forget still performs the storage-layer weight/drop operation, but remembering, memory correction, memory promotion, soft dismissal, state changes, policy changes, learning language, and creature self-memory must come from `semanticReflectFeedback`.
- Feedback reflection may store internal learning notes and policy/state deltas, but ordinary chat only shows `replyText` when the model chooses a visible response.
- If the model chooses a visible action such as `respond`, `ask`, `recall`, or `review`, a visible reply is required.
- If the model chooses `observe` or `quiet`, it must not provide a visible reply; the API may persist the user's input without adding a Papo reply.
- Recent conversation, memories, and feedback are passed into model prompts through `model-context.ts`.
- Development planning text must not be used as creature interaction material.
- New Papo messages persist `cognitionTrace` with the real model stages, attention/action/memory decisions, visible reply, persistence outcomes, and structural rule checks that produced that visible reply. This supports developer audit without proving the mechanism in the main UI.

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

1. Continue auditing visible surfaces so Papo shows behavior and speech, not cognition traces.
2. Add real provider smoke checks only when they exercise actual user scenarios, not local wording templates.
3. Verify OpenRouter vision/audio model routing with real accounts, using cost-effective models first.
4. Improve the Shiba animation only where it helps the interaction, not as decorative proof.

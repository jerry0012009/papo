# Papo Development Document

This document is maintained alongside the active Goal. Keep it truthful: if the product needs a real model, the document must say so.

## North Star

Papo is a mobile-first minimum viable lifeform: a small Shiba companion that can hear text, photos, and audio; understand a shared moment; choose whether to respond; remember what matters; learn from feedback; and later surface a real memory.

The product should feel like raising a small creature, not watching a database, a pipeline demo, or a scripted chatbot.

## Current Goal

The current goal is "LLM as Papo's brain".

- Real model calls are required for cognition, action selection, memory decisions, feedback reflection, emergence, vision, and audio sensing.
- If a required model call fails, returns empty output, returns invalid JSON, leaks internal process language, or selects a visible action without a visible reply, the system must fail loudly.
- Quiet listening is valid only when the model explicitly chooses it. It is not a degraded local substitute for understanding.
- No local semantic keyword rule should pretend to understand what the user meant. Rules may create candidates and enforce boundaries; the model owns meaning and wording.

## Harness Contract

Rules own engineering boundaries:

- State initialization and clamping.
- Multi-user isolation.
- Candidate event creation.
- Attention budgets and source ids.
- Privacy boundaries and high-risk redaction.
- Action enum whitelists and guardrails.
- Memory persistence, deletion, and cross-user safety.
- Feedback bounds and numeric state/policy limits.
- Diagnostics and tests for invariants.

LLM owns semantic work:

- What happened in the user's text/photo/audio.
- Whether Papo should respond, ask, stay quiet, remember, recall, or review.
- Papo's visible reply.
- Papo's visible behavior phrase when needed.
- Candidate memory wording and tags.
- Feedback reflection and learning language.
- Active emergence message and why it is surfacing.
- Vision summaries and audio transcripts.

The boundary is strict: internal thinking, decision traces, scores, ids, and memory-write reasoning can exist in Brain/debug surfaces, but they are not Papo's speech.

## Product Shape

- Dialogue and companionship are one surface.
- Text, photo, uploaded audio, and continuous listening chunks enter the same conversation timeline.
- Continuous listening is internally batched around 30 seconds for up to 3 minutes, but the user should experience it as Papo listening with them.
- Empty audio, silence, noise, and unclear speech are ordinary non-events. They should not create fake life content.
- Photo input records upload time and available browser location so memory can later keep natural provenance.
- Papo replies are short external behavior, not cognitive reports.
- Memory cards default to what the user shared and what Papo remembered. Attention rationale and flow details belong behind an expandable detail or Brain.
- Feedback text/audio/buttons are all interaction input and may trigger learning, memory updates, or new dialogue.

## Provider Policy

- Supported real providers: OpenRouter, Mimo, and generic OpenAI-compatible APIs.
- Provider config comes from environment, `.env`, `papo.config.json`, or `.papo/provider.json`.
- `PAPO_PROVIDER` may explicitly select `openrouter`, `mimo`, or `generic`.
- Model ids are configurable per modality.
- Default semantic models should prefer the strongest available configured model, currently `openai/gpt-5.5` for OpenRouter or `gpt-5.5` for generic.
- Generic/OpenAI-compatible audio sensing should use `/audio/transcriptions`, defaulting to `gpt-4o-mini-transcribe` unless configured.
- Mixed routing is allowed: for example, OpenRouter can be the semantic provider while generic audio handles transcription.
- Provider errors are product errors. They should be visible through API errors and diagnostics instead of being hidden behind local wording.

## Code Map

- `src/core/provider.ts`: real provider selection and OpenAI-compatible calls.
- `src/core/attention.ts`: candidate event scoring and safety primitives.
- `src/core/harness.ts`: semantic cognition loop and visible-output contract.
- `src/core/semantic-action.ts`: model action selection.
- `src/core/semantic-attention.ts`: model attention selection for stream inputs.
- `src/core/semantic-memory.ts`: model memory decisions.
- `src/core/feedback.ts`: feedback application plus model reflection.
- `src/core/emergence.ts`: active resurfacing through model decisions.
- `src/core/narration.ts`: guarded model narration.
- `src/core/model-context.ts`: shared redacted model context.
- `src/core/conversation.ts`: user/world/Papo timeline.
- `src/server/app.ts`: API orchestration.
- `src/web/App.tsx`: mobile-first interaction UI.
- `tests/`: invariant, API, UI, and browser checks.

## Current Implementation Notes

- The provider layer throws when credentials are missing.
- Sensing endpoints call real model providers directly. Image/audio failures return errors; empty real audio transcripts are non-events.
- The semantic harness strips rule-created visible drafts before model action/wording. Papo's final visible reply must come from a model.
- Wake rhythm only updates presence/state. It must not pick memories, write emergence records, or feed wake text back into model conversation context.
- Active emergence has no rule-generated path. `/emergence` must call the model to decide quiet vs resurfacing and to choose a valid memory.
- The old "rules create emergence, model polishes narration" path is removed; polishing a fake decision is still fake cognition.
- Feedback capture records the user's teaching and executes explicit save/forget storage operations only. State, policy, learning language, memory weight changes for soft feedback, and creature self-memory must come from `semanticReflectFeedback`.
- If the model chooses a visible action such as `respond`, `ask`, `recall`, or `review`, a visible reply is required.
- If the model chooses `observe` or `quiet`, the API may persist the user's input without adding a Papo reply.
- Recent conversation, memories, and feedback are passed into model prompts through `model-context.ts`, with high-privacy text redacted.
- Development planning text must not be used as creature interaction material.

## Verification Checklist

- `npm test`
- `npm run build`
- `npm run test:e2e`
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
2. Strengthen real user-scenario tests and delete tests that only prove local templates.
3. Verify OpenRouter vision/audio model routing with real accounts, using cost-effective models first.
4. Improve the Shiba animation only where it helps the interaction, not as decorative proof.

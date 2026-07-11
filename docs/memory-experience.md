# Memory Experience Flow

## Ownership

- `semantic-memory.ts` decides whether an episode becomes a candidate and writes candidate text in Papo's observer voice.
- `memory.ts` owns canonical facts, candidate promotion, weights, source episodes, and original attachments.
- `memory-enrichment.ts` asynchronously enriches active long-term memories. It never changes canonical `text`.
- `memory-visual.ts` retrieves related memories and image references, then plans `shortTitle`, `narrative`, and a visual prompt.
- `client-document.ts` owns the private per-profile Client document, evidence-backed facts, preferred address, and selective context retrieval.
- `store.ts` merges asynchronous results without dropping concurrent conversation, feedback, media, or Client updates.
- `App.tsx` presents memory visuals/title/time, accepts feedback, and shows Client.md only inside the small-eye view.

## State Flow

1. Dialogue or curious/listening input passes attention, action, episode, and semantic memory stages.
2. The memory stage may discard the draft, retain a candidate, or promote an `auto` candidate to a long-term canonical fact.
3. Explicit feedback may promote a candidate/episode or update an existing long-term canonical fact.
4. New or materially changed active memories are marked `visualStatus=pending` and saved before returning to the client.
5. The background worker reloads the latest profile, plans the observer-voice narrative and visual, resolves only relevant real references, and calls the image provider.
6. The worker reloads again and merges presentation fields only. Concurrent changes to canonical facts remain authoritative.
7. The same worker updates Client.md from allowed memory IDs. Unknown dimensions and invalid source IDs are discarded.
8. The UI refreshes the profile and renders `visual`, `shortTitle`, `createdAt`, and `narrative`. Original episode facts and attachments remain available in details.
9. Text feedback about title, content, or image updates the canonical fact through the feedback model and repeats steps 4-8.

## Invariants

- `LongTermMemory.text` is the canonical fact; generated prose belongs in `narrative`.
- Generated media never replaces user attachments or source episodes.
- Client facts require real source IDs and are stored per profile, not in a shared file.
- Preferred names are learned only from explicit evidence; placeholders are rejected.
- Image failure does not fail dialogue or feedback. It records `failed` with an error and remains retryable.
- Button-only importance/reminder feedback does not regenerate an image unless memory content changes.
- A stale background result can update presentation fields only, never overwrite newer canonical feedback.

## Verification

- `tests/memory-enrichment-flow.test.ts` covers candidate promotion, pending/ready enrichment, Client.md, feedback correction, and a second visual revision through real HTTP routes.
- `tests/memory-experience.test.ts` proves generated narrative cannot overwrite the canonical fact.
- Mobile and desktop browser checks cover the profile memory rail, full memory list, small-eye Client.md, generated image loading, overflow, console errors, and network errors.

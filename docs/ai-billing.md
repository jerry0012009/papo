# AI usage, balance, and redemption

Papo meters model calls with a small in-process layer inspired by three established patterns:

- [LiteLLM virtual keys and budgets](https://docs.litellm.ai/docs/proxy/virtual_keys): a user-scoped balance gates expensive calls before provider execution.
- [OpenMeter prepaid credits](https://openmeter.io/docs/billing/credits): usage is an immutable event ledger and credit changes are separate transactions.
- [Langfuse model usage and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking): each generation keeps provider, model, operation, token usage, and cost provenance.

Running those complete services would add Postgres and operational dependencies that do not fit Papo's current single-process JSON deployment. The local implementation preserves their useful accounting boundaries and can later be exported to a dedicated metering service.

## Data model

`data/ai-billing.json` is deliberately separate from user profiles. It contains:

- one account per `userId`, with an integer micro-RMB balance;
- immutable usage events linked to `sourceId`, `turnId`, and `jobId` when available;
- balance transactions for trial credit, reservations, debit, refund, redemption, and adjustment;
- active reservations keyed by a unique provider `callId`;
- SHA-256 hashes of redemption codes. Plain codes are returned only when created.

The file is written with mode `0600`, a temporary-file rename, an in-process queue, and a filesystem lock. This makes API calls and the redemption-code CLI safe to run concurrently on the same host. A reservation older than one hour is refunded during the next billing operation, so a process crash cannot leave money permanently reserved.

Every account receives the current testing grant of RMB 20 exactly once when first initialized. Existing profiles are migrated lazily, without modifying profile JSON.

## Charging behavior

All calls made through the production `ModelProvider` are wrapped and grouped as text, audio, image, or video. OpenRouter/provider-reported `usage.cost` and token counts take precedence. When a provider does not report cost, the versioned catalog in `src/server/ai-pricing.ts` is used. Integer micro-RMB arithmetic avoids floating point balance drift.

Image and video generation reserve an estimated amount atomically before the provider runs. If funds are insufficient, the call is recorded as blocked and the provider is never invoked. Provider failure refunds the reservation. Text, audio, and image understanding remain available and may take the balance below zero; expensive generation stays blocked until the balance is positive enough for its reservation.

Configure exchange rate and emergency model overrides without changing code:

```json
{
  "PAPO_BILLING_USD_CNY": "7.2",
  "PAPO_MODEL_PRICES_JSON": "{\"vendor/model\":{\"inputUsdPerMillion\":0.1,\"outputUsdPerMillion\":0.2,\"perImageUsd\":0.01,\"perVideoSecondUsd\":0.02}}"
}
```

Only applicable fields are needed. Prices are upstream costs shown to the user, not a marked-up retail tariff.

## API and operations

- `GET /api/profiles/:userId/ai-usage?limit=200` returns the authenticated user's balance, four category summaries, and recent events.
- `POST /api/profiles/:userId/ai-usage/redeem` accepts `{ "code": "..." }` and returns the updated account.
- `npm run billing:create-code -- 10 1 2026-12-31T23:59:59Z` creates a RMB 10, single-use, expiring code. Omit the final two arguments for one use without expiry.

Do not log or commit the returned plain code. The persistent file stores only its hash.

## Client migration

Current web and Android bundles use authenticated user-scoped media endpoints:

- `/api/profiles/:userId/image-summary`
- `/api/profiles/:userId/camera-observation`
- `/api/profiles/:userId/audio-observation`

The legacy global forms contain no user identifier and therefore cannot be truthfully assigned to a user account. They now return HTTP 426 with `client_upgrade_required` and never invoke a provider. This preserves an actionable update error without creating unattributed spend; no new client code uses them.

## Verification

```bash
npm test
npm run test:ui
npm run android:doctor
npm run apk:debug
```

Billing-specific deterministic coverage is in `tests/ai-billing.test.ts`, `tests/ai-billing-api.test.ts`, `tests/turn-worker-priority.test.ts`, and `tests/ui/ai-usage.spec.ts`. Tests use fake providers and temporary ledgers; they do not call paid models.

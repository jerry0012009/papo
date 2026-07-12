# Media cost routing

Reviewed on 2026-07-12. Prices are provider list prices and can change.

## Current decision

- Keep `google/gemini-3.1-flash-lite-image` for action-card covers. OpenRouter describes it as Google's fastest, most cost-efficient Nano Banana model. Its provider record lists image output at `$0.00003` per image-output token. CloseAI exposes the same Gemini image families but charges an account-tier multiplier, so moving the same model there is not a cost reduction.
- Use OpenRouter `bytedance/seedance-1-5-pro` as the default video route at 480P, four seconds, and `generate_audio=false`. It supports 1:1, first-frame image-to-video and costs `$0.0115296/second` without audio, about `$0.0461` per action card.
- Keep Happy Horse available only as an explicit rollback model. Happy Horse 1.1 at 720P costs `$0.0988/second`, about 8.6 times the selected Seedance route.
- Do not select models by keyword or silently degrade quality. Action cards require image-to-video and reference-image support so the approved cover remains the first frame.

## Lower-cost candidates

An optional direct-provider candidate is Alibaba Model Studio's `wan2.2-i2v-flash`. Its official China pricing lists 480P at `0.10 CNY/video second` and 720P at `0.20 CNY/video second`. It accepts the existing Base64 approved cover, creates an asynchronous task, and returns a temporary video URL that Papo immediately downloads into durable storage. The model produces a fixed five-second video, so a 480P action card is about `0.50 CNY`.

Papo now includes this route. Configure:

```dotenv
PAPO_VIDEO_PROVIDER=dashscope
DASHSCOPE_API_KEY=...
DASHSCOPE_VIDEO_MODEL=wan2.2-i2v-flash
DASHSCOPE_VIDEO_RESOLUTION=480P
```

When `DASHSCOPE_API_KEY` exists and no video provider is explicitly selected, Papo prefers DashScope. Without that credential it keeps the existing OpenRouter route. A failed cheap render does not automatically launch an expensive render in the same attempt.

The OpenRouter account's `/api/v1/videos/models` catalog must be used for video selection; the general catalog omits dedicated video models. Reviewed square first-frame alternatives:

- Seedance 1.5 Pro, 480P no audio: `$0.0115296/second`.
- Grok Imagine Video, 480P: `$0.05/second` plus `$0.002/image`.
- Seedance 2.0 Fast, 480P: `$0.0538048/second`.
- Kling 3.0 Standard, no audio: `$0.084/second`.
- Happy Horse 1.1, 720P: `$0.0988/second`.
- Veo 3.1 Lite is `$0.03/second` at 720P without audio, but lacks 1:1 output and does not fit the square action-card contract.

`fal-ai/wan/v2.2-a14b/image-to-video` is a secondary candidate. Its public page lists:

- 480p: `$0.04/video second`
- 580p: `$0.06/video second`
- 720p: `$0.08/video second`

For the small in-app action-card surface, a 5-second 480p render is about `$0.20`, compared with about `$0.49` for 5-second Happy Horse 720p. It must pass Papo's reference identity, loop continuity, latency, and failure-rate fixture before production routing changes.

Chinese image candidates are inexpensive (`wan2.2-t2i-flash` and `wanx2.1-imageedit` are each listed at `0.14 CNY/image` in China), but they are not enabled yet. The action-card cover may combine the pet avatar, uploaded user media, and historical-card continuity; a real multi-reference A/B benchmark must prove identity retention before replacing Nano Banana Lite.

Image routing is tiered by product purpose:

- Identity-critical images use Nano Banana 2 Lite: profile/avatar design, action-card approved covers, explicit user illustrations, and proactive diary illustrations. A 1K image is approximately `$0.039` when it uses roughly 1,290 image-output tokens at `$0.00003/token`.
- Memory candidates and long-term memory artwork use FLUX.2 Klein 4B through `OPENROUTER_ECONOMY_IMAGE_MODEL`. A 1-megapixel image is `$0.014`, approximately 64% below the Nano estimate.
- CloseAI exposes the same Gemini image family. The current account is pay-as-you-go and its public base tier is 1.5x official pricing; higher tiers require cumulative deposits. It is not the cheaper route for either tier at the reviewed account state.

## Product budget

- Semantic action and emergence normalize action cards to 4-5 seconds.
- The provider independently enforces `PAPO_VIDEO_DEFAULT_SECONDS` (default `4`) and `PAPO_VIDEO_MAX_SECONDS` (default `5`), so an incorrect model response cannot create an unbounded render.
- Covers continue to use the low-cost image model because image-to-video quality depends on a stable approved first frame.
- Video jobs are single-attempt. A timeout can occur after a provider has already started and billed a render, so automatic retries risk duplicate charges. The failure stays visible and a later retry must be explicit.
- A provider switch requires a deterministic route test plus a small real benchmark set. Unit price alone is insufficient because failed or identity-breaking renders cost more through retries.

## Sources

- OpenRouter Happy Horse pricing and capabilities: https://openrouter.ai/alibaba/happyhorse-1.1
- OpenRouter Seedance 1.5 Pro pricing and capabilities: https://openrouter.ai/bytedance/seedance-1-5-pro
- OpenRouter dedicated video catalog API: https://openrouter.ai/api/v1/videos/models
- OpenRouter Nano Banana 2 Lite pricing and description: https://openrouter.ai/google/gemini-3.1-flash-lite-image
- OpenRouter model catalog API: https://openrouter.ai/api/v1/models
- fal Wan 2.2 image-to-video pricing: https://fal.ai/models/fal-ai/wan/v2.2-a14b/image-to-video
- Alibaba Model Studio model pricing: https://help.aliyun.com/zh/model-studio/model-pricing
- Alibaba Model Studio first-frame image-to-video API: https://help.aliyun.com/zh/model-studio/image-to-video-api-reference
- CloseAI pricing tiers: https://www.closeai-asia.com/pricing

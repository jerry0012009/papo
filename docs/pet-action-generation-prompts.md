# Pet Action Generation Prompts

This file records the asset direction used for generated Papo companions.

## Current Model Choice

- Provider route: OpenRouter `/images`
- Model: `google/gemini-3.1-flash-lite-image`
- Reason: OpenRouter metadata lists it as `text+image -> text+image`; pricing is lower than the Pro image model, and a real request on 2026-07-08 produced usable commercial-demo quality assets.

## Product Asset Contract

- Generate a canonical identity image first.
- Generate action poses from that canonical image as a strict reference.
- Use square 1024px source images and store optimized WebP files under `public/pets/generated/<pet-kind>-v1/`.
- Keep each pose as the same animal, same fur colors, same face markings, same eye color, same overall body proportions.
- Prefer high-quality semi-realistic plush 3D mascot style for the commercial demo.
- Avoid cheap sticker art, pixel art, hard cartoon outlines, distorted faces, extra animals, accessories, text, watermark, and busy backgrounds.

## British Shorthair V1

Canonical prompt:

```text
Use case: stylized-concept
Asset type: mobile companion pet avatar, production app asset
Primary request: Create the canonical look for Jixiang's companion animal: one adorable fluffy British Shorthair kitten mascot for the Papo app.
Subject: the same single young British Shorthair cat, round plush face, short dense blue-gray fur, white chest and muzzle, tiny pink nose, warm amber eyes, small rounded ears, soft paws, slightly chubby body, lovable and premium.
Style: high quality semi-realistic plush 3D illustration, tactile fur, soft natural lighting, sophisticated commercial app mascot, cute but not childish, not flat pixel art, not cheap sticker, not ugly cartoon.
Composition: full body centered, sitting calmly and looking at the viewer, generous padding, square image.
Background: plain warm off-white studio background (#f8f6ef), no props, no text, no watermark, no frame, no UI.
Negative: no extra animals, no human, no distorted face, no scary eyes, no long limbs, no anime exaggeration, no low-resolution pixel art, no harsh outline, no accessories.
```

Action prompt template:

```text
Use the reference kitten as strict identity reference. Create the same British Shorthair kitten in <action pose>.
Keep the same fur colors, amber eyes, pink nose, round face, plush semi-realistic 3D app mascot style.
Full body centered, warm off-white plain background, no text, no watermark, no extra animals.
```

Current action poses:

- `idle`: sitting calmly.
- `poke-wave`: raising one soft paw in a tiny wave after the user gently taps it.
- `play-ball`: nudging a small soft mint-green ball with one paw.
- `nap`: curled into a cozy sleeping loaf.

## Motion Decision

For the homepage demo, Papo uses high-quality key poses plus CSS motion, not generated video.

Reason:

- The pet must respond immediately to taps.
- Images are cheaper, cacheable, and easier to keep visually consistent.
- Short videos are useful later, but only after the key-pose identity is stable enough to feed into image-to-video.

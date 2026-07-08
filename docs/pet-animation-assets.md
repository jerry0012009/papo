# Pet Animation Asset Research

This note records what was actually verified for Papo's animated companion assets.

## Selected For This Build

`xiangking/agent-pet`

- Repository: `https://github.com/xiangking/agent-pet`
- License: MIT.
- Format: Codex-compatible sprite atlases, `1536x1872`, 8 columns x 9 rows, `192x208` cells.
- Built-in animation rows: idle, running-right, running-left, waving, jumping, failed, waiting, running, review.
- Verified built-in pets: 12 atlases in the upstream repo. This build ships 9 of them: `claude`, `codex`, `datawhale`, `dewey`, `fireball`, `mo-xia`, `rocky`, `seedy`, `stacky`.
- Product decision: use these as selectable non-dog companions during registration because the license and sprite protocol are clean enough for demo integration.

## Dog Asset Findings

`tonybaloney/vscode-pets`

- Repository: `https://github.com/tonybaloney/vscode-pets`
- Project license: MIT.
- Stars at research time: about 4.1k.
- Verified media count: 349 gif animations across many pet types.
- Dog media: 35 gif animations across akita, black, brown, red, and white dogs.
- Important license detail: `media/dog/license.txt` says the dog work is Creative Commons Attribution-NoDerivatives 4.0. That is not equivalent to MIT for derivative use. We can reference it and potentially display unmodified with attribution, but should not recolor or reshape it into a custom Shiba without separate permission.

OpenGameArt rounded-eyes dog sprites

- Page: `https://opengameart.org/content/rounded-eyes-dog-sprites-game-character`
- License: CC-BY 4.0.
- Verified archives: run and jump frame sets, about 39 PNG frames total.
- Product decision: useful dog reference or future attributed asset, but not enough for a 100-state commercial companion set by itself.

## Current Product Position

I did not verify a single open-source dog repository with 100 distinct dog states/animations and a permissive commercial-friendly license.

The current implementation therefore separates three layers:

- A verified model-selectable state catalog with at least 100 external behavior states.
- A default SVG Shiba renderer for Papo.
- A real open-source MIT sprite renderer for selectable non-dog companions, based on `agent-pet`.

This is an honest product compromise: it gives the demo real visual variety now without pretending that a 100-animation dog asset pack has been found.

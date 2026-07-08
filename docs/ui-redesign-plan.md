# Papo UI Redesign Plan

This plan is the working contract for the current UI redesign goal. The product content and cognition harness should remain intact; the redesign focuses on layout, visual hierarchy, interaction ergonomics, and responsive behavior.

## Design Target

Papo should feel like a companion app for a small Shiba, not a dashboard, debug console, or generic chat template.

The UI must support two usage modes:

- Mobile: app-like, one-handed, immersive, with Papo as a living presence.
- Desktop: demo-ready, using wider space intentionally instead of stretching the mobile layout.

## Current Problems

1. The app shell is mobile-only and simply scales up on desktop.
2. The home page overuses a single large stage, leaving desktop screens visually empty.
3. The chat page mixes status, controls, message stream, developer traces, and composer in one vertical stack.
4. The memory page is functional but dense, and needs clearer hierarchy between candidate memories, long-term memories, actions, feedback, and traces.
5. Developer tools are visible in the right places, but popovers and details need a consistent overlay system.
6. There is no automated browser-level test that proves mobile/desktop layout, tab navigation, composer visibility, and trace popovers.

## Layout Direction

### App Shell

Mobile:

- Keep bottom tab navigation.
- Keep a compact top bar.
- Keep the active view as a single scrolling column.
- The composer and bottom nav must not cover the latest message.

Desktop:

- Use a wide app frame around 1120-1200px.
- Move primary navigation into a left rail.
- Keep the top bar in the main content area.
- Avoid stretching chat bubbles, memory cards, or Papo stage across the full width.

### Home

Mobile:

- Papo stage is the primary visual.
- Only show external behavior, not counts or internal diagnostics.
- Main actions: talk to Papo, start companion listening.
- Unread proactive messages appear as a small nudge only when present.

Desktop:

- Use a two-column layout:
  - Left: Papo stage.
  - Right: primary actions, unread nudge, and optional emergence card.
- Keep the state/personality detail only in the home eye disclosure.

### Chat

Mobile:

- Standard messenger structure:
  - Papo status header.
  - Message stream.
  - Bottom composer.
- Composer uses icon-style tools where possible and should stay reachable.
- Entering chat should land on the newest message.

Desktop:

- Use two columns:
  - Main: message stream and composer, with a comfortable max reading width.
  - Side: Papo listening/status card and active external-task notice.
- Avoid huge full-width message bubbles.

### Memory

Mobile:

- Keep candidate/long-term segmentation.
- Cards should show one clean memory line first.
- Actions should be compact and not wrap into visual clutter.
- Feedback stays collapsed until requested.

Desktop:

- Use a wider list with a sticky control header.
- Candidate and long-term filters remain obvious.
- Trace details stay behind the eye and do not expand the main reading flow by default.

## Visual System

- Background: warm neutral with subtle green-blue tint, not a strong gradient theme.
- Primary action: deep ink.
- Companion accent: Shiba orange/amber, used sparingly.
- Cards: 8px radius, soft borders, minimal shadow.
- Buttons: stable heights and icon-first where appropriate.
- Text: no viewport-scaled font sizes; headings sized by context.

## Developer Trace Rules

- Home eye: overall state, personality, recent model stages.
- Message eye: only the cognition chain for that message.
- Memory eye: only memory formation, feedback, and trace history for that memory.
- All popovers must fit within mobile and desktop viewports and scroll internally.

## Testing Plan

Add browser-level checks that exercise real UI behavior without calling real LLM endpoints:

- Load home at mobile and desktop widths.
- Navigate to chat and verify latest messages/composer are visible.
- Navigate to memory and verify filters/actions render.
- Open a home eye and a message/memory eye and verify the popover stays within the viewport.
- Click feedback buttons and verify a pending label appears.

Preferred implementation:

- Use Playwright with mocked API responses for deterministic UI screenshots and interactions.
- Keep real provider smoke tests separate from UI layout tests.

## Commit Plan

1. `Document UI redesign plan`
2. `Redesign app shell and responsive layout`
3. `Refine chat and composer ergonomics`
4. `Refine memory page hierarchy`
5. `Add UI interaction tests`
6. `Deploy Papo UI redesign`

## 2026-07-08 Implementation Status

- Adopted a Radix Dialog/Tooltip base for developer disclosures instead of hand-rolled popovers.
- Reworked the app shell into a product layout: desktop left navigation, center work area, and right companion rail; mobile keeps compact top bar and bottom navigation.
- Chat now uses a bounded messenger surface with the composer aligned to the message column and latest-content positioning covered by Playwright tests.
- Developer cognition traces moved into sheet-style overlays so internal process is inspectable without polluting the creature-facing UI.
- Memory remains functionally the same but uses a cleaner list hierarchy with candidate/long-term filters, collapsed source/feedback/trace details, and stable pending button labels.
- Added mobile/desktop UI interaction coverage for home eye open/close, chat latest/composer alignment, and memory feedback pending state.

Remaining product polish:

1. Replace the legacy memory card internals with a dedicated memory detail drawer once backend pagination lands.
2. Add screenshot-diff review for demo pages, not just structural Playwright assertions.
3. Continue trimming old CSS after this stage is stable; the current release intentionally uses final override layers to reduce regression risk.

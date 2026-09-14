# Mobile layout recheck — 2026-09-14

## Verification

- Chromium, isolated profile, touch/mobile emulation against the local Vite frontend and existing backend.
- Viewports: 320×568, 375×667, 390×844, 430×932, 768×1024, 844×390, 960×800, 1440×900 (desktop control).
- 135 layout/interaction states passed: welcome composer, model menu and dismissal, workspace, simultaneous workspace/sidebar, scrim dismissal, all eight settings categories, notebook, skills, learner profile, jobs, existing conversation, synthetic visual viewport resize.
- Existing long conversation additionally checked at 320×568, 390×844 and 844×390: message scroll area, input, model menu and input visibility with a synthetic 240px visual viewport. No messages sent or settings saved.
- Frontend Vitest: 39 files / 309 tests passed.
- `npm --workspace inno-agent-web run build`: passed, including TypeScript.

## Fixes

| Before | After | Why |
| --- | --- | --- |
| Mobile CSS targeted a retired toolbar class; actual sidebar toggle retained a 96px macOS inset and overlapped feature titles. | Browser/mobile toolbar uses a left-edge 44px touch target with matching header spacing. Desktop chrome remains unchanged. | Keep navigation and titles separately readable/clickable. |
| Opening the sidebar while the full workspace was visible shifted and squeezed the workspace. | Full workspace stays edge-to-edge behind the drawer. | Drawer should overlay rather than resize content. |
| Workspace size toggle remained visible because component display CSS overrode Tailwind's hidden utility. | Explicit narrow-screen display rule hides the size toggle. | Mobile has only a full-width workspace. |
| Small settings cards squeezed description text and theme labels into narrow columns. | Setting controls wrap below labels as space requires; theme labels do not shrink or wrap internally. | Preserve legibility at 320px. |
| Settings close button visually merged into the scrolling tab strip; modal height ignored the app's visual viewport variable. | Solid 44px mobile close button, safe-area padding and visual-viewport-aware height. | Keep dismissal discoverable and content reachable when the viewport shrinks. |
| Active conversation composer controls painted over each other. | Two toolbar rows at widths up to 640px, scoped to conversations only. | Preserve attachment, permission, workspace, newline, model and send controls without overlap. |
| Landscape drawer navigation consumed almost the entire height, making session cards difficult to tap. | Two-column navigation at narrow widths with height up to 500px. | Leave a usable session-list area. |

## Repeatable browser smoke test

`scripts/mobile-layout-smoke.cjs` uses an externally supplied Playwright installation; no production dependencies added.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROMIUM_PATH=/absolute/path/to/chromium \
MOBILE_TEST_URL=http://localhost:5173 \
MOBILE_TEST_OUTPUT=/tmp/inno-mobile-smoke \
MOBILE_TEST_SESSION_TITLE='an existing conversation title' \
node scripts/mobile-layout-smoke.cjs
```

The session title is optional (128 states without it; 135 with it). The script asserts document width, menu bounds, mobile toolbar geometry, drawer/workspace placement, settings bounds, title separation and conversation button overlap. Screenshots and JSON results are written outside the repository by default. Conversation screenshots may contain local user content; do not commit or publish them without review.

## Limits

- Chromium emulation is not a physical iPhone/Android test, nor a Safari/WebKit compatibility test.
- Synthetic `visualViewport` changes validate resize handling only, not real keyboard panning, browser address-bar behavior, pinch zoom or notch safe-area rendering.
- The test checks layout/interactions, not model inference, uploads, task execution, saving settings or every document format.
- Some remote preset data can still be loading at screenshot time; passing layout assertions does not validate that remote service.

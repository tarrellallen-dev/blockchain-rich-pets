# Integration map

This template is designed to be adapted to another Electron app, including a personal Jarvis-style
assistant. The animation and desktop-window layers can remain intact while the host adapter changes.

## 1. Window host

Use `reference/electron/companion.ts`. Keep `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, and the single whitelisted preload bridge. During a drag, monitor selection must
follow the real cursor. Do not replace this with renderer mouse deltas.

## 2. Renderer

Mount `reference/src/components/Companion.tsx` in the transparent window and load
`reference/src/companion.css`. Copy `assets/companion` into the consuming app's asset tree and
update imports in `companion-skins.ts` if needed.

## 3. Host adapter

Implement only the IPC calls referenced by `Companion.tsx`: preferences, status summary, quick
capture, open page, open dashboard, native menu, voice typing, hit-test mode, begin drag, and end
drag. Validate all payloads in the main process and fail closed for unknown channels.

## 4. Motion

Keep `companion-motion.ts`, `companion-idle.ts`, and `companion-animation.ts` together. Raster
gestures use authored frames with anticipation, action, and recovery. Dragging temporarily owns the
pose, then returns through landing to idle.

## 5. Verification

Build the pure modules and run `reference/tests/companion.test.mjs`. Add an Electron smoke test
that checks click-through, both screen edges, a second monitor, negative coordinates, scale changes,
lost pointer-up recovery, and reduced motion.

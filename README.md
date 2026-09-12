# Blockchain Rich Pets

A reusable desktop-companion template for Electron applications. Use it to add animated characters,
quick commands, alerts, and system status to a personal Jarvis, agent dashboard, trading workstation,
productivity app, or another desktop experience.

The included Blockchain Rich Pets are a working example. The host adapter is deliberately separated
so developers can keep these characters, replace them with their own, or connect the companion to a
different application's workflow engine.

## Download

- **[Download the complete template ZIP](downloads/blockchain-rich-pets-template.zip)**
- Developers can also clone this repository and start with `docs/INTEGRATION.md`.

## What is included

- Six skins: Kavalier, Nexus, Aegis, Ak (Ack), Rell, and Pat
- Transparent always-on-top Electron window
- Cursor-anchored movement across adjacent and negative-coordinate displays
- Click-through hit testing, saved placement, and screen-edge recovery
- Authored idle, blink, watch, scratch, wave, rest, urgent, fall, and landing behavior
- Typed commands, Windows voice typing trigger, alerts, shortcuts, and status tray
- Exact animation assets and the companion test suite
- Picture-led quick-start PDF

## Important boundary

This archive is a source extraction from a working application and a template for integration, not a
standalone installer yet. The reference renderer calls The Boy Prodigy's single IPC bridge for status,
commands, preferences, and window movement. Replace that small host adapter with calls to your own
application. Start with `docs/INTEGRATION.md`.

## License

Released under the MIT License. You may use, modify, and redistribute the template in your own app.
Keep the copyright and license notice with substantial copies of the source.

## Screenshot checklist

- Capture each final skin on a transparent desktop
- Capture watch, wave, rest, urgent, falling, and landing poses
- Capture the quick-command tray and one alert
- Capture movement at the left and right edge of every monitor
- Do not include personal project names, messages, tokens, or email addresses

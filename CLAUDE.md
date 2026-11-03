# pinotify

Notification service of the Pi ecosystem. Fastify + TypeScript (ESM, Node >= 22, pnpm), port 3109, EUPL-1.2. Sends email and SMS through `@jsilvanus/notify-core` (own repo, npm); calls come later. See README.md for what it does.

- `src/hub.ts`: `NotifyHub` wires notify-core: store (encrypted JSON file, or memory in simulation without a key), fixed contacts (superuser from env), provider to adapters, simulated outbox. `src/app.ts`: routes and auth (admin and send tokens). `src/config.ts`: env and startup checks. `src/cli.ts`: CLI over HTTP only. `src/notify-core.d.ts`: hand-written types because notify-core ships none (replace when it does).
- Tests: `pnpm test` (node:test via tsx, `app.inject`, fake fetch for Brevo, no network). Typecheck: `pnpm exec tsc --noEmit`. Keep `openapi/openapi.json`, README and `.env.example` in step with the routes and env variables.
- Never log or return addresses, message text, tokens, keys or provider secrets. Never commit `.env`, `data/`, `*.enc`, real contacts or keys. No real sends in tests.
- `pnpm-workspace.yaml` has `minimumReleaseAgeExclude` for `@jsilvanus/notify-core` (our own package, newer than the age gate); drop the pin once it is old enough.
- Moving LCYT to notify-core is future work, not part of this repo.

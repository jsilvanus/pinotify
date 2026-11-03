# pinotify

Notification service for the Raspberry Pi production ecosystem (`piecosystem`): email and SMS now, phone calls later. Other pi* services (for example `pirundown`) ask pinotify to tell a person something; pinotify decides nothing about *when*. It is a thin service on top of [`@jsilvanus/notify-core`](https://github.com/jsilvanus/notify-core), which does the consent checks, cooldown, rate limits and the provider adapters (Brevo email and SMS, SMTP email).

Node 22+ (Node 24 on the Pi), ESM, TypeScript, Fastify, pnpm, EUPL-1.2. Port `3109`.

**Status: skeleton.** Simulation mode is tested; production mode has never run against a real provider, the Pi, or real contacts. The Brevo SMS request format is still unverified against Brevo's reference.

## What it does

- `POST /api/v1/notify` sends a message to a contact (by slug) on `email` or `sms`. Consent per channel, an active flag, a per-contact cooldown and hourly/daily caps are checked before any provider call.
- Contacts and the provider setting are managed over the API (admin token). Provider secrets are write-only: they are never returned, and leaving them out of an update keeps the stored value.
- The **superuser** contact comes only from the environment (`PINOTIFY_SUPERUSER_*`) and cannot be edited or replaced over the API. Everyone else is configured through the API/UI.
- **Data at rest:** contacts, the provider setting and the attempt log are one JSON file (`PINOTIFY_DATA_DIR/notify.enc`) encrypted as a whole with AES-256-GCM, key from `PINOTIFY_SECRET_KEY`. The file is private (0600) and replaced atomically. A wrong key is an error; the file is never overwritten silently. Keep a copy of the key outside the Pi.
- The attempt log keeps contact slugs, channel, outcome and trigger only. No addresses, no message text. Entries are purged after `PINOTIFY_LOG_DAYS` (90).
- **Simulation mode** (default): no real sends. Messages are kept in memory and listed at `GET /api/v1/outbox`. **Production mode** refuses to start without `PINOTIFY_ADMIN_TOKEN` and `PINOTIFY_SECRET_KEY`.

## Tokens

- `PINOTIFY_ADMIN_TOKEN`: everything (contacts, provider, log, send).
- `PINOTIFY_SEND_TOKEN`: only `POST /api/v1/notify`. Give this one to other services.

Both are Bearer tokens on every `/api` request. Without tokens only simulation mode is open.

## Run

```
pnpm install
cp .env.example .env     # edit; never commit it
pnpm run build && pnpm start        # or: pnpm dev
pnpm test
pnpm cli -- help                    # or: node bin/pinotify.mjs help
```

```
pinotify add warden --email warden@example.org --consent-email --name Warden
pinotify send email warden "Candles are still on in the church"
pinotify contacts
pinotify log 10
```

The HTTP contract is `openapi/openapi.json` (also served at `/openapi.json`).

## Contacts are personal data

Keep them out of git, memory files and chat. Consent is stored per channel on each contact; a contact without consent for a channel cannot receive on it. Setting `PINOTIFY_SUPERUSER_EMAIL` or `_SMS` counts as that person's consent for that channel.

## Not built yet

- Phone calls (Siptel or Telnyx EU adapter in `notify-core`).
- A UI for contacts and provider (the API is ready for one in `picontrol`).
- Users and groups: for now anyone with the admin token can manage all contacts. Users and groups are planned in the Pi ecosystem.
- Deployment unit for the Pi (user systemd service, like the other apps) and registration in `piecosystem`.
- Callers: a rule in `pirundown` that reads the candle world state (from `piperception` through `pigateway`) and calls pinotify.
- **Future work, deliberately not started:** moving LCYT's `lcyt-notify` plugin onto `@jsilvanus/notify-core`. It comes only after pinotify works on the Pi and Juha says go.

import {
  NotifyConfigError,
  buildNotifyAdapters,
  createJsonFileStore,
  createMemoryStore,
  createNotifyService,
  createSecretBox,
  validateContact,
  validateProvider,
  withFixedContacts,
  type Adapters,
  type Channel,
  type Contact,
  type SendResult,
  type Store
} from "@jsilvanus/notify-core";
import { join } from "node:path";
import type { AppConfig } from "./config.js";

export class HubError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export interface OutboxMessage {
  at: number;
  channel: Channel;
  to: string;
  subject?: string | undefined;
  text: string;
}

export interface ProviderStatus {
  configured: boolean;
  provider?: string;
  config?: Record<string, unknown>;
  /** Which secrets are set. The values are never returned. */
  secretsSet?: Record<string, boolean>;
  channels: Channel[];
  simulated: boolean;
}

export interface HubOptions {
  store?: Store;
  fetchImpl?: typeof fetch;
  transportFactory?: (opts: object) => { sendMail: (mail: object) => Promise<{ messageId?: string }> };
  now?: () => number;
}

/** The superuser contact comes from the environment only. Setting an address counts as consent. */
export function superuserContact(config: AppConfig): Contact[] {
  const { name, email, sms } = config.superuser;
  if (!email && !sms) return [];
  return [
    validateContact({
      slug: "superuser",
      name: name ?? "Superuser",
      email: email ?? null,
      smsNumber: sms ?? null,
      consentEmail: Boolean(email),
      consentSms: Boolean(sms),
      active: true
    })
  ];
}

export function buildStore(config: AppConfig, now?: () => number): Store {
  if (!config.secretKey) {
    if (config.mode === "production") throw new Error("PINOTIFY_SECRET_KEY is required in production");
    return createMemoryStore(now ? { now } : {});
  }
  const secretBox = createSecretBox(config.secretKey);
  return createJsonFileStore({ path: join(config.dataDir, "notify.enc"), secretBox, ...(now ? { now } : {}) });
}

export class NotifyHub {
  readonly store: Store;
  readonly contacts: Store["contacts"];
  private service: ReturnType<typeof createNotifyService> | null = null;
  private adapters: Adapters = {};
  private simulated = false;
  private readonly outbox: OutboxMessage[] = [];
  private readonly now: () => number;

  constructor(private readonly config: AppConfig, private readonly opts: HubOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? buildStore(config, opts.now);
    this.contacts = withFixedContacts(this.store.contacts, superuserContact(config));
  }

  /** (Re)build the adapters from the stored provider. Call after the provider changes. */
  async reload(): Promise<void> {
    const rec = await this.store.provider.get();
    if (rec) {
      this.adapters = buildNotifyAdapters(rec.provider, rec.config, rec.secrets, {
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(this.opts.transportFactory ? { transportFactory: this.opts.transportFactory } : {})
      });
      this.simulated = false;
    } else if (this.config.mode === "simulation") {
      this.adapters = { email: this.simAdapter("email"), sms: this.simAdapter("sms") };
      this.simulated = true;
    } else {
      this.adapters = {};
      this.simulated = false;
    }
    this.service = createNotifyService({
      adapters: this.adapters,
      limits: this.config.limits,
      cooldownMs: this.config.cooldownMs,
      now: this.now,
      onLog: (entry) => {
        // Only slugs and outcomes are logged, never addresses or message text.
        void this.store.log.append(entry).catch(() => {});
      }
    });
  }

  private simAdapter(channel: Channel) {
    return {
      channel,
      provider: "simulation",
      send: async (msg: { to: string; subject?: string; text: string }) => {
        this.outbox.push({ at: this.now(), channel, to: msg.to, subject: msg.subject, text: msg.text });
        if (this.outbox.length > 200) this.outbox.shift();
        return { id: `sim-${this.outbox.length}` };
      }
    };
  }

  getOutbox(): OutboxMessage[] {
    return [...this.outbox].reverse();
  }

  async send(req: { channel: Channel; contact: string; text: string; subject?: string; trigger?: string }): Promise<SendResult> {
    if (!this.service) await this.reload();
    const contact = await this.contacts.get(req.contact);
    if (!contact) throw new HubError(404, `Unknown contact "${req.contact}"`);
    return this.service!.send({
      channel: req.channel,
      contact,
      text: req.text,
      ...(req.subject ? { subject: req.subject } : {}),
      trigger: req.trigger ?? "manual"
    });
  }

  async saveContact(input: unknown): Promise<Contact> {
    try {
      return await this.contacts.save(validateContact(input));
    } catch (err) {
      if (err instanceof NotifyConfigError) throw new HubError(400, err.message);
      if (err instanceof Error && /set by the environment/.test(err.message)) throw new HubError(409, err.message);
      throw err;
    }
  }

  async deleteContact(slug: string): Promise<void> {
    try {
      if (!(await this.contacts.delete(slug))) throw new HubError(404, `Unknown contact "${slug}"`);
    } catch (err) {
      if (err instanceof Error && /set by the environment/.test(err.message)) throw new HubError(409, err.message);
      throw err;
    }
  }

  /** Save the provider. Secrets left out keep their stored value (they are write-only). */
  async saveProvider(input: unknown): Promise<ProviderStatus> {
    let checked;
    try {
      checked = validateProvider(input);
      const existing = await this.store.provider.get();
      const secrets = { ...(existing && existing.provider === checked.provider ? existing.secrets : {}), ...checked.secrets };
      // Building the adapters validates the whole setting (for example a Brevo key is required).
      buildNotifyAdapters(checked.provider, checked.config, secrets, {
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(this.opts.transportFactory ? { transportFactory: this.opts.transportFactory } : {})
      });
      await this.store.provider.save({ provider: checked.provider, config: checked.config, secrets });
    } catch (err) {
      if (err instanceof NotifyConfigError || (err instanceof Error && /^(brevo|smtp):/.test(err.message))) {
        throw new HubError(400, err.message);
      }
      throw err;
    }
    await this.reload();
    return this.providerStatus();
  }

  async deleteProvider(): Promise<ProviderStatus> {
    await this.store.provider.delete();
    await this.reload();
    return this.providerStatus();
  }

  async providerStatus(): Promise<ProviderStatus> {
    if (!this.service) await this.reload();
    const rec = await this.store.provider.get();
    const channels = (Object.keys(this.adapters) as Channel[]).filter((c) => this.adapters[c]);
    if (!rec) return { configured: false, channels, simulated: this.simulated };
    return {
      configured: true,
      provider: rec.provider,
      config: rec.config,
      secretsSet: Object.fromEntries(Object.entries(rec.secrets).map(([k, v]) => [k, Boolean(v)])),
      channels,
      simulated: false
    };
  }

  async log(limit: number) {
    return this.store.log.list(limit);
  }

  async purgeLog(): Promise<number> {
    return this.store.log.purge(this.config.logDays);
  }
}

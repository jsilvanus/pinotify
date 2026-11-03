// Hand-written types for @jsilvanus/notify-core (plain JavaScript, no bundled types yet).
declare module "@jsilvanus/notify-core" {
  export type Channel = "email" | "sms";

  export interface Contact {
    slug: string;
    name: string | null;
    email: string | null;
    smsNumber: string | null;
    consentEmail: boolean;
    consentSms: boolean;
    active: boolean;
    fixed?: boolean;
    createdAt?: number;
    updatedAt?: number;
  }

  export interface ProviderInput {
    provider: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
  }
  export interface ProviderRecord {
    provider: string;
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    updatedAt?: number;
  }

  export interface Adapter {
    channel?: Channel;
    provider?: string;
    send(msg: { to: string; subject?: string; text: string }): Promise<{ id?: string } | undefined>;
  }
  export type Adapters = { email?: Adapter; sms?: Adapter };

  export interface SendResult {
    status: string;
    providerId?: string | undefined;
    error?: string | undefined;
  }
  export interface LogEntry {
    at?: number;
    channel: Channel;
    contactSlug: string;
    trigger: string;
    status: string;
    providerId?: string | undefined;
    error?: string | undefined;
  }

  export function createNotifyService(opts: {
    adapters: Adapters;
    limits?: { perHour?: number; perDay?: number };
    cooldownMs?: number;
    now?: () => number;
    onLog?: (entry: LogEntry) => void;
  }): {
    send(req: { channel: Channel; contact: Contact; text: string; subject?: string; trigger: string }): Promise<SendResult>;
  };

  export class NotifyConfigError extends Error {}
  export const PROVIDERS: string[];
  export function validateContact(input: unknown): Contact;
  export function validateProvider(input: unknown): { provider: string; config: Record<string, unknown>; secrets: Record<string, string> };
  export function buildNotifyAdapters(
    provider: string,
    config: Record<string, unknown>,
    secrets: Record<string, string>,
    opts?: { fetchImpl?: typeof fetch; transportFactory?: (opts: object) => { sendMail: (mail: object) => Promise<{ messageId?: string }> } }
  ): Adapters;

  export function createSecretBox(key: string | Buffer): {
    encrypt(plaintext: string, aad?: string): string;
    decrypt(envelope: string, aad?: string): string;
  };
  export class SecretBoxError extends Error {}

  export interface Store {
    contacts: {
      list(): Promise<Contact[]>;
      get(slug: string): Promise<Contact | null>;
      save(contact: Contact): Promise<Contact>;
      delete(slug: string): Promise<boolean>;
    };
    provider: {
      get(): Promise<ProviderRecord | null>;
      save(rec: ProviderInput & { secrets?: Record<string, string> }): Promise<ProviderRecord>;
      delete(): Promise<boolean>;
    };
    log: {
      append(entry: object): Promise<void>;
      list(limit?: number): Promise<Array<LogEntry & { at: number }>>;
      purge(days?: number): Promise<number>;
    };
  }
  export function createMemoryStore(opts?: { now?: () => number }): Store;
  export function createJsonFileStore(opts: {
    path: string;
    secretBox: { encrypt(p: string, aad?: string): string; decrypt(e: string, aad?: string): string };
    now?: () => number;
  }): Store;
  export function withFixedContacts(contacts: Store["contacts"], fixed: Contact[]): Store["contacts"];
}

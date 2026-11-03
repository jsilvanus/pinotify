import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { SecretBoxError } from "@jsilvanus/notify-core";
import type { AppConfig } from "./config.js";
import { HubError, NotifyHub, type HubOptions } from "./hub.js";

type Role = "admin" | "send";

function sameToken(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Which role the request's bearer token grants. With no tokens configured (simulation only) everyone is admin. */
function roleOf(config: AppConfig, header: string | undefined): Role | null {
  if (!config.adminToken && !config.sendToken) return config.mode === "simulation" ? "admin" : null;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (sameToken(token, config.adminToken)) return "admin";
  if (sameToken(token, config.sendToken)) return "send";
  return null;
}

const CHANNELS = new Set(["email", "sms"]);

export function buildApp(config: AppConfig, opts: HubOptions = {}): { app: FastifyInstance; hub: NotifyHub } {
  const app = Fastify({ logger: { level: process.env["NODE_ENV"] === "test" ? "silent" : "info" } });
  const hub = new NotifyHub(config, opts);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HubError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof SecretBoxError) {
      return reply.status(500).send({ error: "Stored data cannot be decrypted (wrong PINOTIFY_SECRET_KEY?)" });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: status >= 500 ? "Internal error" : (err as Error).message });
  });

  // Routes under /api need a token. /api/v1/notify takes the send token; everything else needs the admin token.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;
    const role = roleOf(config, req.headers.authorization);
    if (!role) return reply.status(401).send({ error: "Unauthorized" });
    const sendRoute = req.method === "POST" && req.url.split("?")[0] === "/api/v1/notify";
    if (!sendRoute && role !== "admin") return reply.status(403).send({ error: "Admin token required" });
  });

  app.get("/health", async () => ({ ok: true, mode: config.mode }));
  app.get("/openapi.json", async (_req, reply) => {
    const file = new URL("../openapi/openapi.json", import.meta.url);
    return reply.type("application/json").send(readFileSync(file, "utf8"));
  });

  app.post<{ Body: { channel?: unknown; contact?: unknown; text?: unknown; subject?: unknown; trigger?: unknown } }>(
    "/api/v1/notify",
    async (req, reply) => {
      const b = req.body ?? {};
      if (typeof b.channel !== "string" || !CHANNELS.has(b.channel)) throw new HubError(400, 'channel must be "email" or "sms"');
      if (typeof b.contact !== "string" || !b.contact) throw new HubError(400, "contact (slug) is required");
      if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 1000) throw new HubError(400, "text is required (max 1000 characters)");
      if (b.subject !== undefined && (typeof b.subject !== "string" || b.subject.length > 200)) throw new HubError(400, "subject must be a string (max 200)");
      if (b.trigger !== undefined && (typeof b.trigger !== "string" || b.trigger.length > 40)) throw new HubError(400, "trigger must be a short string");
      const result = await hub.send({
        channel: b.channel as "email" | "sms",
        contact: b.contact,
        text: b.text.trim(),
        ...(b.subject ? { subject: b.subject as string } : {}),
        ...(b.trigger ? { trigger: b.trigger as string } : {})
      });
      const status = result.status === "failed" ? 502 : result.status === "rate_limited" || result.status === "cooldown" ? 429 : 200;
      return reply.status(status).send(result);
    }
  );

  app.get("/api/v1/contacts", async () => hub.contacts.list());
  app.get<{ Params: { slug: string } }>("/api/v1/contacts/:slug", async (req) => {
    const c = await hub.contacts.get(req.params.slug);
    if (!c) throw new HubError(404, `Unknown contact "${req.params.slug}"`);
    return c;
  });
  app.post<{ Body: unknown }>("/api/v1/contacts", async (req, reply) => reply.status(201).send(await hub.saveContact(req.body)));
  app.put<{ Params: { slug: string }; Body: Record<string, unknown> | undefined }>("/api/v1/contacts/:slug", async (req) =>
    hub.saveContact({ ...(req.body ?? {}), slug: req.params.slug })
  );
  app.delete<{ Params: { slug: string } }>("/api/v1/contacts/:slug", async (req, reply) => {
    await hub.deleteContact(req.params.slug);
    return reply.status(204).send();
  });

  app.get("/api/v1/provider", async () => hub.providerStatus());
  app.put<{ Body: unknown }>("/api/v1/provider", async (req) => hub.saveProvider(req.body));
  app.delete("/api/v1/provider", async () => hub.deleteProvider());

  app.get<{ Querystring: { limit?: string } }>("/api/v1/log", async (req) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit ?? "100", 10) || 100));
    return hub.log(limit);
  });
  app.get("/api/v1/outbox", async (_req, reply) => {
    if (config.mode !== "simulation") return reply.status(404).send({ error: "Only available in simulation mode" });
    return hub.getOutbox();
  });

  const purge = setInterval(() => void hub.purgeLog().catch(() => {}), 6 * 3_600_000);
  purge.unref();
  app.addHook("onClose", async () => clearInterval(purge));

  return { app, hub };
}

process.env["NODE_ENV"] = "test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { configProblems, loadConfig } from "../src/config.js";

const ADMIN = { authorization: "Bearer admin-token" };
const SEND = { authorization: "Bearer send-token" };

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    PINOTIFY_ADMIN_TOKEN: "admin-token",
    PINOTIFY_SEND_TOKEN: "send-token",
    PINOTIFY_COOLDOWN_MS: "0",
    ...extra
  });
}

const warden = {
  slug: "warden",
  name: "Warden",
  email: "warden@example.test",
  smsNumber: "+358 40 123 4567",
  consentEmail: true,
  consentSms: true
};

test("config: production needs tokens and a key; tokens must differ", () => {
  assert.deepEqual(configProblems(loadConfig({})), []);
  assert.equal(configProblems(loadConfig({ PINOTIFY_MODE: "production" })).length, 2);
  assert.equal(configProblems(loadConfig({ PINOTIFY_ADMIN_TOKEN: "x", PINOTIFY_SEND_TOKEN: "x" })).length, 1);
});

test("auth: no token is 401, the send token cannot manage, wrong token is 401", async () => {
  const { app } = buildApp(config());
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject("/api/v1/contacts")).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/v1/contacts", headers: { authorization: "Bearer nope" } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/v1/contacts", headers: SEND })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/v1/contacts", headers: ADMIN })).statusCode, 200);
  await app.close();
});

test("simulation mode without tokens is open and production without tokens is closed", async () => {
  const open = buildApp(loadConfig({}));
  assert.equal((await open.app.inject("/api/v1/contacts")).statusCode, 200);
  await open.app.close();
  const closed = buildApp(loadConfig({ PINOTIFY_MODE: "production", PINOTIFY_SECRET_KEY: randomBytes(32).toString("hex") }));
  assert.equal((await closed.app.inject("/api/v1/contacts")).statusCode, 401);
  await closed.app.close();
});

test("send: needs consent, then lands in the simulated outbox and the log (no addresses logged)", async () => {
  const { app } = buildApp(config());
  const noConsent = { ...warden, consentSms: false };
  await app.inject({ method: "POST", url: "/api/v1/contacts", headers: ADMIN, payload: noConsent });
  const body = { channel: "sms", contact: "warden", text: "Candles are on", trigger: "test" };
  let res = await app.inject({ method: "POST", url: "/api/v1/notify", headers: SEND, payload: body });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "skipped_no_consent");

  await app.inject({ method: "PUT", url: "/api/v1/contacts/warden", headers: ADMIN, payload: warden });
  res = await app.inject({ method: "POST", url: "/api/v1/notify", headers: SEND, payload: body });
  assert.equal(res.json().status, "sent");

  const outbox = (await app.inject({ url: "/api/v1/outbox", headers: ADMIN })).json();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, "+358401234567");
  assert.equal(outbox[0].text, "Candles are on");

  await new Promise((r) => setTimeout(r, 10));
  const logText = (await app.inject({ url: "/api/v1/log", headers: ADMIN })).body;
  assert.match(logText, /skipped_no_consent/);
  assert.match(logText, /"status":"sent"/);
  assert.ok(!logText.includes("401234567") && !logText.includes("warden@example.test") && !logText.includes("Candles are on"));
  await app.close();
});

test("send: validation, unknown contact, rate limit answers 429", async () => {
  const { app } = buildApp(config({ PINOTIFY_LIMIT_PER_HOUR: "2" }));
  await app.inject({ method: "POST", url: "/api/v1/contacts", headers: ADMIN, payload: warden });
  const post = (payload: object) => app.inject({ method: "POST", url: "/api/v1/notify", headers: SEND, payload });
  assert.equal((await post({ channel: "fax", contact: "warden", text: "x" })).statusCode, 400);
  assert.equal((await post({ channel: "sms", contact: "warden", text: " " })).statusCode, 400);
  assert.equal((await post({ channel: "sms", contact: "nobody", text: "x" })).statusCode, 404);
  assert.equal((await post({ channel: "sms", contact: "warden", text: "one" })).statusCode, 200);
  assert.equal((await post({ channel: "sms", contact: "warden", text: "two" })).statusCode, 200);
  const third = await post({ channel: "sms", contact: "warden", text: "three" });
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().status, "rate_limited");
  await app.close();
});

test("superuser comes from the environment and cannot be changed or replaced", async () => {
  const { app } = buildApp(config({ PINOTIFY_SUPERUSER_EMAIL: "root@example.test", PINOTIFY_SUPERUSER_SMS: "+358501112222" }));
  const list = (await app.inject({ url: "/api/v1/contacts", headers: ADMIN })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].slug, "superuser");
  assert.equal(list[0].fixed, true);
  const put = await app.inject({ method: "PUT", url: "/api/v1/contacts/superuser", headers: ADMIN, payload: { email: "evil@example.test" } });
  assert.equal(put.statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/contacts/superuser", headers: ADMIN })).statusCode, 409);
  const sent = await app.inject({ method: "POST", url: "/api/v1/notify", headers: SEND, payload: { channel: "email", contact: "superuser", text: "hi" } });
  assert.equal(sent.json().status, "sent");
  await app.close();
});

test("contacts: validation errors are 400, delete works", async () => {
  const { app } = buildApp(config());
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/contacts", headers: ADMIN, payload: { slug: "Bad Slug" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/contacts", headers: ADMIN, payload: { slug: "admin" } })).statusCode, 400);
  await app.inject({ method: "POST", url: "/api/v1/contacts", headers: ADMIN, payload: warden });
  assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/contacts/warden", headers: ADMIN })).statusCode, 204);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/contacts/warden", headers: ADMIN })).statusCode, 404);
  await app.close();
});

test("provider: secrets are write-only, kept when omitted, and used for sending (Brevo via fake fetch)", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ messageId: "<m1>" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const { app } = buildApp(config(), { fetchImpl });
  await app.inject({ method: "POST", url: "/api/v1/contacts", headers: ADMIN, payload: warden });

  const bad = await app.inject({ method: "PUT", url: "/api/v1/provider", headers: ADMIN, payload: { provider: "brevo", config: { senderEmail: "no@example.test" } } });
  assert.equal(bad.statusCode, 400);

  const set = await app.inject({
    method: "PUT", url: "/api/v1/provider", headers: ADMIN,
    payload: { provider: "brevo", config: { senderEmail: "church@example.test", smsSender: "Church" }, secrets: { apiKey: "brevo-secret-key" } }
  });
  assert.equal(set.statusCode, 200);
  assert.ok(!set.body.includes("brevo-secret-key"));
  assert.deepEqual(set.json().secretsSet, { apiKey: true });
  assert.deepEqual(set.json().channels.sort(), ["email", "sms"]);

  // Change a non-secret setting without sending the secret again: the stored key is kept.
  const again = await app.inject({
    method: "PUT", url: "/api/v1/provider", headers: ADMIN,
    payload: { provider: "brevo", config: { senderEmail: "church@example.test", senderName: "Church", smsSender: "Church" } }
  });
  assert.equal(again.statusCode, 200);
  assert.ok(!(await app.inject({ url: "/api/v1/provider", headers: ADMIN })).body.includes("brevo-secret-key"));

  const sent = await app.inject({ method: "POST", url: "/api/v1/notify", headers: SEND, payload: { channel: "email", contact: "warden", text: "hello" } });
  assert.equal(sent.json().status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers["api-key"], "brevo-secret-key");
  assert.equal((await app.inject({ url: "/api/v1/outbox", headers: ADMIN })).json().length, 0);

  const removed = await app.inject({ method: "DELETE", url: "/api/v1/provider", headers: ADMIN });
  assert.equal(removed.json().configured, false);
  await app.close();
});

test("production without a provider skips with skipped_no_provider and has no outbox", async () => {
  const { app } = buildApp(config({ PINOTIFY_MODE: "production", PINOTIFY_SECRET_KEY: randomBytes(32).toString("hex"), PINOTIFY_DATA_DIR: await mkdtemp(join(tmpdir(), "pinotify-")) }));
  await app.inject({ method: "POST", url: "/api/v1/contacts", headers: ADMIN, payload: warden });
  const sent = await app.inject({ method: "POST", url: "/api/v1/notify", headers: SEND, payload: { channel: "email", contact: "warden", text: "x" } });
  assert.equal(sent.json().status, "skipped_no_provider");
  assert.equal((await app.inject({ url: "/api/v1/outbox", headers: ADMIN })).statusCode, 404);
  await app.close();
});

test("data file is encrypted at rest, survives a restart, and a wrong key is a clear error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pinotify-"));
  const key = randomBytes(32).toString("hex");
  const env = { PINOTIFY_SECRET_KEY: key, PINOTIFY_DATA_DIR: dir };
  try {
    const first = buildApp(config(env));
    await first.app.inject({ method: "POST", url: "/api/v1/contacts", headers: ADMIN, payload: warden });
    await first.app.inject({ method: "PUT", url: "/api/v1/provider", headers: ADMIN, payload: { provider: "smtp", config: { host: "smtp.example.test", from: "church@example.test", user: "u" }, secrets: { pass: "smtp-secret-pass" } } });
    await first.app.close();

    const file = await readFile(join(dir, "notify.enc"), "utf8");
    for (const secret of ["warden", "example.test", "smtp-secret-pass", "4012"]) assert.ok(!file.includes(secret), `leaks ${secret}`);

    const second = buildApp(config(env));
    assert.equal((await second.app.inject({ url: "/api/v1/contacts/warden", headers: ADMIN })).statusCode, 200);
    assert.equal((await second.app.inject({ url: "/api/v1/provider", headers: ADMIN })).json().provider, "smtp");
    await second.app.close();

    const wrong = buildApp(config({ ...env, PINOTIFY_SECRET_KEY: randomBytes(32).toString("hex") }));
    const res = await wrong.app.inject({ url: "/api/v1/contacts", headers: ADMIN });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /cannot be decrypted/);
    await wrong.app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

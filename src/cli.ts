#!/usr/bin/env node
import "./load-env.js";

const args = process.argv.slice(2);
let url = process.env["PINOTIFY_URL"] ?? "http://127.0.0.1:3109";
let json = false;
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--url") url = args[++i] ?? url;
  else if (a === "--json") json = true;
  else rest.push(a);
}

const usage = `pinotify - notification service CLI

USAGE:
  pinotify [--url <url>] [--json] <command>

COMMANDS:
  send <email|sms> <slug> <text...>   Send a message to a contact
  contacts                            List contacts
  contact <slug>                      Show one contact
  add <slug> [--email a@b.c] [--sms +358...] [--name N] [--consent-email] [--consent-sms]
                                      Add or replace a contact (consent is only given with the flags)
  remove <slug>                       Delete a contact
  provider                            Show the provider setting (secrets are never shown)
  log [n]                             Recent attempts (newest first)

ENV: PINOTIFY_URL, PINOTIFY_TOKEN (bearer: the admin token, or the send token for "send")`;

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (process.env["PINOTIFY_TOKEN"]) headers["authorization"] = `Bearer ${process.env["PINOTIFY_TOKEN"]}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${url}${path}`, init);
  if (res.status === 204) return {};
  const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
  if (!res.ok && !(res.status === 429 && data.status)) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function run(): Promise<void> {
  const [cmd, a, b] = rest;
  if (!cmd || cmd === "help" || args.includes("--help")) return void console.log(usage);
  let out: unknown;
  if (cmd === "send" && a && b) {
    out = await call("POST", "/api/v1/notify", { channel: a, contact: b, text: rest.slice(3).join(" "), trigger: "cli" });
  } else if (cmd === "contacts") out = await call("GET", "/api/v1/contacts");
  else if (cmd === "contact" && a) out = await call("GET", `/api/v1/contacts/${encodeURIComponent(a)}`);
  else if (cmd === "add" && a) {
    out = await call("PUT", `/api/v1/contacts/${encodeURIComponent(a)}`, {
      name: flag("--name"),
      email: flag("--email"),
      smsNumber: flag("--sms"),
      consentEmail: rest.includes("--consent-email"),
      consentSms: rest.includes("--consent-sms")
    });
  } else if (cmd === "remove" && a) out = await call("DELETE", `/api/v1/contacts/${encodeURIComponent(a)}`);
  else if (cmd === "provider") out = await call("GET", "/api/v1/provider");
  else if (cmd === "log") out = await call("GET", `/api/v1/log?limit=${Number(a) || 20}`);
  else return void console.log(usage);

  if (json) return void console.log(JSON.stringify(out, null, 2));
  if (cmd === "contacts") {
    for (const c of out as Array<{ slug: string; name: string | null; email: string | null; smsNumber: string | null; fixed?: boolean }>) {
      console.log(`${c.slug.padEnd(16)} ${(c.name ?? "").padEnd(16)} ${c.email ? "email" : "-    "} ${c.smsNumber ? "sms" : "-  "} ${c.fixed ? "(from environment)" : ""}`);
    }
  } else if (cmd === "log") {
    for (const e of out as Array<{ at: number; channel: string; contactSlug: string; status: string; trigger: string }>) {
      console.log(`${new Date(e.at).toISOString()}  ${e.channel.padEnd(5)} ${e.contactSlug.padEnd(16)} ${e.status}  (${e.trigger})`);
    }
  } else console.log(JSON.stringify(out, null, 2));
}

run().catch((err) => {
  console.error(`pinotify: ${(err as Error).message}`);
  process.exit(1);
});

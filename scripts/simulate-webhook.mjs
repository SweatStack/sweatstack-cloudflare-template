#!/usr/bin/env node
// Sends a signed SweatStack webhook to your local app, exactly as SweatStack would.
// SweatStack can't reach localhost, so use this to test notifications during development.
//
//   npm run webhook:simulate -- --user <your SweatStack user id> --activity <activity id>
//
// Options:
//   --user <id>       the user the event is about (yours is on /settings)          required
//   --activity <id>   resource_id: an activity id (open one in the app, copy from the URL)
//   --type <type>     event type (default: activity_created)
//   --url <url>       where your app runs (default: http://localhost:8787)
//
// It reads SWEATSTACK_WEBHOOK_SECRET from .dev.vars. Any whsec_ value works locally, e.g.
// SWEATSTACK_WEBHOOK_SECRET=whsec_bG9jYWwtZGV2ZWxvcG1lbnQtc2VjcmV0

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    user: { type: "string" },
    activity: { type: "string" },
    type: { type: "string", default: "activity_created" },
    url: { type: "string", default: "http://localhost:8787" },
  },
});

if (!values.user) {
  console.error("Missing --user. Usage: npm run webhook:simulate -- --user <user id> --activity <activity id>");
  process.exit(1);
}

let secret = "";
try {
  const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
  secret = /^SWEATSTACK_WEBHOOK_SECRET=(.*)$/m.exec(vars)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
} catch {
  // no .dev.vars
}
if (!secret.startsWith("whsec_")) {
  console.error("Set SWEATSTACK_WEBHOOK_SECRET=whsec_... in .dev.vars (any base64 value works locally), and restart npm run dev.");
  process.exit(1);
}

// Standard Webhooks: HMAC-SHA256 over "{id}.{timestamp}.{body}", keyed with the base64-decoded secret.
const id = `sim_${randomUUID()}`;
const timestamp = Math.floor(Date.now() / 1000);
const body = JSON.stringify({
  id,
  user_id: values.user,
  event_type: values.type,
  resource_id: values.activity ?? null,
  timestamp: new Date().toISOString(),
});
const key = Buffer.from(secret.slice("whsec_".length), "base64");
const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");

const response = await fetch(new URL("/webhooks/sweatstack", values.url), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${signature}`,
    "x-sweatstack-event": values.type,
  },
  body,
});
console.log(`${response.status} ${await response.text()}`);
console.log("See what happened on /admin (Recent webhooks).");

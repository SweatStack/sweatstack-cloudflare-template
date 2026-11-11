// Keys this app generates for itself, so nobody has to invent random strings during deploy:
//
//   cookie_key        signs session cookies (HMAC)
//   token_key         encrypts SweatStack tokens at rest (AES-256-GCM)
//   vapid_public_key  identifies this server to browser push services (Web Push / VAPID)
//   vapid_private_jwk
//
// They are created once, on the first request, and stored in D1. `INSERT OR IGNORE` makes this
// race-free: if two requests generate keys at the same time, the first write wins and both read it back.
//
// Trade-off: keys stored next to the data they protect defend database exports and backups, not a fully
// compromised Cloudflare account. To harden, move them to Worker secrets (see AGENTS.md).

import { base64urlEncode, importAesKey, randomToken } from "./lib/crypto";

export type AppSecrets = {
  cookieKey: string;
  tokenKey: CryptoKey;
  vapid: { publicKey: string; privateKey: CryptoKey };
};

const NAMES = ["cookie_key", "token_key", "vapid_public_key", "vapid_private_jwk"] as const;
type Name = (typeof NAMES)[number];

const cache = new WeakMap<D1Database, Promise<AppSecrets>>();

/** The app's keys, generated on first use. Cached per Worker isolate. */
export function getAppSecrets(db: D1Database): Promise<AppSecrets> {
  let secrets = cache.get(db);
  if (!secrets) {
    secrets = loadAppSecrets(db);
    secrets.catch(() => cache.delete(db)); // never cache a failure
    cache.set(db, secrets);
  }
  return secrets;
}

/** Reads the keys from D1, generating any that are missing. Not cached. */
export async function loadAppSecrets(db: D1Database): Promise<AppSecrets> {
  let stored = await readStored(db);
  if (NAMES.some((name) => !stored.has(name))) {
    const generated = await generate();
    await db.batch(
      NAMES.map((name) =>
        db.prepare("INSERT OR IGNORE INTO app_secrets (name, value) VALUES (?, ?)").bind(name, generated[name]),
      ),
    );
    stored = await readStored(db);
  }

  const value = (name: Name) => {
    const v = stored.get(name);
    if (!v) throw new Error(`App secret ${name} is missing after generation`);
    return v;
  };

  return {
    cookieKey: value("cookie_key"),
    tokenKey: await importAesKey(value("token_key")),
    vapid: {
      publicKey: value("vapid_public_key"),
      privateKey: await crypto.subtle.importKey(
        "jwk",
        JSON.parse(value("vapid_private_jwk")) as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
    },
  };
}

async function readStored(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT name, value FROM app_secrets").all<{ name: string; value: string }>();
  return new Map(results.map((row) => [row.name, row.value]));
}

async function generate(): Promise<Record<Name, string>> {
  const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicRaw = (await crypto.subtle.exportKey("raw", vapid.publicKey)) as ArrayBuffer;
  const privateJwk = (await crypto.subtle.exportKey("jwk", vapid.privateKey)) as JsonWebKey;

  return {
    cookie_key: randomToken(32),
    token_key: randomToken(32),
    vapid_public_key: base64urlEncode(publicRaw),
    vapid_private_jwk: JSON.stringify(privateJwk),
  };
}

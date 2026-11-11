// Web Push, implemented with Web Crypto only (the popular `web-push` npm package needs Node).
//
//   RFC 8291  Message Encryption for Web Push (aes128gcm)
//   RFC 8292  VAPID: identifies this server to the browser's push service
//
// The protocol is frozen, and test/webpush.test.ts checks this file against the RFC's test vector.
// To send a notification, use sendToUser() in ./notify.ts rather than this file.

import { base64urlDecode, base64urlEncode, concatBytes, utf8 } from "../lib/crypto";
import type { Fetch } from "../sweatstack/http";

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: CryptoKey; subject: string };

/** Push services we deliver to. Subscriptions for any other host are refused (no fetching arbitrary URLs). */
const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export type PushResult = { ok: boolean; status: number; /** The subscription is gone for good: delete it. */ gone: boolean };

/** Encrypts `payload` for one subscription and POSTs it to the push service. */
export async function sendPush(fetchFn: Fetch, target: PushTarget, payload: string, vapid: Vapid, ttlSeconds = 24 * 3600): Promise<PushResult> {
  const body = await encryptPayload(utf8(payload), base64urlDecode(target.p256dh), base64urlDecode(target.auth));
  const jwt = await vapidJwt(new URL(target.endpoint).origin, vapid);
  const response = await fetchFn(target.endpoint, {
    method: "POST",
    headers: {
      authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttlSeconds),
      urgency: "normal",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410 };
}

// --- RFC 8291: payload encryption -------------------------------------------------------------

const RECORD_SIZE = 4096;

export async function encryptPayload(
  payload: Uint8Array<ArrayBuffer>,
  uaPublic: Uint8Array<ArrayBuffer>,
  authSecret: Uint8Array<ArrayBuffer>,
  /** Only for tests: fixed salt and sender key pair, as in the RFC's test vector. */
  fixed?: { salt: Uint8Array<ArrayBuffer>; keyPair: CryptoKeyPair },
): Promise<Uint8Array<ArrayBuffer>> {
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keyPair =
    fixed?.keyPair ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer);

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The Web Crypto spec (and workerd) call the peer key `public`; @cloudflare/workers-types spells it `$public`.
  const ecdh = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, keyPair.privateKey, 256));

  // IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = "WebPush: info" || 0x00 || ua_public || as_public)
  const ikm = await hkdf(authSecret, ecdhSecret, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // A single record: the payload, then the 0x02 delimiter that marks the last record (no padding).
  const plaintext = concatBytes(payload, new Uint8Array([2]));
  if (plaintext.length + 16 > RECORD_SIZE) throw new Error("Push payload too large");
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));

  // Header: salt (16) || record size (uint32 BE) || key id length (1) || key id (the sender's public key)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// --- RFC 8292: VAPID --------------------------------------------------------------------------

/** A signed JWT that tells the push service who is sending. Valid for 12 hours. */
export async function vapidJwt(audience: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const header = base64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64urlEncode(
    utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })),
  );
  const unsigned = `${header}.${claims}`;
  // Web Crypto returns the raw r||s signature, which is exactly what JWS ES256 expects.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.privateKey, utf8(unsigned));
  return `${unsigned}.${base64urlEncode(signature)}`;
}

/** VAPID `sub`: who to contact about this sender. Push services require an https: or mailto: URL. */
export function vapidSubject(origin: string): string {
  return origin.startsWith("https://") ? origin : "mailto:push@example.com";
}

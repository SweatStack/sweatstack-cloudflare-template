// Small Web Crypto helpers. Everything here runs on the Workers runtime without Node APIs.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>; // always backed by a plain ArrayBuffer
}

export function base64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return base64Decode(padded);
}

export function base64Encode(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A random, URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64urlEncode(randomBytes(bytes));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-time comparison of two strings (for secrets, signatures and OAuth state). */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = utf8(a);
  const right = utf8(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

export async function hmacSha256(key: Uint8Array<ArrayBuffer>, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));
}

// --- AES-GCM encryption for values at rest (tokens in D1) -------------------------------------
//
// Format: "v1.<iv>.<ciphertext>", both base64url. The version prefix lets us rotate the scheme later.

export async function importAesKey(rawKeyBase64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64urlDecode(rawKeyBase64url), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptString(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plaintext));
  return `v1.${base64urlEncode(iv)}.${base64urlEncode(ciphertext)}`;
}

export async function decryptString(key: CryptoKey, value: string): Promise<string> {
  const [version, iv, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("Unsupported encrypted value");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlDecode(iv) },
    key,
    base64urlDecode(ciphertext),
  );
  return decoder.decode(plaintext);
}

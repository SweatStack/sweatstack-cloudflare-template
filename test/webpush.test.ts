import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode, concatBytes, utf8 } from "../src/lib/crypto";
import { encryptPayload, isAllowedEndpoint, vapidJwt } from "../src/push/webpush";

// RFC 8291, Appendix A: https://www.rfc-editor.org/rfc/rfc8291#appendix-A
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function ecdhKeyPair(publicB64: string, privateB64: string): Promise<CryptoKeyPair> {
  const raw = base64urlDecode(publicB64);
  const jwk = { kty: "EC", crv: "P-256", x: base64urlEncode(raw.slice(1, 33)), y: base64urlEncode(raw.slice(33, 65)), d: privateB64, ext: true };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

/** The browser's side of RFC 8291, so we can check what we send decrypts. */
async function decrypt(body: Uint8Array<ArrayBuffer>, ua: CryptoKeyPair, authSecret: Uint8Array<ArrayBuffer>): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, ua.privateKey, 256));
  const hkdf = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const ikm = await hkdf(authSecret, secret, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  expect(plain.at(-1)).toBe(2); // last-record delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe("Web Push encryption (RFC 8291)", () => {
  it("matches the RFC's test vector byte for byte", async () => {
    const body = await encryptPayload(utf8(RFC.plaintext), base64urlDecode(RFC.uaPublic), base64urlDecode(RFC.authSecret), {
      salt: base64urlDecode(RFC.salt),
      keyPair: await ecdhKeyPair(RFC.asPublic, RFC.asPrivate),
    });
    expect(base64urlEncode(body)).toBe(RFC.body);
  });

  it("produces messages a browser can decrypt (random salt and key)", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const message = JSON.stringify({ title: "Morning ride", body: "42.1 km · 1:32:10", url: "/activities/abc" });
    const body = await encryptPayload(utf8(message), uaPublic, auth);
    expect(await decrypt(body, ua, auth)).toBe(message);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a JWT the public key verifies", async () => {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = base64urlEncode((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
    const jwt = await vapidJwt("https://fcm.googleapis.com", { publicKey, privateKey: keys.privateKey, subject: "https://app.example.com" }, 1_700_000_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(header!)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(claims!)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_700_000_000 + 12 * 3600,
      sub: "https://app.example.com",
    });
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.publicKey, base64urlDecode(signature!), utf8(`${header}.${claims}`));
    expect(valid).toBe(true);
  });
});

describe("push endpoints", () => {
  it("only accepts https endpoints of known push services", () => {
    expect(isAllowedEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isAllowedEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isAllowedEndpoint("https://wns2-db5p.notify.windows.com/w/?token=abc")).toBe(true);
    expect(isAllowedEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedEndpoint("https://evil.example/fcm.googleapis.com")).toBe(false);
    expect(isAllowedEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isAllowedEndpoint("not a url")).toBe(false);
  });
});

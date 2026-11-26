// Web Push for Cloudflare Workers — WebCrypto only, no dependencies.
//
//   • Payload encryption: RFC 8291 (Message Encryption for Web Push) with the
//     "aes128gcm" content coding of RFC 8188.
//   • Sender identification: VAPID, RFC 8292 (an ES256-signed JWT).
//
// `encryptPayload` reproduces the RFC 8291 Appendix A test vectors when given
// the RFC's fixed sender key and salt (see scripts/test-webpush.mjs).

const te = new TextEncoder();

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// HKDF-SHA256 (extract + expand) → `length` bytes.
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;   // browser's P-256 public key (base64url, 65 bytes uncompressed)
  auth: string;     // browser's auth secret (base64url, 16 bytes)
}

export interface VapidKeys {
  publicKey: string;   // base64url, 65-byte uncompressed P-256 point
  privateKey: string;  // base64url, 32-byte private scalar ("d")
  subject: string;     // contact: "mailto:…" or "https://…"
}

// Fixed sender key + salt are only for reproducing the RFC test vectors.
export interface FixedEncryptionInputs {
  senderPrivateJwk: JsonWebKey;
  senderPublic: Uint8Array;
  salt: Uint8Array;
}

export async function encryptPayload(
  target: Pick<PushTarget, "p256dh" | "auth">,
  plaintext: Uint8Array,
  fixed?: FixedEncryptionInputs,
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(target.p256dh);
  const authSecret = b64urlDecode(target.auth);

  // A fresh sender (application server) ECDH key pair per message.
  let senderPrivate: CryptoKey;
  let senderPublic: Uint8Array;
  if (fixed) {
    senderPrivate = await crypto.subtle.importKey(
      "jwk", fixed.senderPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
    );
    senderPublic = fixed.senderPublic;
  } else {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
    )) as CryptoKeyPair;
    senderPrivate = pair.privateKey;
    senderPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Standard WebCrypto field name is `public` (workers-types mislabels it
  // `$public`; workerd strips the `$` it uses for C++ keywords).
  const ecdhParams = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, senderPrivate, 256));

  // RFC 8291 §3.4: mix in the auth secret, then derive the content key + nonce.
  const keyInfo = concat(te.encode("WebPush: info\0"), uaPublic, senderPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  // Single record: plaintext + 0x02 delimiter ("last record", no padding).
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(plaintext, new Uint8Array([2]))),
  );

  // RFC 8188 header: salt(16) | record size(4, big-endian) | idlen(1) | keyid = sender public key.
  const header = new Uint8Array(21 + senderPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = senderPublic.length;
  header.set(senderPublic, 21);
  return concat(header, ciphertext);
}

// VAPID JWTs are valid for up to 24h; reuse one per push service for 12h.
const jwtCache = new Map<string, { token: string; exp: number }>();

export async function vapidToken(audience: string, vapid: VapidKeys): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = `${audience}|${vapid.publicKey}`;
  const hit = jwtCache.get(cacheKey);
  if (hit && hit.exp - now > 3600) return hit.token;

  const exp = now + 12 * 3600;
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(te.encode(JSON.stringify({ aud: audience, exp, sub: vapid.subject })));
  const pub = b64urlDecode(vapid.publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), d: vapid.privateKey },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto emits the raw r||s signature, which is exactly JWS ES256.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${claims}`));
  const token = `${header}.${claims}.${b64urlEncode(sig)}`;
  jwtCache.set(cacheKey, { token, exp });
  return token;
}

// Only deliver to the real browser push services (subscriptions are written by
// browsers, but a hand-crafted row must not turn the Worker into a relay).
export function isKnownPushService(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    const h = u.hostname;
    return (
      h === "fcm.googleapis.com" ||                    // Chrome, Android, Opera, Brave, Samsung
      h === "web.push.apple.com" || h.endsWith(".push.apple.com") ||   // Safari, iOS
      h.endsWith(".notify.windows.com") ||             // Edge on Windows
      h.endsWith("push.services.mozilla.com")          // Firefox
    );
  } catch {
    return false;
  }
}

export interface SendOptions {
  ttl?: number;                                    // seconds the push service keeps it if the device is offline
  topic?: string;                                  // newer message with the same topic replaces an undelivered one
  urgency?: "very-low" | "low" | "normal" | "high";
}

// Returns the push service's HTTP status: 201 = accepted; 404/410 = the
// subscription is gone and should be deleted.
export async function sendPush(target: PushTarget, message: unknown, vapid: VapidKeys, opts: SendOptions = {}): Promise<number> {
  const body = await encryptPayload(target, te.encode(JSON.stringify(message)));
  const audience = new URL(target.endpoint).origin;
  const headers: Record<string, string> = {
    Authorization: `vapid t=${await vapidToken(audience, vapid)}, k=${vapid.publicKey}`,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(opts.ttl ?? 24 * 3600),
    Urgency: opts.urgency ?? "normal",
  };
  if (opts.topic) headers.Topic = opts.topic;
  const resp = await fetch(target.endpoint, { method: "POST", headers, body });
  return resp.status;
}

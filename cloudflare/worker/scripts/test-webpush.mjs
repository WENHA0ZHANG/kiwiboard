// Checks src/lib/webpush.ts without any network:
//   1. RFC 8291 Appendix A: fixed keys + salt must give the RFC's exact bytes.
//   2. Random sender key/salt: the browser side (ua_private) can decrypt it.
//   3. VAPID JWT: well-formed claims and a valid ES256 signature.
// Run from cloudflare/worker:  node scripts/test-webpush.mjs
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/lib/webpush.ts"], bundle: true, format: "esm", platform: "neutral", write: false,
});
const wp = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
const { b64urlDecode: d, b64urlEncode: e } = wp;
const te = new TextEncoder();
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── RFC 8291 Appendix A inputs ──────────────────────────────────────────────
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};
const jwkFor = (pubB64, dB64) => {
  const p = d(pubB64);
  return { kty: "EC", crv: "P-256", x: e(p.slice(1, 33)), y: e(p.slice(33, 65)), d: dB64 };
};

// 1. Exact reproduction of the RFC example.
const body = await wp.encryptPayload(
  { p256dh: RFC.uaPublic, auth: RFC.auth },
  te.encode(RFC.plaintext),
  { senderPrivateJwk: jwkFor(RFC.asPublic, RFC.asPrivate), senderPublic: d(RFC.asPublic), salt: d(RFC.salt) },
);
check("RFC 8291 header (86 bytes)", eq(body.slice(0, 86), d(RFC.header)));
check("RFC 8291 ciphertext", eq(body.slice(86), d(RFC.ciphertext)));

// 2. Browser-side decryption of a normal (random key + salt) message.
async function decryptAsBrowser(buf, uaPublicB64, uaPrivateB64, authB64) {
  const salt = buf.slice(0, 16);
  const idlen = buf[20];
  const senderPublic = buf.slice(21, 21 + idlen);
  const ct = buf.slice(21 + idlen);
  const uaPriv = await crypto.subtle.importKey("jwk", jwkFor(uaPublicB64, uaPrivateB64), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const asPub = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asPub }, uaPriv, 256));
  const hk = async (s, ikm, info, n) => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, k, n * 8));
  };
  const keyInfo = new Uint8Array([...te.encode("WebPush: info\0"), ...d(uaPublicB64), ...senderPublic]);
  const ikm = await hk(d(authB64), ecdh, keyInfo, 32);
  const cek = await hk(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hk(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  if (pt[pt.length - 1] !== 2) throw new Error("missing 0x02 delimiter");
  return new TextDecoder().decode(pt.slice(0, -1));
}
const message = JSON.stringify({ title: "🟢 Market regime: Buy (+5.2)", body: "Cautious Buy → Buy", url: "/#prediction" });
const randomBody = await wp.encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, te.encode(message));
check("random key/salt → browser decrypts the same JSON", (await decryptAsBrowser(randomBody, RFC.uaPublic, RFC.uaPrivate, RFC.auth)) === message);
check("each message uses a fresh salt", !eq(randomBody.slice(0, 16), (await wp.encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, te.encode(message))).slice(0, 16)));

// 3. VAPID JWT.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const vapid = {
  publicKey: e(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
  privateKey: jwk.d,
  subject: "https://poortrader.com",
};
const token = await wp.vapidToken("https://fcm.googleapis.com", vapid);
const [h, c, s] = token.split(".");
const claims = JSON.parse(new TextDecoder().decode(d(c)));
const header = JSON.parse(new TextDecoder().decode(d(h)));
check("VAPID header is ES256 JWT", header.alg === "ES256" && header.typ === "JWT");
check("VAPID claims: aud, sub, exp within 24h", claims.aud === "https://fcm.googleapis.com" && claims.sub === vapid.subject
  && claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
check("VAPID signature verifies with the public key",
  await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, d(s), te.encode(`${h}.${c}`)));

// 4. Endpoint allow-list.
check("allows FCM / Apple / Mozilla / Windows endpoints", [
  "https://fcm.googleapis.com/fcm/send/abc", "https://web.push.apple.com/QH8x", "https://updates.push.services.mozilla.com/wpush/v2/x",
  "https://wns2-sg2p.notify.windows.com/w/?token=x",
].every(wp.isKnownPushService));
check("rejects other hosts", !["https://evil.example.com/x", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.com/x"].some(wp.isKnownPushService));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);

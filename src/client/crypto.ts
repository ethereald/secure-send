const encoder = new TextEncoder();

export function bytesToBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export interface RoomKeys {
  secret: Uint8Array;
  roomId: string;
  signalKey: CryptoKey;
}

export interface PeerIdentity {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function deriveRoomKeys(secret: Uint8Array): Promise<RoomKeys> {
  if (secret.byteLength !== 32) throw new Error("The room link is invalid.");
  const material = await crypto.subtle.importKey("raw", bytesToBuffer(secret), "HKDF", false, ["deriveBits", "deriveKey"]);
  const roomIdBytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: bytesToBuffer(new Uint8Array()), info: bytesToBuffer(encoder.encode("room-id")) },
      material,
      128,
    ),
  );
  const signalKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytesToBuffer(new Uint8Array()), info: bytesToBuffer(encoder.encode("signal-key")) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { secret: Uint8Array.from(secret), roomId: toBase64Url(roomIdBytes), signalKey };
}

export async function sealSignal(key: CryptoKey, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesToBuffer(iv) },
    key,
    bytesToBuffer(encoder.encode(JSON.stringify(payload))),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function openSignal<T>(key: CryptoKey, sealed: string): Promise<T> {
  const [encodedIv, encodedCiphertext, extra] = sealed.split(".");
  if (!encodedIv || !encodedCiphertext || extra !== undefined) throw new Error("Invalid encrypted signal.");
  const iv = fromBase64Url(encodedIv);
  const ciphertext = fromBase64Url(encodedCiphertext);
  if (iv.byteLength !== 12 || ciphertext.byteLength > 16 * 1024) {
    throw new Error("Invalid encrypted signal.");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesToBuffer(iv) },
    key,
    bytesToBuffer(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function createPeerIdentity(): Promise<PeerIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyBytes };
}

export async function importPeerPublicKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytesToBuffer(bytes), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

export async function derivePeerMaterial(
  local: PeerIdentity,
  remoteKey: CryptoKey,
  roomSecret: Uint8Array,
  remotePublicKeyBytes: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
): Promise<{ rootKey: CryptoKey; sas: string }> {
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: remoteKey },
    local.privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const localPublic = toBase64Url(local.publicKeyBytes);
  const remotePublic = toBase64Url(remotePublicKeyBytes);
  const identities = [localPublic, remotePublic].sort().join("|");
  const fingerprints = [localFingerprint, remoteFingerprint].sort().join("|");
  const info = encoder.encode(`secure-send-pair-v1|${identities}|${fingerprints}`);
  const rootBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bytesToBuffer(roomSecret), info: bytesToBuffer(info) },
    material,
    256,
  );
  const rootKey = await crypto.subtle.importKey("raw", rootBits, "HKDF", false, ["deriveKey"]);
  const sasBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bytesToBuffer(roomSecret), info: bytesToBuffer(encoder.encode(`secure-send-sas-v1|${identities}|${fingerprints}`)) },
    material,
    48,
  );
  const sas = Array.from(new Uint8Array(sasBits))
    .map((byte) => String(byte % 10))
    .join("")
    .slice(0, 6);
  return { rootKey, sas };
}

export async function deriveFileKey(rootKey: CryptoKey, fileId: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytesToBuffer(fileId), info: bytesToBuffer(encoder.encode("secure-send-file-v1")) },
    rootKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptChunk(
  key: CryptoKey,
  fileId: Uint8Array,
  index: number,
  final: boolean,
  plaintext: ArrayBuffer,
): Promise<ArrayBuffer> {
  const iv = chunkNonce(fileId, index);
  const aad = chunkAad(fileId, index, final);
  return crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesToBuffer(iv), additionalData: bytesToBuffer(aad) },
    key,
    plaintext,
  );
}

export async function decryptChunk(
  key: CryptoKey,
  fileId: Uint8Array,
  index: number,
  final: boolean,
  ciphertext: ArrayBuffer,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesToBuffer(chunkNonce(fileId, index)), additionalData: bytesToBuffer(chunkAad(fileId, index, final)) },
    key,
    ciphertext,
  );
}

function chunkNonce(fileId: Uint8Array, index: number): Uint8Array {
  if (fileId.byteLength !== 16 || !Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error("Invalid file chunk.");
  }
  const iv = new Uint8Array(12);
  iv.set(fileId.subarray(0, 8), 0);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

function chunkAad(fileId: Uint8Array, index: number, final: boolean): Uint8Array {
  const aad = new Uint8Array(21);
  aad.set(fileId, 0);
  new DataView(aad.buffer).setUint32(16, index);
  aad[20] = final ? 1 : 0;
  return aad;
}

export async function generateHostKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signHostAction(
  key: CryptoKey,
  nonce: string,
  action: string,
  args: Record<string, unknown>,
): Promise<string> {
  const message = JSON.stringify({ nonce, action, args });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      encoder.encode(message),
    ),
  );
  return toBase64Url(signature);
}

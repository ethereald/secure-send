import { describe, expect, it } from "vitest";
import {
  createPeerIdentity,
  decryptChunk,
  deriveFileKey,
  derivePeerMaterial,
  deriveRoomKeys,
  encryptChunk,
  fromBase64Url,
  generateHostKeyPair,
  openSignal,
  sealSignal,
  signHostAction,
  toBase64Url,
} from "../../src/client/crypto";
import { sanitizeFilename } from "../../src/client/download-sink";

describe("room and transfer cryptography", () => {
  it("derives a stable opaque room ID and a distinct signaling key", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const first = await deriveRoomKeys(secret);
    const second = await deriveRoomKeys(secret.slice());

    expect(first.roomId).toBe(second.roomId);
    expect(first.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await deriveRoomKeys(crypto.getRandomValues(new Uint8Array(32)))).roomId).not.toBe(first.roomId);

    const sealed = await sealSignal(first.signalKey, { kind: "hello", nickname: "A" });
    await expect(openSignal(second.signalKey, sealed)).resolves.toEqual({ kind: "hello", nickname: "A" });
    const [iv, ciphertext] = sealed.split(".");
    const tamperedBytes = fromBase64Url(ciphertext);
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    const tampered = `${iv}.${toBase64Url(tamperedBytes)}`;
    await expect(openSignal(first.signalKey, tampered)).rejects.toThrow();
  });

  it("derives matching peer keys and authenticates each file chunk", async () => {
    const roomSecret = crypto.getRandomValues(new Uint8Array(32));
    const peerA = await createPeerIdentity();
    const peerB = await createPeerIdentity();
    const pubA = peerA.publicKeyBytes;
    const pubB = peerB.publicKeyBytes;
    const fingerprintA = "a".repeat(64);
    const fingerprintB = "b".repeat(64);

    const materialA = await derivePeerMaterial(
      peerA,
      peerB.publicKey,
      roomSecret,
      pubB,
      fingerprintA,
      fingerprintB,
    );
    const materialB = await derivePeerMaterial(
      peerB,
      peerA.publicKey,
      roomSecret,
      pubA,
      fingerprintB,
      fingerprintA,
    );
    expect(materialA.sas).toBe(materialB.sas);

    const fileId = crypto.getRandomValues(new Uint8Array(16));
    const keyA = await deriveFileKey(materialA.rootKey, fileId);
    const keyB = await deriveFileKey(materialB.rootKey, fileId);
    const plain = new TextEncoder().encode("private transfer").buffer;
    const encrypted = await encryptChunk(keyA, fileId, 0, true, plain);
    await expect(decryptChunk(keyB, fileId, 0, true, encrypted)).resolves.toEqual(plain);
    await expect(decryptChunk(keyB, fileId, 0, false, encrypted)).rejects.toThrow();
    await expect(decryptChunk(keyB, fileId, 1, true, encrypted)).rejects.toThrow();

    const otherFingerprint = await derivePeerMaterial(
      peerA,
      peerB.publicKey,
      roomSecret,
      pubB,
      fingerprintA,
      "c".repeat(64),
    );
    expect(materialA.sas).toMatch(/^\d{6}$/);
    const otherKey = await deriveFileKey(otherFingerprint.rootKey, fileId);
    await expect(decryptChunk(otherKey, fileId, 0, true, encrypted)).rejects.toThrow();
  });

  it("keeps the host signing key non-extractable and sanitizes download names", async () => {
    const pair = await generateHostKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const nonce = "one-time-challenge";
    const action = "lock";
    const args = {};
    const signature = fromBase64Url(await signHostAction(pair.privateKey, nonce, action, args));
    const verifier = await crypto.subtle.importKey(
      "jwk",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        signature,
        new TextEncoder().encode(JSON.stringify({ nonce, action, args })),
      ),
    ).resolves.toBe(true);
    expect(sanitizeFilename("../private\\report\u0000.txt")).toBe(".._private_report_.txt");
    expect(sanitizeFilename("")).toBe("download");
  });
});

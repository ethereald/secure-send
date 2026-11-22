import { afterEach, describe, expect, it, vi } from "vitest";
import { clipboardSink, MAX_CLIPBOARD_BYTES, readClipboardFile, writeClipboard } from "../../src/client/clipboard";
import { deriveRoomKeys, fromBase64Url } from "../../src/client/crypto";
import { inviteUrlForSecret } from "../../src/client/session";
import { TransferManager, type IncomingFileOffer } from "../../src/client/transfer";
import worker from "../../src/worker/index";

afterEach(() => vi.unstubAllGlobals());

describe("sharing", () => {
  it("reconstructs the same private invite after the address fragment is stripped", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const original = inviteUrlForSecret(secret, "https://example.test/?source=invite");
    const keys = await deriveRoomKeys(fromBase64Url(new URL(original).hash.slice(1)));
    expect(inviteUrlForSecret(keys.secret, "https://example.test/?source=invite")).toBe(original);
  });

  it("uses the LAN host for loopback invites without rewriting non-loopback origins", () => {
    const secret = new Uint8Array(32);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const url = new URL(inviteUrlForSecret(secret, `https://${host}:8787/?a=1`, "192.168.1.10"));
      expect(url.origin).toBe("https://192.168.1.10:8787");
      expect(url.search).toBe("?a=1");
      expect(url.hash.length).toBeGreaterThan(1);
    }
    expect(new URL(inviteUrlForSecret(secret, "https://example.test/", "192.168.1.10")).hostname).toBe("example.test");
    expect(new URL(inviteUrlForSecret(secret, "https://localhost/", "evil.example")).hostname).toBe("localhost");
    expect(new URL(inviteUrlForSecret(secret, "https://localhost/")).hostname).toBe("localhost");
  });

  it("only exposes the LAN invite address in local development mode", async () => {
    const request = new Request("https://example.test/api/config");
    const env = { DEV_MODE: "1", LAN_ADDRESS: "192.168.1.10" };
    const local = await worker.fetch(request, env as Parameters<typeof worker.fetch>[1]);
    expect(await local.json()).toMatchObject({ devMode: true, lanAddress: "192.168.1.10" });
    const production = await worker.fetch(request, { ...env, DEV_MODE: "0" } as Parameters<typeof worker.fetch>[1]);
    expect(await production.json()).not.toHaveProperty("lanAddress");
  });

  it("round-trips text and image through an approved encrypted peer transfer", async () => {
    const image = new Blob([new Uint8Array(150_000).fill(42)], { type: "image/png" });
    vi.stubGlobal("navigator", { clipboard: {
      read: async () => [{
        types: ["text/plain", "image/png"],
        getType: async (type: string) => type === "text/plain" ? new Blob(["hello"]) : image,
      }],
    } });
    vi.stubGlobal("window", globalThis);
    const file = await readClipboardFile();
    const root = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, ["deriveKey"]);
    const controlA = new MockChannel();
    const controlB = new MockChannel();
    const dataA = new MockChannel();
    const dataB = new MockChannel();
    controlA.other = controlB;
    controlB.other = controlA;
    dataA.other = dataB;
    dataB.other = dataA;
    let offer: IncomingFileOffer | undefined;
    let received: { text?: string; image?: Blob } | undefined;
    const events = {
      onIncoming: (next: IncomingFileOffer) => { offer = next; },
      onClipboard: (_peer: string, content: { text?: string; image?: Blob }) => { received = content; },
      onProgress: () => {},
      onMessage: () => {},
    };
    const sender = new TransferManager(events);
    const recipient = new TransferManager(events);
    sender.attach("recipient", root, controlA.asChannel(), dataA.asChannel());
    recipient.attach("sender", root, controlB.asChannel(), dataB.asChannel());
    const sending = sender.sendClipboard("recipient", file);
    await vi.waitFor(() => expect(offer?.kind).toBe("clipboard"));
    expect(received).toBeUndefined();
    expect(controlA.sent.join("")).not.toContain("hello");
    await offer!.accept();
    await sending;
    expect(received?.text).toBe("hello");
    expect(await received?.image?.arrayBuffer()).toEqual(await image.arrayBuffer());
  });

  it("rejects oversized and malformed clipboard payloads", async () => {
    expect(() => clipboardSink(MAX_CLIPBOARD_BYTES + 1, () => {})).toThrow();
    const sink = clipboardSink(8, () => { throw new Error("Must not deliver invalid content."); });
    await sink.write(new Uint8Array(8).fill(255).buffer);
    await expect(sink.close()).rejects.toThrow("Invalid clipboard");
  });

  it("rejects truncated clipboard payloads and reports unavailable clipboard writing", async () => {
    const sink = clipboardSink(9, () => { throw new Error("Must not deliver truncated content."); });
    await sink.write(new Uint8Array(8).buffer);
    await expect(sink.close()).rejects.toThrow("Incomplete");
    vi.stubGlobal("navigator", {});
    await expect(writeClipboard({ text: "hello" })).rejects.toThrow("unavailable");
  });

  it("supports text-only clipboards and surfaces denied write permissions", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "text only", writeText } });
    const file = await readClipboardFile();
    let text: string | undefined;
    const sink = clipboardSink(file.size, (content) => { text = content.text; });
    await sink.write(await file.arrayBuffer());
    await sink.close();
    expect(text).toBe("text only");
    await expect(writeClipboard({ text })).rejects.toThrow("Permission denied");
    expect(writeText).toHaveBeenCalledWith("text only");
  });
});

class MockChannel extends EventTarget {
  readonly readyState = "open";
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];
  binaryType = "arraybuffer";
  other?: MockChannel;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.sent.push(data);
    const payload = typeof data === "string" ? data : data.slice().buffer;
    queueMicrotask(() => this.other?.dispatchEvent(new MessageEvent("message", { data: payload })));
  }

  asChannel(): RTCDataChannel {
    return this as unknown as RTCDataChannel;
  }
}

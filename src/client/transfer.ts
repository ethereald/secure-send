import {
  decryptChunk,
  deriveFileKey,
  encryptChunk,
  bytesToBuffer,
  fromBase64Url,
  toBase64Url,
} from "./crypto";
import { beginDownload, sanitizeFilename, type DownloadSink } from "./download-sink";

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 4 * 1024 * 1024;
const LOW_WATER_MARK = 1024 * 1024;
const OFFER_TIMEOUT_MS = 60_000;
const MAX_PENDING_OFFERS = 10;

export interface IncomingFileOffer {
  id: string;
  name: string;
  size: number;
  mime: string;
  from: string;
  accept(): Promise<void>;
  decline(): void;
}

interface OutgoingTransfer {
  file: File;
  fileId: Uint8Array;
  fileKey: CryptoKey;
  peerId: string;
  accepted: Promise<void>;
  resolveAccepted: () => void;
  rejectAccepted: (error: Error) => void;
  completed: Promise<void>;
  resolveCompleted: () => void;
  rejectCompleted: (error: Error) => void;
  cancelled: boolean;
}

interface IncomingTransfer {
  id: string;
  fileId: Uint8Array;
  fileKey: CryptoKey;
  peerId: string;
  name: string;
  size: number;
  mime: string;
  sink: DownloadSink;
  nextIndex: number;
  received: number;
  timeout: number;
}

interface TransferEvents {
  onIncoming(offer: IncomingFileOffer): void;
  onProgress(peerId: string, fileName: string, percent: number, direction: "send" | "receive"): void;
  onMessage(peerId: string, message: string): void;
}

export class TransferManager {
  private readonly dataChannels = new Map<string, RTCDataChannel>();
  private readonly controlChannels = new Map<string, RTCDataChannel>();
  private readonly rootKeys = new Map<string, CryptoKey>();
  private readonly dataQueues = new Map<string, Promise<void>>();
  private readonly events: TransferEvents;
  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly incoming = new Map<string, IncomingTransfer>();
  private readonly pendingOffers = new Map<string, string>();

  constructor(events: TransferEvents) {
    this.events = events;
  }

  attach(peerId: string, rootKey: CryptoKey, control: RTCDataChannel, data: RTCDataChannel): void {
    this.rootKeys.set(peerId, rootKey);
    this.controlChannels.set(peerId, control);
    this.dataChannels.set(peerId, data);
    control.addEventListener("message", (event) => void this.onControl(peerId, event.data));
    data.binaryType = "arraybuffer";
    data.addEventListener("message", (event) => {
      const previous = this.dataQueues.get(peerId) ?? Promise.resolve();
      const next = previous
        .then(() => this.onData(peerId, event.data))
        .catch((error: unknown) => {
          this.events.onMessage(peerId, error instanceof Error ? error.message : "Could not receive file data.");
        });
      this.dataQueues.set(peerId, next);
      void next.finally(() => {
        if (this.dataQueues.get(peerId) === next) this.dataQueues.delete(peerId);
      });
    });
    control.addEventListener("close", () => this.cancelPeer(peerId));
  }

  async sendFiles(peerId: string, files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) await this.offerFile(peerId, file);
  }

  cancelPeer(peerId: string): void {
    for (const [id, pendingPeerId] of this.pendingOffers) {
      if (pendingPeerId === peerId) this.pendingOffers.delete(id);
    }
    for (const [id, transfer] of this.outgoing) {
      if (transfer.peerId === peerId) {
        transfer.cancelled = true;
        transfer.rejectAccepted(new Error("Transfer cancelled."));
        transfer.rejectCompleted(new Error("Transfer cancelled."));
        this.outgoing.delete(id);
      }
    }
    for (const [id, transfer] of this.incoming) {
      if (transfer.peerId === peerId) {
        window.clearTimeout(transfer.timeout);
        transfer.sink.abort("Connection closed.");
        this.incoming.delete(id);
      }
    }
    this.dataChannels.delete(peerId);
    this.controlChannels.delete(peerId);
    this.rootKeys.delete(peerId);
    this.dataQueues.delete(peerId);
  }

  private async offerFile(peerId: string, file: File): Promise<void> {
    const rootKey = this.requireRootKey(peerId);
    const fileId = crypto.getRandomValues(new Uint8Array(16));
    const id = toBase64Url(fileId);
    const fileKey = await deriveFileKey(rootKey, fileId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedMetadata = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      fileKey,
      new TextEncoder().encode(JSON.stringify({
        name: sanitizeFilename(file.name),
        size: file.size,
        mime: file.type || "application/octet-stream",
      })),
    );
    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: Error) => void;
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    void completed.catch(() => undefined);
    const transfer: OutgoingTransfer = {
      file,
      fileId,
      fileKey,
      peerId,
      accepted,
      resolveAccepted,
      rejectAccepted,
      completed,
      resolveCompleted,
      rejectCompleted,
      cancelled: false,
    };
    this.outgoing.set(id, transfer);
    const timeout = window.setTimeout(() => {
      if (this.outgoing.has(id)) {
        this.outgoing.delete(id);
        rejectAccepted(new Error(`${file.name}: the offer timed out.`));
      }
    }, OFFER_TIMEOUT_MS);
    try {
      this.sendControl(peerId, {
        type: "offer",
        id,
        iv: toBase64Url(iv),
        metadata: toBase64Url(new Uint8Array(encryptedMetadata)),
      });
      this.events.onProgress(peerId, file.name, 0, "send");
      this.events.onMessage(peerId, `Waiting for the recipient to accept ${file.name}…`);
      await accepted;
      window.clearTimeout(timeout);
      this.events.onMessage(peerId, `Sending ${file.name}…`);
      await this.transmit(id, transfer);
      const completionTimeout = window.setTimeout(
        () => transfer.rejectCompleted(new Error(`${file.name}: completion confirmation timed out.`)),
        60 * 60 * 1000,
      );
      try {
        await transfer.completed;
        this.events.onMessage(peerId, `${file.name} sent.`);
      } finally {
        window.clearTimeout(completionTimeout);
      }
    } finally {
      window.clearTimeout(timeout);
      this.outgoing.delete(id);
    }
  }

  private async transmit(id: string, transfer: OutgoingTransfer): Promise<void> {
    const channel = this.requireData(transfer.peerId);
    const read = (index: number) =>
      transfer.file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).arrayBuffer();
    // Look one chunk ahead so the final flag reflects the bytes actually read, not file.size,
    // which can be inaccurate for files iOS converts on selection.
    let current = await read(0);
    let sent = 0;
    for (let index = 0; ; index += 1) {
      if (transfer.cancelled) throw new Error("Transfer cancelled.");
      await this.waitForBuffer(channel);
      const next = current.byteLength < CHUNK_SIZE ? new ArrayBuffer(0) : await read(index + 1);
      const final = next.byteLength === 0;
      const encrypted = await encryptChunk(transfer.fileKey, transfer.fileId, index, final, current);
      const frame = new Uint8Array(21 + encrypted.byteLength);
      frame.set(transfer.fileId, 0);
      new DataView(frame.buffer).setUint32(16, index);
      frame[20] = final ? 1 : 0;
      frame.set(new Uint8Array(encrypted), 21);
      channel.send(frame);
      sent += current.byteLength;
      const total = Math.max(transfer.file.size, sent);
      this.events.onProgress(transfer.peerId, transfer.file.name, final || total === 0 ? 100 : Math.min(99, Math.round((sent / total) * 100)), "send");
      if (final) return;
      current = next;
    }
  }

  private async onControl(peerId: string, raw: unknown): Promise<void> {
    if (typeof raw !== "string" || raw.length > 16 * 1024) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "offer") {
      await this.receiveOffer(peerId, message);
    } else if (typeof message.id === "string" && message.type === "accept") {
      this.outgoing.get(message.id)?.resolveAccepted();
    } else if (typeof message.id === "string" && message.type === "decline") {
      this.outgoing.get(message.id)?.rejectAccepted(new Error("The recipient declined the file."));
    } else if (typeof message.id === "string" && message.type === "cancel") {
      this.cancelIncoming(message.id, "The sender cancelled the transfer.");
      const outgoing = this.outgoing.get(message.id);
      if (outgoing) {
        outgoing.cancelled = true;
        outgoing.rejectCompleted(new Error("The recipient cancelled the transfer."));
      }
    } else if (typeof message.id === "string" && message.type === "done") {
      const transfer = this.outgoing.get(message.id);
      if (transfer) {
        if (message.ok === true) transfer.resolveCompleted();
        else {
          transfer.cancelled = true;
          transfer.rejectCompleted(new Error("The recipient could not verify the file."));
        }
      }
    } else if (message.type === "bye") {
      this.cancelPeer(peerId);
    }
  }

  private async receiveOffer(peerId: string, message: Record<string, unknown>): Promise<void> {
    if (
      typeof message.id !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(message.id) ||
      typeof message.iv !== "string" ||
      message.iv.length > 20 ||
      typeof message.metadata !== "string" ||
      message.metadata.length > 2048
    ) return;
    const id = message.id;
    let fileId: Uint8Array;
    let fileKey: CryptoKey;
    let metadata: { name: string; size: number; mime: string };
    try {
      fileId = fromBase64Url(message.id);
      fileKey = await deriveFileKey(this.requireRootKey(peerId), fileId);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytesToBuffer(fromBase64Url(message.iv)) },
        fileKey,
        bytesToBuffer(fromBase64Url(message.metadata)),
      );
      const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (
        fileId.byteLength !== 16 ||
        typeof decoded !== "object" ||
        decoded === null ||
        typeof (decoded as Record<string, unknown>).name !== "string" ||
        typeof (decoded as Record<string, unknown>).size !== "number" ||
        !Number.isSafeInteger((decoded as Record<string, unknown>).size) ||
        typeof (decoded as Record<string, unknown>).mime !== "string"
      ) return;
      const values = decoded as { name: string; size: number; mime: string };
      if (values.size < 0) return;
      metadata = { ...values, name: sanitizeFilename(values.name) };
      if (metadata.name.length > 180 || metadata.mime.length > 256 || metadata.size > Number.MAX_SAFE_INTEGER) return;
    } catch {
      return;
    }

    if (
      this.pendingOffers.size + this.incoming.size >= MAX_PENDING_OFFERS ||
      this.pendingOffers.has(id) ||
      this.incoming.has(id)
    ) {
      this.sendControl(peerId, { type: "decline", id });
      return;
    }
    this.pendingOffers.set(id, peerId);
    let decided = false;
    const decline = () => {
      if (decided) return;
      decided = true;
      this.pendingOffers.delete(id);
      this.sendControl(peerId, { type: "decline", id });
      this.events.onMessage(peerId, `${metadata.name} was declined.`);
    };
    const accept = async () => {
      if (decided) return;
      decided = true;
      this.pendingOffers.delete(id);
      let sink: DownloadSink | undefined;
      try {
        sink = await beginDownload(id, metadata.name, metadata.size);
        const transfer: IncomingTransfer = {
          id,
          fileId,
          fileKey,
          peerId,
          name: metadata.name,
          size: metadata.size,
          mime: metadata.mime,
          sink,
          nextIndex: 0,
          received: 0,
          timeout: window.setTimeout(() => this.cancelIncoming(id, "Transfer timed out."), 60 * 60 * 1000),
        };
        this.incoming.set(transfer.id, transfer);
        this.sendControl(peerId, { type: "accept", id: transfer.id });
      } catch (error) {
        sink?.abort("Could not start download.");
        this.sendControl(peerId, { type: "decline", id });
        this.events.onMessage(peerId, error instanceof Error ? error.message : "Could not start download.");
      }
    };
    const timeout = window.setTimeout(decline, OFFER_TIMEOUT_MS);
    this.events.onIncoming({
      id: message.id,
      name: metadata.name,
      size: metadata.size,
      mime: metadata.mime,
      from: peerId,
      accept: async () => {
        window.clearTimeout(timeout);
        await accept();
      },
      decline: () => {
        window.clearTimeout(timeout);
        decline();
      },
    });
  }

  private async onData(peerId: string, raw: unknown): Promise<void> {
    if (!(raw instanceof ArrayBuffer) || raw.byteLength < 37) return;
    const frame = new Uint8Array(raw);
    const fileId = frame.slice(0, 16);
    const id = toBase64Url(fileId);
    const transfer = this.incoming.get(id);
    if (!transfer || transfer.peerId !== peerId) return;
    const index = new DataView(raw).getUint32(16);
    const final = frame[20] === 1;
    if (frame[20] > 1 || index !== transfer.nextIndex) {
      this.cancelIncoming(id, "Invalid file data.");
      return;
    }
    try {
      const encrypted = raw.slice(21);
      const plain = await decryptChunk(transfer.fileKey, fileId, index, final, encrypted);
      transfer.received += plain.byteLength;
      await transfer.sink.write(plain);
      transfer.nextIndex += 1;
      this.events.onProgress(peerId, transfer.name, final || transfer.size === 0 ? 100 : Math.min(99, Math.round((transfer.received / Math.max(transfer.size, transfer.received)) * 100)), "receive");
      if (final) {
        transfer.sink.close();
        window.clearTimeout(transfer.timeout);
        this.incoming.delete(id);
        this.sendControl(peerId, { type: "done", id, ok: true });
        this.events.onMessage(peerId, `${transfer.name} downloaded.`);
      }
    } catch (error) {
      console.error("Chunk failed", index, error);
      const reason = error instanceof DOMException && error.name === "OperationError"
        ? "File authentication failed. The file was discarded."
        : `Transfer failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.cancelIncoming(id, reason);
      this.sendControl(peerId, { type: "done", id, ok: false });
    }
  }

  private cancelIncoming(id: string, reason: string): void {
    const transfer = this.incoming.get(id);
    if (!transfer) return;
    window.clearTimeout(transfer.timeout);
    transfer.sink.abort(reason);
    this.incoming.delete(id);
    this.sendControl(transfer.peerId, { type: "cancel", id });
    this.events.onMessage(transfer.peerId, reason);
  }

  private sendControl(peerId: string, message: unknown): void {
    const channel = this.controlChannels.get(peerId);
    if (!channel || channel.readyState !== "open") throw new Error("Peer is disconnected.");
    channel.send(JSON.stringify(message));
  }

  private requireData(peerId: string): RTCDataChannel {
    const channel = this.dataChannels.get(peerId);
    if (!channel || channel.readyState !== "open") throw new Error("Peer is disconnected.");
    return channel;
  }

  private requireRootKey(peerId: string): CryptoKey {
    const key = this.rootKeys.get(peerId);
    if (!key) throw new Error("Secure peer connection is not ready.");
    return key;
  }

  private waitForBuffer(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= HIGH_WATER_MARK) return Promise.resolve();
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("The connection is too slow. Try again."));
      }, 30_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Peer disconnected."));
      };
      channel.addEventListener("bufferedamountlow", onLow, { once: true });
      channel.addEventListener("close", onClose, { once: true });
    });
  }
}

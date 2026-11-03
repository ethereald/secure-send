import {
  MAX_PEERS,
  MAX_SIGNAL_BYTES,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  isRecord,
  jsonResponse,
  type RoomMetadata,
  validHostPublicKey,
} from "./protocol";

interface SocketAttachment {
  peerId: string;
}

function randomId(size = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function socketPeerId(socket: WebSocket): string | null {
  const attachment = socket.deserializeAttachment() as SocketAttachment | null;
  return attachment?.peerId ?? null;
}

export class Room {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/init" && request.method === "POST") {
      return this.initialize(request);
    }
    if (url.pathname === "/internal" || url.pathname === "/internal/") {
      return jsonResponse({ error: "Not found." }, 404);
    }
    if (
      url.pathname.endsWith("/ws") &&
      request.method === "GET" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.join();
    }
    return jsonResponse({ error: "Not found." }, 404);
  }

  private async initialize(request: Request): Promise<Response> {
    const input: unknown = await request.json().catch(() => null);
    if (
      !isRecord(input) ||
      !validHostPublicKey(input.hostPubKey) ||
      typeof input.ttlSec !== "number" ||
      !Number.isInteger(input.ttlSec) ||
      input.ttlSec < MIN_TTL_SECONDS ||
      input.ttlSec > MAX_TTL_SECONDS
    ) {
      return jsonResponse({ error: "Invalid room request." }, 400);
    }
    const existing = await this.state.storage.get<RoomMetadata>("meta");
    if (existing) return jsonResponse({ error: "Room already exists." }, 409);

    const createdAt = Date.now();
    const metadata: RoomMetadata = {
      hostPubKey: input.hostPubKey,
      createdAt,
      expiresAt: createdAt + input.ttlSec * 1000,
      locked: false,
      joined: false,
    };
    await this.state.storage.put("meta", metadata);
    await this.state.storage.setAlarm(Math.min(metadata.expiresAt, createdAt + 10 * 60 * 1000));
    return jsonResponse({ expiresAt: metadata.expiresAt }, 201);
  }

  private async join(): Promise<Response> {
    const metadata = await this.state.storage.get<RoomMetadata>("meta");
    if (
      !metadata ||
      Date.now() >= metadata.expiresAt ||
      metadata.locked ||
      this.state.getWebSockets().length >= MAX_PEERS
    ) {
      return jsonResponse({ error: "Session unavailable." }, 404);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const peerId = randomId();
    const peers = this.state.getWebSockets();
    server.serializeAttachment({ peerId } satisfies SocketAttachment);
    this.state.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        type: "welcome",
        peerId,
        roster: peers.map((peer) => socketPeerId(peer)).filter((id): id is string => id !== null),
        expiresAt: metadata.expiresAt,
        isLocked: metadata.locked,
      }),
    );
    for (const peer of peers) {
      this.send(peer, { type: "peer-joined", peerId });
    }
    if (!metadata.joined) {
      metadata.joined = true;
      await this.state.storage.put("meta", metadata);
      await this.state.storage.setAlarm(metadata.expiresAt);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const peerId = socketPeerId(socket);
    if (!peerId) return socket.close(1008, "Invalid peer.");
    if (message instanceof ArrayBuffer) {
      return socket.close(1003, "Binary relay is unavailable.");
    }
    if (new TextEncoder().encode(message).byteLength > MAX_SIGNAL_BYTES) return socket.close(1009, "Message too large.");

    let input: unknown;
    try {
      input = JSON.parse(message);
    } catch {
      return socket.close(1008, "Invalid message.");
    }
    if (!isRecord(input) || typeof input.type !== "string") {
      return socket.close(1008, "Invalid message.");
    }
    switch (input.type) {
      case "signal":
        await this.forwardSignal(socket, peerId, input);
        break;
      case "host-challenge-request":
        await this.issueChallenge(socket, peerId);
        break;
      case "host-action":
        await this.handleHostAction(socket, peerId, input);
        break;
      default:
        socket.close(1008, "Unknown message.");
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.removePeer(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.removePeer(socket);
  }

  async alarm(): Promise<void> {
    const metadata = await this.state.storage.get<RoomMetadata>("meta");
    if (!metadata || Date.now() >= metadata.expiresAt || (!metadata.joined && Date.now() >= metadata.createdAt + 10 * 60 * 1000)) {
      await this.endSession("expired");
      return;
    }
    await this.state.storage.setAlarm(metadata.expiresAt);
  }

  private async forwardSignal(
    socket: WebSocket,
    peerId: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (
      typeof input.to !== "string" ||
      input.to.length > 32 ||
      typeof input.sealed !== "string" ||
      input.sealed.length > MAX_SIGNAL_BYTES
    ) {
      return socket.close(1008, "Invalid signal.");
    }
    const target = this.findSocket(input.to);
    if (!target || target === socket) return;
    this.send(target, { type: "signal", from: peerId, sealed: input.sealed });
  }

  private async issueChallenge(socket: WebSocket, peerId: string): Promise<void> {
    const nonce = randomId(24);
    await this.state.storage.put(`challenge:${peerId}`, {
      nonce,
      expiresAt: Date.now() + 60_000,
    });
    this.send(socket, { type: "host-challenge", nonce });
  }

  private async handleHostAction(
    socket: WebSocket,
    peerId: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const metadata = await this.state.storage.get<RoomMetadata>("meta");
    if (
      !metadata ||
      Date.now() >= metadata.expiresAt ||
      typeof input.action !== "string" ||
      !["set-ttl", "lock", "unlock", "kick", "end-session"].includes(input.action) ||
      typeof input.nonce !== "string" ||
      typeof input.signature !== "string" ||
      !isRecord(input.args)
    ) {
      return this.send(socket, { type: "host-action-error", message: "Invalid host action." });
    }

    const challenge = await this.state.storage.get<{ nonce: string; expiresAt: number }>(
      `challenge:${peerId}`,
    );
    await this.state.storage.delete(`challenge:${peerId}`);
    if (!challenge || challenge.nonce !== input.nonce || Date.now() > challenge.expiresAt) {
      return this.send(socket, { type: "host-action-error", message: "Challenge expired." });
    }
    const valid = await this.verifyHostSignature(metadata.hostPubKey, input);
    if (!valid) return this.send(socket, { type: "host-action-error", message: "Host verification failed." });

    switch (input.action) {
      case "set-ttl": {
        const expiresAt = input.args.expiresAt;
        const maximumExpiry = metadata.createdAt + MAX_TTL_SECONDS * 1000;
        if (
          typeof expiresAt !== "number" ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt < Date.now() + MIN_TTL_SECONDS * 1000 ||
          expiresAt > maximumExpiry
        ) {
          return this.send(socket, { type: "host-action-error", message: "Expiry is outside the allowed range." });
        }
        metadata.expiresAt = expiresAt;
        await this.state.storage.put("meta", metadata);
        await this.state.storage.setAlarm(expiresAt);
        this.broadcast({ type: "ttl-updated", expiresAt });
        break;
      }
      case "lock":
      case "unlock":
        metadata.locked = input.action === "lock";
        await this.state.storage.put("meta", metadata);
        this.broadcast({ type: "room-lock-updated", isLocked: metadata.locked });
        break;
      case "kick": {
        const targetId = input.args.peerId;
        if (typeof targetId !== "string" || targetId === peerId) {
          return this.send(socket, { type: "host-action-error", message: "Invalid peer." });
        }
        const target = this.findSocket(targetId);
        if (target) {
          this.send(target, { type: "kicked" });
          target.close(1000, "Removed by host.");
        }
        break;
      }
      case "end-session":
        await this.endSession("ended");
        break;
    }
    this.send(socket, { type: "host-action-ok", action: input.action });
  }

  private async verifyHostSignature(
    jwk: JsonWebKey,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const signedData = JSON.stringify({
        nonce: input.nonce,
        action: input.action,
        args: input.args,
      });
      const encodedSignature = (input.signature as string).replaceAll("-", "+").replaceAll("_", "/");
      const signature = Uint8Array.from(
        atob(encodedSignature + "=".repeat((4 - (encodedSignature.length % 4)) % 4)),
        (character) => character.charCodeAt(0),
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature,
        new TextEncoder().encode(signedData),
      );
    } catch {
      return false;
    }
  }

  private findSocket(peerId: string): WebSocket | undefined {
    return this.state.getWebSockets().find((socket) => socketPeerId(socket) === peerId);
  }

  private send(socket: WebSocket, message: unknown): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      socket.close(1011, "Connection error.");
    }
  }

  private broadcast(message: unknown): void {
    for (const socket of this.state.getWebSockets()) this.send(socket, message);
  }

  private removePeer(socket: WebSocket): void {
    const peerId = socketPeerId(socket);
    if (peerId) {
      void this.state.storage.delete(`challenge:${peerId}`);
      this.broadcast({ type: "peer-left", peerId });
    }
  }

  private async endSession(reason: string): Promise<void> {
    this.broadcast({ type: "session-ended", reason });
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(1000, "Session ended.");
      } catch {
        // A socket may already have closed between enumeration and close.
      }
    }
    await this.state.storage.deleteAll();
  }
}

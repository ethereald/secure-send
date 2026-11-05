import {
  createPeerIdentity,
  derivePeerMaterial,
  fromBase64Url,
  importPeerPublicKey,
  toBase64Url,
  type PeerIdentity,
} from "./crypto";
import { RoomSession } from "./session";
import { TransferManager, type IncomingFileOffer } from "./transfer";

export interface PeerView {
  id: string;
  nickname: string;
  status: "connecting" | "connected" | "disconnected";
  sas?: string;
  verified: boolean;
}

interface PeerState extends PeerView {
  connection: RTCPeerConnection;
  remotePublicKey?: CryptoKey;
  remotePublicKeyBytes?: Uint8Array;
  localFingerprint?: string;
  remoteFingerprint?: string;
  rootKey?: CryptoKey;
  ctrl?: RTCDataChannel;
  data?: RTCDataChannel;
  madeOffer: boolean;
  queuedCandidates: RTCIceCandidateInit[];
  transferAttached: boolean;
}

export interface PeerEvents {
  onPeers(peers: PeerView[]): void;
  onIncoming(offer: IncomingFileOffer): void;
  onProgress(peerId: string, fileName: string, percent: number, direction: "send" | "receive"): void;
  onMessage(peerId: string, message: string): void;
  onRoomEvent(message: Record<string, unknown>): void;
}

export class PeerMesh {
  private readonly session: RoomSession;
  private readonly nickname: string;
  private readonly events: PeerEvents;
  private readonly peers = new Map<string, PeerState>();
  private readonly transfers: TransferManager;
  private readonly pendingMessages: Record<string, unknown>[] = [];
  private readonly helloSent = new Set<string>();
  private identity?: PeerIdentity;
  private unsubscribe?: () => void;

  constructor(session: RoomSession, nickname: string, events: PeerEvents) {
    this.session = session;
    this.nickname = sanitizeNickname(nickname);
    this.events = events;
    this.transfers = new TransferManager({
      onIncoming: (offer) => this.events.onIncoming(offer),
      onProgress: (id, name, percent, direction) => this.events.onProgress(id, name, percent, direction),
      onMessage: (id, message) => this.events.onMessage(id, message),
    });
  }

  async start(): Promise<void> {
    this.unsubscribe = this.session.subscribe((message) => {
      if (!this.identity) this.pendingMessages.push(message);
      else void this.onRoomMessage(message);
    });
    this.identity = await createPeerIdentity();
    for (const id of this.session.welcome.roster) this.addPeer(id);
    for (const message of this.pendingMessages.splice(0)) await this.onRoomMessage(message);
    for (const id of this.peers.keys()) await this.sendHello(id);
    this.publish();
  }

  async sendFiles(peerId: string, files: FileList | File[]): Promise<void> {
    await this.transfers.sendFiles(peerId, files);
  }

  setVerified(peerId: string, verified: boolean): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.verified = verified;
    this.publish();
  }

  disconnect(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      peer.ctrl?.send(JSON.stringify({ type: "bye" }));
    } catch {
      // The peer may already be disconnected.
    }
    this.transfers.cancelPeer(peerId);
    peer.connection.close();
    this.peers.delete(peerId);
    this.publish();
  }

  leave(keepSecret = false): void {
    this.unsubscribe?.();
    for (const id of this.peers.keys()) this.transfers.cancelPeer(id);
    for (const peer of this.peers.values()) peer.connection.close();
    this.peers.clear();
    this.session.close(keepSecret);
    this.publish();
  }

  private async onRoomMessage(message: Record<string, unknown>): Promise<void> {
    if (message.type === "peer-joined" && typeof message.peerId === "string") {
      const peer = this.addPeer(message.peerId);
      this.publish();
      await this.sendHello(peer.id);
      return;
    }
    if (message.type === "peer-left" && typeof message.peerId === "string") {
      this.transfers.cancelPeer(message.peerId);
      this.peers.get(message.peerId)?.connection.close();
      this.peers.delete(message.peerId);
      this.publish();
      return;
    }
    if (message.type === "signal" && typeof message.from === "string" && typeof message.payload === "object" && message.payload !== null) {
      await this.handleSignal(message.from, message.payload as Record<string, unknown>);
      return;
    }
    this.events.onRoomEvent(message);
  }

  private addPeer(id: string): PeerState {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const connection = new RTCPeerConnection({ iceServers: this.session.iceServers });
    const peer: PeerState = {
      id,
      nickname: "Connecting…",
      status: "connecting",
      verified: false,
      connection,
      madeOffer: false,
      queuedCandidates: [],
      transferAttached: false,
    };
    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        void this.session.sendSignal(id, { kind: "ice", candidate: event.candidate.toJSON() });
      }
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "connected") {
        peer.status = peer.transferAttached ? "connected" : "connecting";
      }
      else if (connection.connectionState === "failed" || connection.connectionState === "closed") peer.status = "disconnected";
      this.tryAttachTransfers(peer);
      this.publish();
    });
    connection.addEventListener("datachannel", (event) => this.attachChannel(peer, event.channel));
    if (this.session.peerId < id) {
      peer.ctrl = connection.createDataChannel("ctrl", { ordered: true });
      peer.data = connection.createDataChannel("data", { ordered: true });
      this.attachChannel(peer, peer.ctrl);
      this.attachChannel(peer, peer.data);
    }
    this.peers.set(id, peer);
    return peer;
  }

  private async sendHello(peerId: string): Promise<void> {
    if (!this.identity || this.helloSent.has(peerId)) return;
    await this.session.sendSignal(peerId, {
      kind: "hello",
      nickname: this.nickname,
      publicKey: toBase64Url(this.identity.publicKeyBytes),
    });
    this.helloSent.add(peerId);
  }

  private async handleSignal(peerId: string, payload: Record<string, unknown>): Promise<void> {
    if (typeof payload.kind !== "string") return;
    try {
      const peer = this.addPeer(peerId);
      switch (payload.kind) {
        case "hello":
          await this.onHello(peer, payload);
          break;
        case "offer":
          await this.onOffer(peer, payload);
          break;
        case "answer":
          await this.onAnswer(peer, payload);
          break;
        case "ice":
          await this.onIce(peer, payload);
          break;
        case "bye":
          this.disconnect(peerId);
          break;
      }
    } catch {
      this.events.onMessage(peerId, "Could not establish a secure connection. Rejoin the room and try again.");
      const peer = this.peers.get(peerId);
      peer?.connection.close();
      this.peers.delete(peerId);
      this.publish();
    }
  }

  private async onHello(peer: PeerState, payload: Record<string, unknown>): Promise<void> {
    if (
      typeof payload.publicKey !== "string" ||
      typeof payload.nickname !== "string" ||
      payload.publicKey.length > 128 ||
      payload.nickname.length > 80
    ) {
      throw new Error("Invalid peer identity.");
    }
    peer.nickname = sanitizeNickname(payload.nickname);
    peer.remotePublicKeyBytes = fromBase64Url(payload.publicKey);
    if (peer.remotePublicKeyBytes.byteLength !== 65) throw new Error("Invalid peer key.");
    peer.remotePublicKey = await importPeerPublicKey(peer.remotePublicKeyBytes);
    this.publish();
    await this.derivePair(peer);
    if (!peer.madeOffer && this.session.peerId < peer.id) {
      peer.madeOffer = true;
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      const description = peer.connection.localDescription;
      if (!description?.sdp) throw new Error("Could not create offer.");
      const localFingerprint = fingerprintFromSdp(description.sdp);
      peer.localFingerprint = localFingerprint;
      await this.session.sendSignal(peer.id, {
        kind: "offer",
        description: { type: description.type, sdp: description.sdp },
        fingerprint: localFingerprint,
      });
    }
  }

  private async onOffer(peer: PeerState, payload: Record<string, unknown>): Promise<void> {
    const description = parseDescription(payload.description, "offer");
    if (!description) {
      throw new Error("Invalid offer.");
    }
    const fingerprint = fingerprintFromSdp(description.sdp);
    if (fingerprint !== payload.fingerprint) throw new Error("Fingerprint mismatch.");
    peer.remoteFingerprint = fingerprint;
    await peer.connection.setRemoteDescription(description);
    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    const localDescription = peer.connection.localDescription;
    if (!localDescription?.sdp) throw new Error("Could not create answer.");
    const localFingerprint = fingerprintFromSdp(localDescription.sdp);
    peer.localFingerprint = localFingerprint;
    await this.session.sendSignal(peer.id, {
      kind: "answer",
      description: { type: localDescription.type, sdp: localDescription.sdp },
      fingerprint: localFingerprint,
    });
    await this.flushCandidates(peer);
    await this.derivePair(peer);
  }

  private async onAnswer(peer: PeerState, payload: Record<string, unknown>): Promise<void> {
    const description = parseDescription(payload.description, "answer");
    if (!description) {
      throw new Error("Invalid answer.");
    }
    const fingerprint = fingerprintFromSdp(description.sdp);
    if (fingerprint !== payload.fingerprint) throw new Error("Fingerprint mismatch.");
    peer.remoteFingerprint = fingerprint;
    await peer.connection.setRemoteDescription(description);
    await this.flushCandidates(peer);
    await this.derivePair(peer);
  }

  private async onIce(peer: PeerState, payload: Record<string, unknown>): Promise<void> {
    const candidate = parseCandidate(payload.candidate);
    if (!candidate) return;
    if (!peer.connection.remoteDescription) {
      peer.queuedCandidates.push(candidate);
      return;
    }
    await peer.connection.addIceCandidate(candidate);
  }

  private async flushCandidates(peer: PeerState): Promise<void> {
    const candidates = peer.queuedCandidates.splice(0);
    for (const candidate of candidates) await peer.connection.addIceCandidate(candidate);
  }

  private async derivePair(peer: PeerState): Promise<void> {
    if (
      !this.identity ||
      !peer.remotePublicKey ||
      !peer.remotePublicKeyBytes ||
      !peer.localFingerprint ||
      !peer.remoteFingerprint
    ) {
      return;
    }
    const material = await derivePeerMaterial(
      this.identity,
      peer.remotePublicKey,
      this.session.keys.secret,
      peer.remotePublicKeyBytes,
      peer.localFingerprint,
      peer.remoteFingerprint,
    );
    peer.rootKey = material.rootKey;
    peer.sas = material.sas;
    this.tryAttachTransfers(peer);
    this.publish();
  }

  private attachChannel(peer: PeerState, channel: RTCDataChannel): void {
    if (channel.label === "ctrl") peer.ctrl = channel;
    else if (channel.label === "data") peer.data = channel;
    else {
      channel.close();
      return;
    }
    channel.addEventListener("open", () => this.tryAttachTransfers(peer));
    channel.addEventListener("close", () => {
      peer.status = "disconnected";
      this.transfers.cancelPeer(peer.id);
      this.publish();
    });
    this.tryAttachTransfers(peer);
  }

  private tryAttachTransfers(peer: PeerState): void {
    if (
      peer.transferAttached ||
      !peer.rootKey ||
      peer.ctrl?.readyState !== "open" ||
      peer.data?.readyState !== "open"
    ) {
      return;
    }
    peer.transferAttached = true;
    peer.status = "connected";
    this.transfers.attach(peer.id, peer.rootKey, peer.ctrl, peer.data);
    this.publish();
  }

  private publish(): void {
    this.events.onPeers(Array.from(this.peers.values()).map(({ id, nickname, status, sas, verified }) => ({
      id,
      nickname,
      status,
      sas,
      verified,
    })));
  }
}

function fingerprintFromSdp(sdp: string): string {
  const match = sdp.match(/^a=fingerprint:sha-256\s+([0-9A-F:]+)$/im);
  if (!match) throw new Error("Missing DTLS fingerprint.");
  return match[1].replaceAll(":", "").toLowerCase();
}

function parseDescription(
  value: unknown,
  type: "offer" | "answer",
): (RTCSessionDescriptionInit & { type: "offer" | "answer"; sdp: string }) | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    !("sdp" in value) ||
    value.type !== type ||
    typeof value.sdp !== "string" ||
    value.sdp.length > 12_000
  ) {
    return null;
  }
  return { type, sdp: value.sdp };
}

function parseCandidate(value: unknown): RTCIceCandidateInit | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("candidate" in value) ||
    typeof value.candidate !== "string" ||
    value.candidate.length > 2048
  ) {
    return null;
  }
  return {
    candidate: value.candidate,
    sdpMid: "sdpMid" in value && typeof value.sdpMid === "string" ? value.sdpMid : null,
    sdpMLineIndex: "sdpMLineIndex" in value && typeof value.sdpMLineIndex === "number" ? value.sdpMLineIndex : null,
    usernameFragment: "usernameFragment" in value && typeof value.usernameFragment === "string" ? value.usernameFragment : null,
  };
}

export function sanitizeNickname(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40);
  return sanitized || "Guest";
}

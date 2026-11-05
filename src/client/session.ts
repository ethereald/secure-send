import { fromBase64Url, openSignal, sealSignal, type RoomKeys } from "./crypto";

export interface WelcomeMessage {
  type: "welcome";
  peerId: string;
  roster: string[];
  expiresAt: number;
  isLocked: boolean;
}

function parseIceServers(value: unknown): RTCIceServer[] {
  if (!isRecord(value) || !Array.isArray(value.iceServers) || value.iceServers.length < 1 || value.iceServers.length > 11) {
    throw new Error("The room returned invalid connectivity settings.");
  }
  return value.iceServers.map((item) => {
    if (!isRecord(item)) throw new Error("The room returned invalid connectivity settings.");
    const urls = typeof item.urls === "string"
      ? [item.urls]
      : Array.isArray(item.urls) && item.urls.every((url) => typeof url === "string")
        ? item.urls
        : [];
    if (
      urls.length < 1 ||
      urls.length > 10 ||
      urls.some((url) => !/^(stun|stuns|turn|turns):[^\s]{1,2048}$/i.test(url))
    ) {
      throw new Error("The room returned invalid connectivity settings.");
    }
    let username: string | undefined;
    let credential: string | undefined;
    if (item.username !== undefined || item.credential !== undefined) {
      if (
        typeof item.username !== "string" ||
        typeof item.credential !== "string" ||
        item.username.length > 256 ||
        item.credential.length > 512 ||
        !urls.some((url) => /^turns?:/i.test(url))
      ) {
        throw new Error("The room returned invalid connectivity settings.");
      }
      username = item.username;
      credential = item.credential;
    }
    return {
      urls: urls.length === 1 ? urls[0] : urls,
      ...(username !== undefined && credential !== undefined ? { username, credential } : {}),
    };
  });
}

type SessionListener = (message: Record<string, unknown>) => void;

export class RoomSession {
  readonly keys: RoomKeys;
  readonly socket: WebSocket;
  readonly peerId: string;
  readonly welcome: WelcomeMessage;
  readonly iceServers: RTCIceServer[];
  private readonly listeners = new Set<SessionListener>();
  private readonly backlog: Record<string, unknown>[] = [];
  private readonly pendingSignals = new Set<Promise<void>>();

  private constructor(keys: RoomKeys, socket: WebSocket, welcome: WelcomeMessage, iceServers: RTCIceServer[]) {
    this.keys = keys;
    this.socket = socket;
    this.peerId = welcome.peerId;
    this.welcome = welcome;
    this.iceServers = iceServers;
    socket.addEventListener("message", (event: MessageEvent) => void this.onMessage(event));
    socket.addEventListener("close", () => {
      for (const listener of this.listeners) listener({ type: "connection-closed" });
    });
  }

  static async connect(keys: RoomKeys): Promise<RoomSession> {
    let iceResponse: Response;
    try {
      iceResponse = await fetch(`/api/rooms/${encodeURIComponent(keys.roomId)}/ice-config`, { cache: "no-store" });
    } catch {
      throw new Error("Could not load room connectivity settings.");
    }
    if (!iceResponse.ok) {
      throw new Error("Could not load room connectivity settings.");
    }
    let iceServers: RTCIceServer[];
    try {
      iceServers = parseIceServers(await iceResponse.json());
    } catch (error) {
      if (error instanceof Error && error.message === "The room returned invalid connectivity settings.") throw error;
      throw new Error("Could not load room connectivity settings.");
    }

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${scheme}//${location.host}/api/rooms/${encodeURIComponent(keys.roomId)}/ws`,
    );
    const welcome = await new Promise<WelcomeMessage>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("Connection timed out.")), 15_000);
      socket.addEventListener(
        "message",
        (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          let message: unknown;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (isRecord(message) && typeof message.type === "string") {
            const first = message;
            if (first.type === "welcome") {
              window.clearTimeout(timer);
              if (
                typeof first.peerId !== "string" ||
                !Array.isArray(first.roster) ||
                !first.roster.every((id) => typeof id === "string") ||
                typeof first.expiresAt !== "number" ||
                typeof first.isLocked !== "boolean"
              ) {
                reject(new Error("The room returned an invalid response."));
                return;
              }
              resolve({
                type: "welcome",
                peerId: first.peerId,
                roster: first.roster,
                expiresAt: first.expiresAt,
                isLocked: first.isLocked,
              });
            } else if (first.type === "session-ended" || first.type === "kicked") {
              window.clearTimeout(timer);
              reject(new Error(first.type === "kicked" ? "You were removed from the room." : "This room has ended."));
            }
          }
        },
        { once: false },
      );
      socket.addEventListener("error", () => {
        window.clearTimeout(timer);
        reject(new Error("Could not connect to this room."));
      });
      socket.addEventListener("close", () => {
        window.clearTimeout(timer);
        reject(new Error("This room is unavailable, full, locked, or expired."));
      });
    });
    return new RoomSession(keys, socket, welcome, iceServers);
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    for (const message of this.backlog.splice(0)) listener(message);
    return () => this.listeners.delete(listener);
  }

  async sendSignal(to: string, payload: unknown): Promise<void> {
    const sealed = await sealSignal(this.keys.signalKey, payload);
    this.send({ type: "signal", to, sealed });
  }

  send(message: unknown): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("The room connection is closed.");
    this.socket.send(JSON.stringify(message));
  }

  close(keepSecret = false): void {
    this.listeners.clear();
    this.backlog.length = 0;
    this.socket.close(1000, "Left room.");
    if (keepSecret) return;
    this.keys.secret.fill(0);
    sessionStorage.removeItem("secure-send-secret");
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data !== "string") {
      for (const listener of this.listeners) listener({ type: "relay-binary", frame: event.data });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") return;
    const record = message;
    if (record.type === "signal" && typeof record.sealed === "string" && typeof record.from === "string") {
      const task = openSignal<unknown>(this.keys.signalKey, record.sealed)
        .then((payload) => {
          if (!isRecord(payload)) return;
          this.dispatch({ type: "signal", from: record.from, payload });
        })
        .catch(() => undefined);
      this.pendingSignals.add(task);
      void task.finally(() => this.pendingSignals.delete(task));
      return;
    }
    this.dispatch(record);
  }

  private dispatch(message: Record<string, unknown>): void {
    if (this.listeners.size === 0) {
      if (this.backlog.length >= 256) {
        this.backlog.length = 0;
        this.socket.close(1013, "Too many pending room messages.");
        return;
      }
      this.backlog.push(message);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function secretFromLocation(): Uint8Array | null {
  const fragment = location.hash.slice(1) || sessionStorage.getItem("secure-send-secret") || "";
  if (!fragment) return null;
  try {
    const secret = fromBase64Url(fragment);
    return secret.byteLength === 32 ? secret : null;
  } catch {
    return null;
  }
}

export function stripSecretFromAddressBar(): void {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

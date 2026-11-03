import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import QRCode from "qrcode";
import {
  deriveRoomKeys,
  generateHostKeyPair,
  signHostAction,
  toBase64Url,
} from "./crypto";
import { deleteHostPrivateKey, loadHostPrivateKey, saveHostPrivateKey } from "./host-key-store";
import { PeerMesh, type PeerView } from "./peers";
import { RoomSession, secretFromLocation, stripSecretFromAddressBar } from "./session";
import type { IncomingFileOffer } from "./transfer";
import { isIosLike, onFileReady, saveReadyFile, type ReadyFile } from "./download-sink";
import "./style.css";

interface AppConfig {
  turnstileSiteKey: string;
  devMode?: boolean;
}

interface RoomState {
  session: RoomSession;
  mesh: PeerMesh;
  hostKey: CryptoKey | null;
  inviteUrl: string | null;
  expiresAt: number;
  locked: boolean;
}

interface RejoinParams {
  keys: Awaited<ReturnType<typeof deriveRoomKeys>>;
  name: string;
  hostKey: CryptoKey | null;
  inviteUrl: string | null;
}

const ADJECTIVES = ["Swift", "Quiet", "Brave", "Lucky", "Calm", "Bright", "Clever", "Gentle", "Misty", "Sunny", "Cosmic", "Nimble"];
const ANIMALS = ["Otter", "Falcon", "Panda", "Fox", "Heron", "Lynx", "Koala", "Orca", "Robin", "Gecko", "Badger", "Dolphin"];

function randomNickname(): string {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2));
  return `${ADJECTIVES[a % ADJECTIVES.length]} ${ANIMALS[b % ANIMALS.length]}`;
}

interface TransferProgress {
  key: string;
  peerId: string;
  name: string;
  percent: number;
  direction: "send" | "receive";
}

declare global {
  interface Window {
    turnstile?: {
      render(element: HTMLElement, options: Record<string, unknown>): string;
      remove(widgetId: string): void;
    };
  }
}

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let turnstileScriptPromise: Promise<void> | null = null;

function TurnstileWidget(props: {
  siteKey: string;
  onToken(token: string): void;
  onError(message: string): void;
}): preact.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    let widgetId: string | undefined;
    if (!props.siteKey || !element.current) return;
    void loadTurnstile().then(() => {
      if (!active || !element.current || !window.turnstile) return;
      widgetId = window.turnstile.render(element.current, {
        sitekey: props.siteKey,
        action: "create-room",
        callback: (token: string) => props.onToken(token),
        "expired-callback": () => props.onToken(""),
        "error-callback": () => props.onToken(""),
      });
    }).catch(() => props.onError("Could not load the anti-abuse check. Reload the page and try again."));
    return () => {
      active = false;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [props.siteKey, props.onError]);
  return <div ref={element} class="turnstile" />;
}

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error("Could not load the abuse-prevention check."));
    };
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

function App(): preact.JSX.Element {
  const [config, setConfig] = useState<AppConfig>({ turnstileSiteKey: "" });
  const [joinKeys, setJoinKeys] = useState<Awaited<ReturnType<typeof deriveRoomKeys>> | null>(null);
  const [isInvite, setIsInvite] = useState(false);
  const [nickname, setNickname] = useState(randomNickname);
  const [ttlSec, setTtlSec] = useState(30 * 60);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [offers, setOffers] = useState<IncomingFileOffer[]>([]);
  const [progress, setProgress] = useState<TransferProgress[]>([]);
  const [readyFiles, setReadyFiles] = useState<ReadyFile[]>([]);
  useEffect(() => onFileReady((ready) => setReadyFiles((current) => [...current, ready])), []);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedPeer = useRef<string | null>(null);
  const rejoinParams = useRef<RejoinParams | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  const peersRef = useRef<PeerView[]>([]);
  const rejoining = useRef(false);
  const hiddenAt = useRef(0);
  roomRef.current = room;
  peersRef.current = peers;

  async function rejoin(): Promise<void> {
    const params = rejoinParams.current;
    if (!params || rejoining.current) return;
    rejoining.current = true;
    setNotice("Reconnecting…");
    try {
      roomRef.current?.mesh.leave(true);
      setPeers([]);
      setOffers([]);
      setProgress([]);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await enterRoom(params.keys, params.name, params.hostKey, params.inviteUrl, 0, false);
          setNotice("Reconnected.");
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (/removed|ended/.test(message)) throw error;
          await new Promise((resolve) => window.setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      throw new Error("Could not reconnect. Reopen the invite link to rejoin.");
    } catch (error) {
      rejoinParams.current = null;
      setRoom(null);
      setPeers([]);
      setNotice(error instanceof Error ? error.message : "The room connection was lost.");
    } finally {
      rejoining.current = false;
    }
  }

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      const current = roomRef.current;
      if (!current || !rejoinParams.current) return;
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = 0;
      const socketDead = current.session.socket.readyState !== WebSocket.OPEN;
      const peerDown = peersRef.current.some((peer) => peer.status === "disconnected");
      // iOS silently kills sockets and WebRTC while a tab is backgrounded, without reliable close events.
      if (socketDead || peerDown || (isIosLike() && away > 3000)) void rejoin();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
    };
  }, []);

  useEffect(() => {
    void fetch("/api/config")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load application settings.");
        const result = await response.json() as AppConfig;
        setConfig(result);
      })
      .catch(() => setNotice("The application server is unavailable."));

    const secret = secretFromLocation();
    if (secret) {
      stripSecretFromAddressBar();
      sessionStorage.setItem("secure-send-secret", toBase64Url(secret));
      setIsInvite(true);
      void deriveRoomKeys(secret)
        .then(setJoinKeys)
        .catch(() => setNotice("This invite link is invalid."));
    } else if (location.hash) {
      stripSecretFromAddressBar();
      setNotice("This invite link is invalid.");
    }
  }, []);

  useEffect(() => {
    if (!room) return;
    const timer = window.setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((room.expiresAt - Date.now()) / 1000)));
    }, 1000);
    setSecondsLeft(Math.max(0, Math.ceil((room.expiresAt - Date.now()) / 1000)));
    return () => window.clearInterval(timer);
  }, [room?.expiresAt]);

  async function createRoom(event: Event): Promise<void> {
    event.preventDefault();
    if (!nickname.trim()) return setNotice("Choose a nickname before creating a room.");
    if (!turnstileToken && !config.devMode) return setNotice("Complete the anti-abuse check first.");
    setBusy(true);
    setNotice("");
    let roomId = "";
    let secret: Uint8Array | null = null;
    try {
      secret = crypto.getRandomValues(new Uint8Array(32));
      const keys = await deriveRoomKeys(secret);
      roomId = keys.roomId;
      sessionStorage.setItem("secure-send-secret", toBase64Url(secret));
      const hostKeys = await generateHostKeyPair();
      const hostPubKey = await crypto.subtle.exportKey("jwk", hostKeys.publicKey);
      await saveHostPrivateKey(roomId, hostKeys.privateKey);
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, hostPubKey, ttlSec, turnstileToken }),
      });
      const result = await response.json() as { expiresAt?: number; error?: string };
      if (!response.ok || typeof result.expiresAt !== "number") {
        throw new Error(result.error ?? "Could not create the room.");
      }
      const invite = new URL(location.href);
      invite.hash = toBase64Url(secret);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      await enterRoom(keys, nickname, hostKeys.privateKey, invite.href, result.expiresAt, false);
    } catch (error) {
      sessionStorage.removeItem("secure-send-secret");
      if (roomId) await deleteHostPrivateKey(roomId).catch(() => undefined);
      setNotice(error instanceof Error ? error.message : "Could not create the room.");
    } finally {
      secret?.fill(0);
      setBusy(false);
      setTurnstileToken("");
    }
  }

  async function joinRoom(event: Event): Promise<void> {
    event.preventDefault();
    if (!joinKeys) return setNotice("Open a valid invite link to join a room.");
    if (!nickname.trim()) return setNotice("Choose a nickname before joining.");
    setBusy(true);
    setNotice("");
    try {
      await enterRoom(joinKeys, nickname, null, null, 0, true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not join this room.");
    } finally {
      setBusy(false);
    }
  }

  async function enterRoom(
    keys: Awaited<ReturnType<typeof deriveRoomKeys>>,
    name: string,
    knownHostKey: CryptoKey | null,
    inviteUrl: string | null,
    expiresAt: number,
    joinExisting: boolean,
  ): Promise<void> {
    const session = await RoomSession.connect(keys);
    let hostKey = knownHostKey;
    let hostKeyWarning = "";
    if (!hostKey) {
      try {
        hostKey = await loadHostPrivateKey(keys.roomId);
      } catch {
        hostKeyWarning = "This browser could not load host controls from local key storage.";
      }
    }
    const actualExpiry = expiresAt || session.welcome.expiresAt;
    let mesh: PeerMesh;
    mesh = new PeerMesh(session, name, {
      onPeers: (next) => {
        setPeers(next);
        setOffers((current) => current.filter((offer) => next.some((peer) => peer.id === offer.from)));
      },
      onIncoming: (offer) => setOffers((current) => [...current.filter((item) => item.id !== offer.id), offer]),
      onProgress: (peerId, filename, percent, direction) => {
        const key = `${peerId}:${filename}:${direction}`;
        setProgress((current) => {
          const next = current.filter((entry) => entry.key !== key);
          return [...next, { key, peerId, name: filename, percent, direction }];
        });
      },
      onMessage: (peerId, message) => setNotice(message),
      onRoomEvent: (message) => {
        if (message.type === "ttl-updated" && typeof message.expiresAt === "number") {
          const expiresAt = message.expiresAt;
          setRoom((current) => current ? { ...current, expiresAt } : current);
        } else if (message.type === "room-lock-updated" && typeof message.isLocked === "boolean") {
          const locked = message.isLocked;
          setRoom((current) => current ? { ...current, locked } : current);
        } else if (message.type === "host-action-error" && typeof message.message === "string") {
          setNotice(message.message);
        } else if (message.type === "session-ended" || message.type === "kicked") {
          rejoinParams.current = null;
          mesh.leave();
          setRoom(null);
          setPeers([]);
          setNotice(message.type === "kicked" ? "You were removed from the room." : "This room has ended.");
        } else if (message.type === "connection-closed") {
          if (rejoinParams.current) {
            void rejoin();
          } else {
            mesh.leave();
            setRoom(null);
            setPeers([]);
            setNotice("The room connection was lost. Reopen the invite link to rejoin.");
          }
        } else if (message.type === "close") {
          setNotice("The room connection was closed.");
        }
      },
    });
    await mesh.start();
    rejoinParams.current = { keys, name, hostKey, inviteUrl };
    setJoinKeys(null);
    setIsInvite(false);
    setRoom({
      session,
      mesh,
      hostKey,
      inviteUrl,
      expiresAt: actualExpiry,
      locked: session.welcome.isLocked,
    });
    setNotice(
      hostKeyWarning ||
      (joinExisting ? "Connected. Verify the short codes with your peer before sharing sensitive files." : ""),
    );
  }

  async function doHostAction(action: string, args: Record<string, unknown>): Promise<void> {
    if (!room?.hostKey) return setNotice("Host controls are only available in the creating browser.");
    setNotice("");
    try {
      await new Promise<void>((resolve, reject) => {
        let sent = false;
        let unsubscribe: () => void = () => {};
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          unsubscribe();
          if (error) reject(error);
          else resolve();
        };
        const timeout = window.setTimeout(() => finish(new Error("Host action timed out.")), 10_000);
        unsubscribe = room.session.subscribe((message) => {
          if (message.type === "host-challenge" && typeof message.nonce === "string" && !sent) {
            const challengeNonce = message.nonce;
            sent = true;
            void signHostAction(room.hostKey!, challengeNonce, action, args).then((signature) => {
              room.session.send({ type: "host-action", action, args, nonce: challengeNonce, signature });
            }).catch((error: unknown) => finish(error instanceof Error ? error : new Error("Host signing failed.")));
          } else if (message.type === "host-action-ok" && message.action === action) {
            finish();
          } else if (message.type === "host-action-error") {
            finish(new Error(String(message.message ?? "Host action failed.")));
          }
        });
        try {
          room.session.send({ type: "host-challenge-request" });
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Could not request host authorization."));
        }
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Host action failed.");
    }
  }

  async function handleSelectedFiles(files: FileList | null): Promise<void> {
    const peerId = selectedPeer.current;
    if (!room || !peerId || !files?.length) return;
    try {
      await room.mesh.sendFiles(peerId, files);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The file transfer failed.");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function leaveRoom(): Promise<void> {
    if (!room) return;
    rejoinParams.current = null;
    room.mesh.leave();
    setRoom(null);
    setPeers([]);
    setOffers([]);
    setProgress([]);
    setNotice("You left the room.");
  }

  function copyInvite(): void {
    if (!room?.inviteUrl) return;
    void navigator.clipboard.writeText(room.inviteUrl)
      .then(() => setNotice("Invite link copied. Share it only with people you trust."))
      .catch(() => setNotice("Could not copy the invite link. Select and copy it manually."));
  }

  if (room) {
    return (
      <main class="shell">
        <header class="topbar">
          <a class="brand" href="/">Secure<span>Send</span></a>
          <div class="top-actions">
            <span class={`room-state ${secondsLeft ? "" : "expired"}`}>
              {secondsLeft ? `Expires in ${formatDuration(secondsLeft)}` : "Expired"}
            </span>
            <button class="button subtle" onClick={() => void leaveRoom()}>Leave room</button>
          </div>
        </header>
        <section class="room-layout">
          <div class="room-main">
            <div class="section-heading">
              <div>
                <p class="eyebrow">PRIVATE ROOM</p>
                <h1>Your devices, directly connected.</h1>
                <p class="muted">Files are encrypted in your browser and sent peer-to-peer. The room server never receives file contents.</p>
              </div>
              <span class="peer-count">{peers.length + 1} / 4 devices</span>
            </div>
            {notice && <div class="notice" role="status">{notice}</div>}
            <div class="peer-grid">
              <article class="peer-card self-card">
                <div class="avatar">{initials(nickname)}</div>
                <div class="peer-info"><strong>{nickname || "You"}</strong><span>You · this device</span></div>
                <span class="status-dot online" title="Connected" />
              </article>
              {peers.map((peer) => (
                <article class="peer-card" key={peer.id}>
                  <div class="avatar">{initials(peer.nickname)}</div>
                  <div class="peer-info">
                    <strong>{peer.nickname}</strong>
                    <span>{peer.status === "connected" ? "Secure connection" : "Connecting…"}</span>
                    {peer.sas && (
                      <div class="sas">
                        <span>Compare code: <b>{peer.sas}</b></span>
                        <label class="verify-label">
                          <input
                            type="checkbox"
                            checked={peer.verified}
                            onChange={(event) => {
                              const checked = (event.currentTarget as HTMLInputElement).checked;
                              room.mesh.setVerified(peer.id, checked);
                            }}
                          />
                          I compared it
                        </label>
                      </div>
                    )}
                  </div>
                  <div class="peer-actions">
                    <button
                      class="button small"
                      disabled={peer.status !== "connected"}
                      onClick={() => {
                        selectedPeer.current = peer.id;
                        fileInput.current?.click();
                      }}
                    >
                      Send files
                    </button>
                    {room.hostKey && <button class="icon-button" title="Remove device" onClick={() => void doHostAction("kick", { peerId: peer.id })}>×</button>}
                  </div>
                </article>
              ))}
              {peers.length === 0 && (
                <div class="empty-card">
                  <div class="pulse-icon">↗</div>
                  <strong>Waiting for someone to join</strong>
                  <span>Create a room, then share its private link or QR code.</span>
                </div>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => void handleSelectedFiles((event.currentTarget as HTMLInputElement).files)}
            />
            {offers.length > 0 && (
              <section class="incoming-list" aria-live="polite">
                <h2>Incoming file requests</h2>
                {offers.map((offer) => (
                  <IncomingOffer
                    key={offer.id}
                    offer={offer}
                    peer={peers.find((peer) => peer.id === offer.from)?.nickname ?? "A device"}
                    onRemove={() => setOffers((current) => current.filter((item) => item.id !== offer.id))}
                  />
                ))}
              </section>
            )}
            {readyFiles.length > 0 && (
              <section class="incoming-list" aria-live="polite">
                <h2>Ready to save</h2>
                {readyFiles.map((ready, index) => (
                  <div class="progress-row" key={`${ready.name}:${index}`}>
                    <span>{ready.name}</span>
                    <button
                      class="button primary small"
                      onClick={() => {
                        void saveReadyFile(ready).then(() =>
                          setReadyFiles((current) => current.filter((item) => item !== ready)),
                        );
                      }}
                    >
                      Save
                    </button>
                  </div>
                ))}
              </section>
            )}
            {progress.length > 0 && (
              <section class="progress-list">
                <h2>Transfers</h2>
                {progress.map((item) => (
                  <div class="progress-row" key={item.key}>
                    <span>{item.direction === "send" ? "Sending" : "Receiving"} {item.name}</span>
                    <span>{item.percent}%</span>
                    <div class="progress-track"><div style={{ width: `${item.percent}%` }} /></div>
                  </div>
                ))}
              </section>
            )}
          </div>
          <aside class="room-sidebar">
            {room.inviteUrl ? (
              <section class="panel share-panel">
                <p class="eyebrow">INVITE A DEVICE</p>
                <h2>Share this room</h2>
                <QrCode value={room.inviteUrl} />
                <button class="button primary wide" onClick={copyInvite}>Copy private invite</button>
                <p class="fine-print">Anyone with this link can join. Downloads follow browser settings; iOS may require “Save to Files”.</p>
              </section>
            ) : (
              <section class="panel">
                <p class="eyebrow">ROOM LINK</p>
                <h2>You joined as a guest</h2>
                <p class="muted">Ask the room host to share the invite link with another device.</p>
              </section>
            )}
            {room.hostKey && (
              <section class="panel host-panel">
                <p class="eyebrow">HOST CONTROLS</p>
                <h2>Manage this room</h2>
                <button class="button secondary wide" onClick={() => void doHostAction("set-ttl", { expiresAt: room.expiresAt + 30 * 60 * 1000 })}>Extend by 30 minutes</button>
                <button class="button secondary wide" onClick={() => void doHostAction("set-ttl", { expiresAt: Date.now() + 30 * 60 * 1000 })}>Set expiry to 30 minutes from now</button>
                <button class="button secondary wide" onClick={() => void doHostAction(room.locked ? "unlock" : "lock", {})}>
                  {room.locked ? "Unlock room" : "Lock new joins"}
                </button>
                <button
                  class="button danger wide"
                  onClick={() => {
                    if (window.confirm("End the room for every connected device?")) {
                      void doHostAction("end-session", {});
                    }
                  }}
                >
                  End session for everyone
                </button>
                <p class="fine-print">Host permissions are verified by a signing key saved on this browser.</p>
              </section>
            )}
            <section class="safety-note">
              <span class="lock-icon">⌑</span>
              <div><strong>End-to-end encrypted</strong><p>Compare the short code in person or over a trusted call to check for a relayed connection.</p></div>
            </section>
          </aside>
        </section>
        <footer class="footer">Keep your invite private · Files are never stored on our servers.</footer>
      </main>
    );
  }

  return (
    <main class="landing">
      <nav class="topbar">
        <a class="brand" href="/">Secure<span>Send</span></a>
        <span class="top-note">Private file sharing, device to device</span>
      </nav>
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">NO CLOUD STORAGE. NO COMPROMISE.</p>
          <h1>Send files.<br /><span>Not your privacy.</span></h1>
          <p class="hero-text">A private, encrypted connection between your devices. Your files travel directly between browsers — never through a file-storage server.</p>
          <div class="trust-points">
            <span><i>✓</i> End-to-end encrypted</span>
            <span><i>✓</i> No account required</span>
            <span><i>✓</i> Files are never stored</span>
          </div>
        </div>
        <div class="form-card">
          <div class="card-icon">↗</div>
          <p class="eyebrow">{isInvite ? "YOU'RE INVITED" : "START A PRIVATE ROOM"}</p>
          <h2>{isInvite ? "Join the room" : "Create a secure room"}</h2>
          <p class="muted">{isInvite ? "Choose a name so others can recognize your device." : "Choose who you share with. You can end the room at any time."}</p>
          {notice && <div class="notice" role="status">{notice}</div>}
          <form onSubmit={(event) => void (isInvite ? joinRoom(event) : createRoom(event))}>
            <label class="field-label" for="nickname">Your device name</label>
            <input
              id="nickname"
              class="text-input"
              maxlength={40}
              placeholder="e.g. Alex's Laptop"
              value={nickname}
              onInput={(event) => setNickname((event.currentTarget as HTMLInputElement).value)}
              required
            />
            {!isInvite && (
              <>
                <label class="field-label" for="ttl">Room duration</label>
                <select id="ttl" class="text-input" value={ttlSec} onChange={(event) => setTtlSec(Number((event.currentTarget as HTMLSelectElement).value))}>
                  <option value={300}>5 minutes</option>
                  <option value={1800}>30 minutes</option>
                  <option value={3600}>1 hour</option>
                  <option value={21600}>6 hours</option>
                  <option value={86400}>24 hours</option>
                </select>
                {config.devMode ? (
                  <p class="setup-warning">Local dev mode: anti-abuse check disabled.</p>
                ) : config.turnstileSiteKey ? (
                  <TurnstileWidget siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} onError={setNotice} />
                ) : (
                  <p class="setup-warning">Room creation is disabled until the Cloudflare Turnstile site key is configured.</p>
                )}
              </>
            )}
            <button class="button primary wide submit-button" disabled={busy || (!isInvite && !config.devMode && (!config.turnstileSiteKey || !turnstileToken))}>
              {busy ? "Connecting…" : isInvite ? "Join securely" : "Create private room"}
            </button>
          </form>
          {isInvite && <p class="fine-print centered">The link secret stays in your browser and is never sent to the server.</p>}
        </div>
      </section>
      <section class="how-it-works">
        <h2>Built for privacy from the first click.</h2>
        <div class="how-grid">
          <div><b>01</b><strong>Make a room</strong><p>Get a one-time private link and QR code. No sign-up needed.</p></div>
          <div><b>02</b><strong>Connect directly</strong><p>Devices establish a peer-to-peer connection protected with encryption.</p></div>
          <div><b>03</b><strong>Choose what to send</strong><p>Every transfer requires the receiver's approval. Files stay off our servers.</p></div>
        </div>
      </section>
      <footer class="footer">Secure Send · Private by design</footer>
    </main>
  );
}

function IncomingOffer(props: {
  offer: IncomingFileOffer;
  peer: string;
  onRemove(): void;
}): preact.JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <article class="offer-card">
      <div>
        <strong>{props.offer.name}</strong>
        <span>{props.peer} wants to send · {formatBytes(props.offer.size)}</span>
      </div>
      <button
        class="button primary small"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void props.offer.accept().then(props.onRemove).catch(() => {
            props.offer.decline();
            props.onRemove();
          });
        }}
      >
        {busy ? "Preparing…" : "Accept"}
      </button>
      <button class="button subtle small" onClick={() => { props.offer.decline(); props.onRemove(); }}>Decline</button>
    </article>
  );
}

function QrCode(props: { value: string }): preact.JSX.Element {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(props.value, { width: 220, margin: 1, errorCorrectionLevel: "M" })
      .then((result) => { if (active) setSrc(result); })
      .catch(() => { if (active) setSrc(""); });
    return () => { active = false; };
  }, [props.value]);
  return src ? <img class="qr-code" src={src} alt="QR code for the private room invite" /> : <div class="qr-placeholder">Preparing QR code…</div>;
}

function initials(name: string): string {
  return name
    .split(/[\s'-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "?";
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

render(<App />, document.getElementById("app")!);

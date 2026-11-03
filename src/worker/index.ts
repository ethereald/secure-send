import { Room } from "./room";
import {
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  ROOM_ID_PATTERN,
  isRecord,
  jsonResponse,
  validHostPublicKey,
} from "./protocol";

export { Room };

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace;
  CREATE_LIMITER?: RateLimitBinding;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  DEV_MODE?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://challenges.cloudflare.com wss: stun:; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function verifyTurnstile(token: unknown, request: Request, env: Env): Promise<boolean> {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 2048 ||
    !env.TURNSTILE_SECRET
  ) {
    return false;
  }
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
  });
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) body.set("remoteip", remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return false;
  const result: unknown = await response.json();
  return (
    isRecord(result) &&
    result.success === true &&
    result.hostname === new URL(request.url).hostname &&
    result.action === "create-room"
  );
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const dev = env.DEV_MODE === "1";
  if (!dev) {
    if (!env.CREATE_LIMITER || !env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY) {
      return jsonResponse({ error: "Room creation is not configured." }, 503);
    }
    const remoteIp = request.headers.get("CF-Connecting-IP");
    if (!remoteIp) return jsonResponse({ error: "Room creation is unavailable." }, 503);
    const limit = await env.CREATE_LIMITER.limit({ key: remoteIp });
    if (!limit.success) return jsonResponse({ error: "Too many requests." }, 429);
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > 8192) return jsonResponse({ error: "Invalid room request." }, 400);
  const rawBody = await request.text();
  if (rawBody.length > 8192) return jsonResponse({ error: "Invalid room request." }, 400);
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = null;
  }
  if (
    !isRecord(body) ||
    typeof body.roomId !== "string" ||
    !ROOM_ID_PATTERN.test(body.roomId) ||
    !validHostPublicKey(body.hostPubKey) ||
    typeof body.ttlSec !== "number" ||
    !Number.isInteger(body.ttlSec) ||
    body.ttlSec < MIN_TTL_SECONDS ||
    body.ttlSec > MAX_TTL_SECONDS ||
    !(dev || (await verifyTurnstile(body.turnstileToken, request, env)))
  ) {
    return jsonResponse({ error: "Invalid room request." }, 400);
  }

  const roomId = body.roomId;
  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  const response = await stub.fetch("https://room.internal/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostPubKey: body.hostPubKey, ttlSec: body.ttlSec }),
  });
  return response;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/config" && request.method === "GET") {
    return jsonResponse({
      turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? "",
      devMode: env.DEV_MODE === "1",
    });
  }
  if (url.pathname === "/api/rooms" && request.method === "POST") {
    return createRoom(request, env);
  }
  const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{22})\/ws$/);
  if (match && request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    if (request.headers.get("Origin") !== url.origin) {
      return jsonResponse({ error: "Not found." }, 404);
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(match[1]));
    return stub.fetch(request);
  }
  if (url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "Not found." }, 404);
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withSecurityHeaders(await route(request, env));
    } catch {
      console.error("Request failed.");
      return withSecurityHeaders(jsonResponse({ error: "Request failed." }, 500));
    }
  },
};

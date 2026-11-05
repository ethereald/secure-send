export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const MAX_SIGNAL_BYTES = 16 * 1024;
export const MIN_TTL_SECONDS = 5 * 60;
export const MAX_TTL_SECONDS = 24 * 60 * 60;
export const MAX_PEERS = 4;

export interface HostPublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  ext?: boolean;
  key_ops?: string[];
}

export interface RoomMetadata {
  hostPubKey: HostPublicKey;
  createdAt: number;
  expiresAt: number;
  locked: boolean;
  joined: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validHostPublicKey(value: unknown): value is HostPublicKey {
  return (
    isRecord(value) &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" &&
    value.x.length <= 64 &&
    typeof value.y === "string" &&
    value.y.length <= 64
  );
}

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

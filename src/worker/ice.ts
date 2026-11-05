export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const CLOUDFLARE_TURN_URL = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

export async function createIceServers(
  turnKeyId: string | undefined,
  apiToken: string | undefined,
  roomId: string,
  request: typeof fetch = fetch,
): Promise<IceServerConfig[]> {
  const keyId = turnKeyId?.trim();
  const token = apiToken?.trim();
  if (!keyId && !token) return [{ urls: "stun:stun.cloudflare.com:3478" }];
  if (!keyId || !token) throw new Error("Cloudflare TURN is not fully configured.");

  const response = await request(
    `${CLOUDFLARE_TURN_URL}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ttl: TURN_CREDENTIAL_TTL_SECONDS,
        customIdentifier: roomId,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status !== 201) throw new Error("Cloudflare TURN credential generation failed.");

  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("iceServers" in result) ||
    !Array.isArray(result.iceServers) ||
    result.iceServers.length < 1 ||
    result.iceServers.length > 11
  ) {
    throw new Error("Cloudflare returned invalid ICE settings.");
  }

  return result.iceServers.map((item: unknown) => {
    if (typeof item !== "object" || item === null || !("urls" in item)) {
      throw new Error("Cloudflare returned invalid ICE settings.");
    }
    const config = item as Record<string, unknown>;
    const urls = typeof config.urls === "string"
      ? [config.urls]
      : Array.isArray(config.urls) && config.urls.every((url) => typeof url === "string")
        ? config.urls
        : [];
    if (
      urls.length < 1 ||
      urls.length > 10 ||
      urls.some((url) => !/^(stun|stuns|turn|turns):[^\s]{1,2048}$/i.test(url))
    ) {
      throw new Error("Cloudflare returned invalid ICE settings.");
    }

    if (config.username === undefined && config.credential === undefined) {
      return { urls: urls.length === 1 ? urls[0] : urls };
    }
    if (
      typeof config.username !== "string" ||
      config.username.length < 1 ||
      config.username.length > 256 ||
      typeof config.credential !== "string" ||
      config.credential.length < 1 ||
      config.credential.length > 512 ||
      !urls.some((url) => /^turns?:/i.test(url))
    ) {
      throw new Error("Cloudflare returned invalid ICE settings.");
    }
    return {
      urls: urls.length === 1 ? urls[0] : urls,
      username: config.username,
      credential: config.credential,
    };
  });
}

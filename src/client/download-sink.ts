const MAX_BLOB_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export interface ReadyFile {
  name: string;
  file: File;
}

type ReadyListener = (ready: ReadyFile) => void;
const readyListeners = new Set<ReadyListener>();

// iOS only allows saving from a user gesture, so buffered files are handed to the UI instead of auto-downloaded.
export function onFileReady(listener: ReadyListener): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

export function isIosLike(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export async function saveReadyFile(ready: ReadyFile, allowShare = true): Promise<void> {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (allowShare && nav.canShare?.({ files: [ready.file] })) {
    try {
      await navigator.share({ files: [ready.file] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(ready.file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = ready.name;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface DownloadSink {
  write(bytes: ArrayBuffer): Promise<void>;
  close(): void;
  abort(reason: string): void;
}

export async function beginDownload(
  transferId: string,
  filename: string,
  expectedSize: number,
): Promise<DownloadSink> {
  const safeName = sanitizeFilename(filename);
  const ios = isIosLike();
  if ("serviceWorker" in navigator && !ios) {
    try {
      const registration = await navigator.serviceWorker.register("/download-sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (await waitForController()) {
        return await beginStreamDownload(transferId, safeName, registration.active);
      }
    } catch {
      // Service workers fail on untrusted certificates; use the in-memory Blob path instead.
    }
  }
  if (expectedSize > MAX_BLOB_DOWNLOAD_BYTES) {
    throw new Error("This browser cannot stream large downloads. Try a current desktop browser.");
  }
  return beginBlobDownload(transferId, safeName, expectedSize, ios);
}

function waitForController(): Promise<boolean> {
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve(Boolean(navigator.serviceWorker.controller));
    }, 5000);
    const onChange = () => {
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve(Boolean(navigator.serviceWorker.controller));
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
  });
}

function beginStreamDownload(
  transferId: string,
  filename: string,
  worker: ServiceWorker | null,
): Promise<DownloadSink> {
  const controller = navigator.serviceWorker.controller;
  if (!controller || !worker) throw new Error("The download service is not ready. Reload and try again.");
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let started = false;
    const pendingAcks: Array<{ resolve(): void; reject(error: Error): void; timer: number }> = [];
    let failed = false;
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error("The download could not be started."));
    }, 10_000);
    channel.port1.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "ack") {
        const ack = pendingAcks.shift();
        if (ack) {
          window.clearTimeout(ack.timer);
          ack.resolve();
        }
        return;
      }
      if (event.data?.type === "cancelled" || event.data?.type === "error") {
        failed = true;
        const error = new Error(String(event.data.message ?? "The download was cancelled."));
        for (const ack of pendingAcks.splice(0)) {
          window.clearTimeout(ack.timer);
          ack.reject(error);
        }
        if (!started) reject(error);
        return;
      }
      if (event.data?.type !== "ready") {
        return;
      }
      window.clearTimeout(timeout);
      if (!started) {
        started = true;
        // An <a download> click can bypass the service worker; navigating an iframe always goes through it.
        const frame = document.createElement("iframe");
        frame.hidden = true;
        frame.src = `/__download/${encodeURIComponent(transferId)}`;
        document.body.appendChild(frame);
        window.setTimeout(() => frame.remove(), 60_000);
      }
      resolve({
        write(bytes) {
          if (failed) return Promise.reject(new Error("The download stream is closed."));
          const acknowledged = new Promise<void>((ackResolve, ackReject) => {
            const timer = window.setTimeout(() => {
              const index = pendingAcks.findIndex((entry) => entry.resolve === ackResolve);
              if (index >= 0) pendingAcks.splice(index, 1);
              ackReject(new Error("The download stream stopped responding."));
            }, 30_000);
            pendingAcks.push({ resolve: ackResolve, reject: ackReject, timer });
          });
          channel.port1.postMessage({ type: "chunk", bytes }, [bytes]);
          return acknowledged;
        },
        close() {
          failed = true;
          channel.port1.postMessage({ type: "close" });
          channel.port1.close();
        },
        abort(reason) {
          failed = true;
          channel.port1.postMessage({ type: "error", message: reason });
          for (const ack of pendingAcks.splice(0)) {
            window.clearTimeout(ack.timer);
            ack.reject(new Error(reason));
          }
          channel.port1.close();
        },
      });
    };
    controller.postMessage(
      { type: "register-download", id: transferId, filename, port: channel.port2 },
      [channel.port2],
    );
  });
}

function beginBlobDownload(
  transferId: string,
  filename: string,
  expectedSize: number,
  needsGesture: boolean,
): Promise<DownloadSink> {
  const chunks: BlobPart[] = [];
  let received = 0;
  return Promise.resolve({
    async write(bytes) {
      received += bytes.byteLength;
      if (received > MAX_BLOB_DOWNLOAD_BYTES) {
        throw new Error("The download exceeded the supported size.");
      }
      chunks.push(bytes);
    },
    close() {
      const file = new File(chunks, filename, { type: "application/octet-stream" });
      chunks.length = 0;
      if (needsGesture) {
        for (const listener of readyListeners) listener({ name: filename, file });
        return;
      }
      void saveReadyFile({ name: filename, file }, false);
    },
    abort() {
      chunks.length = 0;
    },
  });
}

export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+$/, "file")
    .trim()
    .slice(0, 180);
  return cleaned || "download";
}

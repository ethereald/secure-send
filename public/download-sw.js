const streams = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  const port = event.ports[0];
  if (
    !data ||
    data.type !== "register-download" ||
    typeof data.id !== "string" ||
    typeof data.filename !== "string" ||
    !port
  ) {
    return;
  }
  if (streams.has(data.id)) {
    port.postMessage({ type: "error", message: "Download already exists." });
    port.close();
    return;
  }
  const registration = { filename: data.filename, port, timer: 0 };
  registration.timer = setTimeout(() => {
    streams.delete(data.id);
    port.postMessage({ type: "error", message: "Download was not started." });
    port.close();
  }, 60_000);
  port.onmessage = (message) => {
    if (message.data?.type === "error" || message.data?.type === "cancelled") {
      clearTimeout(registration.timer);
      streams.delete(data.id);
      port.close();
    }
  };
  streams.set(data.id, registration);
  port.postMessage({ type: "ready" });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/__download\/([A-Za-z0-9_-]{20,30})$/);
  if (!match) return;
  const stream = streams.get(match[1]);
  if (!stream) {
    event.respondWith(new Response("Download expired.", { status: 404 }));
    return;
  }
  streams.delete(match[1]);
  clearTimeout(stream.timer);
  const pending = [];
  let waitingForRead = false;
  let isClosed = false;
  let timer;
  const body = new ReadableStream({
    start(controller) {
      timer = setTimeout(() => controller.error(new Error("Transfer timed out.")), 60 * 60 * 1000);
      stream.port.onmessage = (message) => {
        const data = message.data;
        if (data?.type === "chunk" && data.bytes instanceof ArrayBuffer) {
          const chunk = new Uint8Array(data.bytes);
          if (waitingForRead) {
            waitingForRead = false;
            controller.enqueue(chunk);
            stream.port.postMessage({ type: "ack" });
          } else {
            pending.push(chunk);
          }
        } else if (data?.type === "close") {
          isClosed = true;
          if (!pending.length) {
            clearTimeout(timer);
            controller.close();
            stream.port.close();
          }
        } else if (data?.type === "error") {
          clearTimeout(timer);
          controller.error(new Error(data.message || "Transfer failed."));
          stream.port.close();
        }
      };
      stream.port.start();
      event.request.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        stream.port.close();
      }, { once: true });
    },
    pull(controller) {
      if (pending.length) {
        controller.enqueue(pending.shift());
        stream.port.postMessage({ type: "ack" });
      } else if (isClosed) {
        clearTimeout(timer);
        controller.close();
        stream.port.close();
      } else {
        waitingForRead = true;
      }
    },
    cancel() {
      clearTimeout(timer);
      stream.port.postMessage({ type: "cancelled" });
      stream.port.close();
    },
  }, { highWaterMark: 0 });
  event.respondWith(new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(stream.filename).replaceAll("'", "%27")}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  }));
});

import type { DownloadSink } from "./download-sink";

export const MAX_CLIPBOARD_BYTES = 10 * 1024 * 1024;
const ABSENT = 0xffffffff;

export interface ClipboardContent {
  text?: string;
  image?: Blob;
}

export async function readClipboardFile(): Promise<File> {
  if (!navigator.clipboard) throw new Error("Clipboard access is unavailable in this browser.");
  let text: Blob | undefined;
  let image: Blob | undefined;
  if (navigator.clipboard.read) {
    const items = await navigator.clipboard.read();
    const item = items.find((entry) => entry.types.includes("text/plain") || entry.types.includes("image/png"));
    if (item?.types.includes("text/plain")) text = await item.getType("text/plain");
    if (item?.types.includes("image/png")) image = await item.getType("image/png");
  } else if (navigator.clipboard.readText) {
    text = new Blob([await navigator.clipboard.readText()], { type: "text/plain" });
  }
  if (!text && !image) throw new Error("The clipboard has no supported text or PNG image.");
  if (8 + (text?.size ?? 0) + (image?.size ?? 0) > MAX_CLIPBOARD_BYTES) {
    throw new Error("Clipboard content exceeds the 10 MiB limit.");
  }
  const header = new ArrayBuffer(8);
  const lengths = new DataView(header);
  lengths.setUint32(0, text ? text.size : ABSENT);
  lengths.setUint32(4, image ? image.size : ABSENT);
  return new File([header, ...(text ? [text] : []), ...(image ? [image] : [])], "Clipboard content", {
    type: "application/octet-stream",
  });
}

export function clipboardSink(size: number, onReady: (content: ClipboardContent) => void): DownloadSink {
  if (size < 8 || size > MAX_CLIPBOARD_BYTES) throw new Error("Clipboard content exceeds the supported size.");
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  let aborted = false;
  return {
    async write(bytes) {
      received += bytes.byteLength;
      if (received > size) throw new Error("Invalid clipboard content size.");
      chunks.push(bytes);
    },
    async close() {
      if (received !== size) throw new Error("Incomplete clipboard content.");
      const blob = new Blob(chunks);
      const header = new DataView(await blob.slice(0, 8).arrayBuffer());
      const textLength = header.getUint32(0);
      const imageLength = header.getUint32(4);
      if (
        (textLength === ABSENT && imageLength === ABSENT) ||
        8 + (textLength === ABSENT ? 0 : textLength) + (imageLength === ABSENT ? 0 : imageLength) !== size
      ) throw new Error("Invalid clipboard content.");
      const content: ClipboardContent = {};
      let offset = 8;
      if (textLength !== ABSENT) {
        content.text = await blob.slice(offset, offset + textLength).text();
        offset += textLength;
      }
      if (imageLength !== ABSENT) content.image = blob.slice(offset, offset + imageLength, "image/png");
      chunks.length = 0;
      if (aborted) throw new Error("Clipboard transfer cancelled.");
      onReady(content);
    },
    abort() { aborted = true; chunks.length = 0; },
  };
}

export async function writeClipboard(content: ClipboardContent): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard access is unavailable in this browser.");
  if (content.image) {
    if (!navigator.clipboard.write || typeof ClipboardItem === "undefined") {
      throw new Error("This browser cannot copy images to the clipboard.");
    }
    const data: Record<string, Blob> = { "image/png": content.image };
    if (content.text !== undefined) data["text/plain"] = new Blob([content.text], { type: "text/plain" });
    return navigator.clipboard.write([new ClipboardItem(data)]);
  }
  if (content.text === undefined || !navigator.clipboard.writeText) {
    throw new Error("This browser cannot copy clipboard text.");
  }
  return navigator.clipboard.writeText(content.text);
}

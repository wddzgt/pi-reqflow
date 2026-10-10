import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./files.js";

export const imageLimits = { count: 4, bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, pixels: 20000000 };

function dimensions(buffer, mimeType) {
  if (mimeType === "image/png" && buffer.length >= 33
      && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && buffer.readUInt32BE(8) === 13 && buffer.toString("ascii", 12, 16) === "IHDR") {
    let offset = 8; let dataSeen = false; let ended = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset); const type = buffer.toString("ascii", offset + 4, offset + 8);
      if (offset + size + 12 > buffer.length || type === "acTL") throw new Error("PNG must be complete and non-animated");
      let crc = 0xffffffff;
      for (const byte of buffer.subarray(offset + 4, offset + 8 + size)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      if (((crc ^ 0xffffffff) >>> 0) !== buffer.readUInt32BE(offset + 8 + size)) throw new Error("PNG checksum failed");
      offset += size + 12; dataSeen ||= type === "IDAT";
      if (type === "IEND") { ended = size === 0 && offset === buffer.length; break; }
    }
    if (!ended || !dataSeen) throw new Error("PNG data or ending is missing");
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (mimeType === "image/jpeg" && buffer.length > 4 && buffer.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
      const marker = buffer[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return [buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5)];
      }
      offset += 2 + length;
    }
  }
  throw new Error("Image content does not match a supported PNG/JPEG header");
}

export function validateImages(images) {
  if (!Array.isArray(images) || images.length > imageLimits.count) throw new Error("Upload at most four PNG/JPEG images per message");
  let total = 0;
  return images.map((image) => {
    if (!image || typeof image.name !== "string" || !image.name.trim() || image.name.length > 200
        || /[\\/\x00-\x1f]/.test(image.name) || !["image/png", "image/jpeg"].includes(image.mimeType)
        || typeof image.data !== "string" || image.data.length > Math.ceil(imageLimits.bytes / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw new Error("Invalid image upload");
    const buffer = Buffer.from(image.data, "base64");
    const [width, height] = dimensions(buffer, image.mimeType);
    total += buffer.length;
    if (!buffer.length || buffer.length > imageLimits.bytes || total > imageLimits.totalBytes
        || width < 1 || height < 1 || width * height > imageLimits.pixels) throw new Error("Image exceeds byte or pixel limits");
    return { name: image.name, mimeType: image.mimeType, width, height, bytes: buffer.length, hash: sha256(buffer), buffer };
  });
}

export async function persistImages(directory, validated) {
  if (!validated.length) return [];
  await fs.mkdir(path.join(directory, "attachments"), { recursive: true, mode: 0o700 });
  const result = [];
  for (const { buffer, ...image } of validated) {
    const id = randomUUID();
    const file = `attachments/${id}.${image.mimeType === "image/png" ? "png" : "jpg"}`;
    await fs.writeFile(path.join(directory, file), buffer, { flag: "wx", mode: 0o600 });
    result.push({ ...image, id, file });
  }
  return result;
}

export async function readImage(directory, descriptor) {
  if (!descriptor || !/^attachments\/[a-f0-9-]{36}\.(png|jpg)$/.test(descriptor.file)) throw new Error("Invalid audited image path");
  const file = path.join(directory, descriptor.file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== descriptor.bytes || stat.size > imageLimits.bytes) throw new Error("Audited image size or type changed");
  const buffer = await fs.readFile(file);
  if (sha256(buffer) !== descriptor.hash) throw new Error("Audited image content changed");
  return buffer;
}

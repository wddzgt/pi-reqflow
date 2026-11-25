import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "../src/files.js";
import type { ImageRecord, Role, Settings } from "./types.js";

type Validated = Omit<ImageRecord, "at" | "actor"> & { buffer: Buffer };

export const imageLimits = { count: 4, bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, pixels: 20000000 };

export function assertImageModel(settings: Settings, role: Role) {
  const choice = settings.models[role];
  const model = settings.providers.find(provider => provider.id === choice.provider)?.models.find(item => item.id === choice.model);
  if (!model?.input.includes("image")) throw new Error("当前模型不支持图片输入，请更换支持图片的模型或移除截图");
}

function dimensions(buffer: Buffer, mimeType: string): [number, number] {
  if (mimeType === "image/png" && buffer.length >= 33
      && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && buffer.readUInt32BE(8) === 13 && buffer.toString("ascii", 12, 16) === "IHDR") {
    let offset = 8; let dataSeen = false; let ended = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset); const type = buffer.toString("ascii", offset + 4, offset + 8);
      if (offset + size + 12 > buffer.length || type === "acTL") throw new Error("PNG截图必须完整且不能是动图");
      let crc = 0xffffffff;
      for (const byte of buffer.subarray(offset + 4, offset + 8 + size)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      if (((crc ^ 0xffffffff) >>> 0) !== buffer.readUInt32BE(offset + 8 + size)) throw new Error("PNG截图校验失败");
      offset += size + 12; dataSeen ||= type === "IDAT";
      if (type === "IEND") { ended = size === 0 && offset === buffer.length; break; }
    }
    if (!ended || !dataSeen) throw new Error("PNG截图数据或结尾缺失");
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
  throw new Error("截图内容不是支持的PNG/JPEG文件");
}

export function validateImages(images: unknown): Validated[] {
  if (!Array.isArray(images) || images.length > imageLimits.count) throw new Error("每次最多上传四张PNG/JPEG截图");
  let total = 0;
  return images.map((image: any) => {
    if (!image || typeof image.name !== "string" || !image.name.trim() || image.name.length > 200
        || /[\\/\x00-\x1f]/.test(image.name) || !["image/png", "image/jpeg"].includes(image.mimeType)
        || typeof image.data !== "string" || image.data.length > Math.ceil(imageLimits.bytes / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data))
      throw new Error("截图上传格式无效");
    const buffer = Buffer.from(image.data, "base64");
    const [width, height] = dimensions(buffer, image.mimeType);
    total += buffer.length;
    if (!buffer.length || buffer.length > imageLimits.bytes || total > imageLimits.totalBytes
        || width < 1 || height < 1 || width * height > imageLimits.pixels) throw new Error("截图超出单张或总字节、像素限制");
    return { name: image.name, mimeType: image.mimeType, width, height, bytes: buffer.length, hash: sha256(buffer), buffer };
  });
}

const extension = (mimeType: string) => mimeType === "image/png" ? "png" : "jpg";
const imageFile = (base: string, record: Pick<ImageRecord, "hash" | "mimeType">) =>
  path.join(base, "images", `${record.hash}.${extension(record.mimeType)}`);

export async function saveValidatedImages(base: string, validated: Validated[], actor: string): Promise<ImageRecord[]> {
  if (!validated.length) return [];
  const home = path.join(base, "images");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString(), records: ImageRecord[] = [];
  for (const image of validated) {
    const record: ImageRecord = { name: image.name, mimeType: image.mimeType, width: image.width,
      height: image.height, bytes: image.bytes, hash: image.hash, at, actor };
    try { await fs.writeFile(imageFile(base, record), image.buffer, { flag: "wx", mode: 0o600 }); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const existing = await fs.readFile(imageFile(base, record));
      if (sha256(existing) !== record.hash) throw new Error("截图哈希冲突：" + record.name);
    }
    records.push(record);
  }
  return records;
}

export async function readImages(base: string, records: ImageRecord[]): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  const result: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const record of records) {
    const bytes = await fs.readFile(imageFile(base, record));
    if (sha256(bytes) !== record.hash) throw new Error("截图证据已改变：" + record.name);
    result.push({ type: "image", data: bytes.toString("base64"), mimeType: record.mimeType });
  }
  return result;
}

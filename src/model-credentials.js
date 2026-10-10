import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { readJson, writeJson } from "./files.js";

async function encryptionKey(archive, create = false) {
  const file = path.join(archive, "model-encryption.key");
  if (create) {
    try { await fs.writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if ((await fs.stat(file)).mode & 0o077) throw new Error("模型加密密钥必须仅允许服务账号访问。");
  const key = await fs.readFile(file);
  if (key.length !== 32) throw new Error("模型加密密钥格式不正确。");
  return key;
}

export async function saveModelCredential(archive, apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 16384 || /[\r\n\0]/.test(apiKey)) throw new Error("请填写有效的 API Key。");
  const id = randomUUID(); const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await encryptionKey(archive, true), iv);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const directory = path.join(archive, "model-credentials");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJson(path.join(directory, `${id}.json`), { iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
  return id;
}

export async function readModelCredential(archive, id) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? "")) throw new Error("模型凭据引用格式不正确。");
  const file = path.join(archive, "model-credentials", `${id}.json`);
  if ((await fs.stat(file)).mode & 0o077) throw new Error("模型凭据必须仅允许服务账号访问。");
  const value = await readJson(file);
  const decipher = createDecipheriv("aes-256-gcm", await encryptionKey(archive), Buffer.from(value.iv, "base64"));
  decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

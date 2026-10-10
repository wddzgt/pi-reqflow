import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./files.js";

export async function saveDeploymentCredentials(archive, values) {
  if (!Object.keys(values).length || Object.values(values).some(value => typeof value !== "string" || !value.trim() || value.length > 16384 || /[\r\n]/.test(value))) throw new Error("请填写有效的发布凭据。");
  const id = randomUUID();
  const directory = path.join(archive, "deployment-credentials");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJson(path.join(directory, `${id}.json`), values);
  return id;
}

export async function resolveDeploymentCredentials(names, credentialId, archive) {
  if (credentialId !== undefined) {
    if (!/^[a-f0-9-]{36}$/.test(credentialId) || typeof archive !== "string" || !path.isAbsolute(archive)) throw new Error("Deployment credential reference requires the project archive");
    const file = path.join(archive, "deployment-credentials", `${credentialId}.json`);
    if ((await fs.stat(file)).mode & 0o077) throw new Error("Deployment credentials must be owner-only (0600)");
    const values = await readJson(file);
    if (Object.keys(values).length !== names.length || names.some(name => typeof values[name] !== "string" || !values[name].trim())) throw new Error("Stored deployment credentials differ from the configured names");
    return values;
  }
  return Object.fromEntries(names.map(name => {
    if (!process.env[name]) throw new Error(`Missing deployment credential environment variable: ${name}`);
    return [name, process.env[name]];
  }));
}

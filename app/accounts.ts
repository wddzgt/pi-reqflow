import { promises as fs } from "node:fs";
import path from "node:path";
import { timingSafeEqual, randomBytes, randomUUID, scrypt as deriveKey } from "node:crypto";
import { promisify } from "node:util";
import { readJson, writeJson, sha256, safeId } from "../src/files.js";
import type { Project, Principal } from "./types.js";

const scrypt = promisify(deriveKey);
async function passwordFields(password: string) {
  const passwordSalt = randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(password, passwordSalt, 32) as Buffer).toString("hex");
  return { passwordSalt, passwordHash };
}
export async function createFirstAdmin(archive: string, password: string) {
  const user = { id: 'admin', username: 'admin', roles: ['admin'], authVersion: randomUUID(),
    mustChangePassword: false, ...await passwordFields(password) };
  const event = { at: new Date().toISOString(), type: 'user_created', detail: {
    id: user.id, initiatedBy: 'cli:init', roles: user.roles }, previous: null };
  await writeJson(path.join(archive, 'auth.json'), { schemaVersion: 4, users: [user] });
  await fs.writeFile(path.join(archive, 'auth-events.jsonl'), JSON.stringify({ ...event, hash: sha256(JSON.stringify(event)) }) + '\n',
    { flag: 'wx', mode: 0o600 });
}
export async function loadCredentials(project: Pick<Project, 'accountsArchive'>) {
  const file = path.join(project.accountsArchive, "auth.json");
  if ((await fs.stat(file)).mode & 0o077) throw new Error("账号文件必须仅允许当前服务账号读取");
  const value = await readJson(file);
  if (value.schemaVersion !== 4 || !Array.isArray(value.users)) throw new Error("账号文件格式无效");
  for (const user of value.users) {
    safeId(user.id);
    if (typeof user.username !== "string" || !user.username || !Array.isArray(user.roles) || !user.roles.length
      || user.roles.some((r: string) => !["admin", "product", "developer"].includes(r))
      || !/^[a-f0-9]{64}$/.test(user.passwordHash) || !/^[a-f0-9]{32}$/.test(user.passwordSalt)
      || typeof user.authVersion !== "string" || !user.authVersion
      || (user.tokenHash && !/^[a-f0-9]{64}$/.test(user.tokenHash))) throw new Error("账号记录无效");
  }
  for (const field of ["id", "username", "tokenHash"]) {
    const entries = value.users.map((u: any) => u[field]).filter((v: unknown) => v !== undefined && v !== null);
    if (new Set(entries).size !== entries.length) throw new Error(`账号记录重复：${field}`);
  }
  return value;
}
function principal(user: any): Principal {
  return { id: user.id, roles: [...user.roles], authVersion: user.authVersion, username: user.username,
    mustChangePassword: user.mustChangePassword === true };
}
export async function validSessionPrincipal(project: Project, actor: Principal) {
  const user = (await loadCredentials(project)).users.find((u: any) => u.id === actor.id);
  return !!user && user.authVersion === actor.authVersion && JSON.stringify(user.roles) === JSON.stringify(actor.roles);
}
export async function authenticate(project: Project, token: string) {
  if (typeof token !== "string" || !token) throw Object.assign(new Error("请输入访问令牌"), { status: 401 });
  const digest = Buffer.from(sha256(token), "hex");
  const user = (await loadCredentials(project)).users.find((u: any) => u.tokenHash && timingSafeEqual(digest, Buffer.from(u.tokenHash, "hex")));
  if (!user) throw Object.assign(new Error("访问令牌无效"), { status: 401 });
  return principal(user);
}
export async function listUsers(project: Project) {
  return (await loadCredentials(project)).users.map((user: any) => ({ id: user.id, username: user.username,
    roles: user.roles, mustChangePassword: user.mustChangePassword === true }));
}
export async function saveUser(project: Project, actor: Principal, value: any) {
  if (!actor.roles.includes("admin")) throw Object.assign(new Error("用户管理仅限管理员"), { status: 403 });
  if (!["create", "roles", "password"].includes(value.action)) throw new Error("用户操作无效");
  safeId(value.id);
  if (value.action !== "password" && (!Array.isArray(value.roles) || !value.roles.length
    || new Set(value.roles).size !== value.roles.length || value.roles.some((r: string) => !["admin", "product", "developer"].includes(r))))
    throw new Error("请选择有效的人员角色");
  if (value.action !== "roles" && (typeof value.password !== "string" || Buffer.byteLength(value.password) < 6)) throw new Error("密码至少6字节");
  if (value.action === "create" && (typeof value.username !== "string" || !value.username.trim())) throw new Error("请填写用户名");
  const lock = await fs.open(path.join(project.accountsArchive, "auth.lock"), "wx", 0o600);
  try {
    const credentials = await loadCredentials(project); let user = credentials.users.find((u: any) => u.id === value.id);
    if (value.action === "create") {
      if (user || credentials.users.some((u: any) => u.username === value.username.trim())) throw new Error("用户标识或用户名已存在");
      user = { id: value.id, username: value.username.trim() }; credentials.users.push(user);
    } else if (!user) throw new Error("用户不存在");
    if (value.action === "roles" && user.roles.includes("admin") && !value.roles.includes("admin")
      && credentials.users.filter((u: any) => u.roles.includes("admin")).length === 1) throw new Error("不能移除最后一位管理员");
    const file = path.join(project.accountsArchive, "auth-events.jsonl"); let rows: any[];
    try { rows = (await fs.readFile(file, "utf8")).trim().split("\n").map(s => JSON.parse(s)); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; rows = []; }
    let previous = null;
    for (const row of rows) {
      if (row.previous !== previous || sha256(JSON.stringify({ ...row, hash: undefined })) !== row.hash) throw new Error("账号审计链损坏");
      previous = row.hash;
    }
    if (value.action !== "password") user.roles = value.roles;
    if (value.action !== "roles") {
      Object.assign(user, await passwordFields(value.password));
      user.mustChangePassword = true;
    }
    user.authVersion = randomUUID();
    const event: any = { at: new Date().toISOString(), type: `user_${value.action}`, detail: { id: user.id, initiatedBy: actor.id,
      ...(value.action === "password" ? {} : { roles: user.roles }) }, previous };
    event.hash = sha256(JSON.stringify(event));
    await writeJson(path.join(project.accountsArchive, "auth.json"), credentials);
    await fs.appendFile(file, JSON.stringify(event) + "\n", { mode: 0o600 });
    return { id: user.id, username: user.username, roles: user.roles };
  } finally { await lock.close(); await fs.unlink(path.join(project.accountsArchive, "auth.lock")); }
}
export async function authenticateByUsername(project: Pick<Project, 'accountsArchive'>, username: string, password: string) {
  if (typeof username !== "string" || !username || typeof password !== "string" || !password)
    throw Object.assign(new Error("请输入用户名和密码"), { status: 401 });
  const user = (await loadCredentials(project)).users.find((u: any) => u.username === username);
  if (!user || !timingSafeEqual(await scrypt(password, user.passwordSalt, 32) as Buffer, Buffer.from(user.passwordHash, "hex")))
    throw Object.assign(new Error("用户名或密码错误"), { status: 401 });
  return principal(user);
}
export async function changePassword(project: Project, actor: Principal, oldPassword: string, newPassword: string) {
  if (typeof newPassword !== "string" || Buffer.byteLength(newPassword) < 6) throw new Error("新密码至少6字节");
  await authenticateByUsername(project, (await loadCredentials(project)).users.find((u: any) => u.id === actor.id)?.username, oldPassword);
  const lock = await fs.open(path.join(project.accountsArchive, "auth.lock"), "wx", 0o600);
  try {
    const credentials = await loadCredentials(project); const user = credentials.users.find((u: any) => u.id === actor.id);
    if (!user || user.authVersion !== actor.authVersion) throw new Error("账号身份已改变");
    const file = path.join(project.accountsArchive, "auth-events.jsonl"); let rows: any[];
    try { rows = (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(s => JSON.parse(s)); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; rows = []; }
    let previous = null;
    for (const row of rows) {
      if (row.previous !== previous || sha256(JSON.stringify({ ...row, hash: undefined })) !== row.hash) throw new Error("账号审计链损坏");
      previous = row.hash;
    }
    Object.assign(user, await passwordFields(newPassword));
    user.authVersion = randomUUID(); user.mustChangePassword = false;
    const event: any = { at: new Date().toISOString(), type: "password_changed", detail: { id: actor.id }, previous };
    event.hash = sha256(JSON.stringify(event));
    await writeJson(path.join(project.accountsArchive, "auth.json"), credentials);
    await fs.appendFile(file, JSON.stringify(event) + "\n", { mode: 0o600 });
  } finally { await lock.close(); await fs.unlink(path.join(project.accountsArchive, "auth.lock")); }
}

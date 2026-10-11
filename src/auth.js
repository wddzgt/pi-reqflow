import { timingSafeEqual, randomBytes, randomUUID, scrypt as deriveKey } from "node:crypto";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, safeId, sha256, writeJson } from "./files.js";
import { actionAuditContext, withLock } from "./store.js";

const scrypt = promisify(deriveKey);

export const humanRoles = new Set(["admin", "product", "developer"]);
export const agentRoles = new Set(["frontend", "backend", "qa", "executor", "tester", "releaser"]);
export const roles = new Set([...humanRoles, ...agentRoles]);

const access = {
  new: ["product", "admin"], "assign-member": ["product", "admin"], "confirm-contract": ["product", "admin"], "revise-contract": ["product", "admin"],
  "intake-message": ["product", "admin"], "analyze-intake": ["product", "admin"],
  "accept-assignment": ["developer", "admin"], "decline-assignment": ["developer", "admin"],
  "dev-feedback": ["developer", "admin"], "submit-review": ["developer", "admin"], "run-review": ["developer", "admin"], "finalize-review": ["developer", "admin"],
  plan: ["developer", "admin"], "fast-track": ["developer", "admin"], implement: ["developer", "admin"], verify: ["developer", "admin"],
  develop: ["developer", "admin"],
  "inspect-interrupted": ["developer", "admin"], "recover-lock": ["developer", "admin"],
  "revise-plan": ["developer", "admin"], "approve-plan": ["developer", "admin"], "approve-changes": ["developer", "admin"],
  "discuss-plan": ["developer", "admin"], "edit-plan": ["developer", "admin"],
  "resolve-plan-findings": ["developer", "admin"],
  "resume-implementation": ["developer", "admin"],
  "pause-execution": ["product", "developer", "admin"], "continue-execution": ["product", "developer", "admin"],
  "local-validation": ["developer", "admin"], "recheck-local": ["developer", "admin"], "publish-test": ["developer", "admin"],
  "redeploy-test": ["developer", "admin"],
  "record-published": ["developer", "admin"], "deploy-test": ["developer", "admin"], "poll-deploy": ["developer", "admin"],
  "verify-candidate": ["developer", "admin"],
  rollback: ["developer", "admin"], "restart-development": ["developer", "admin"], "archive-test-only": ["developer", "admin"],
  "accept-test": ["product", "developer", "admin"], "approve-release": ["developer", "admin"], "observe-release": ["developer", "admin"],
  "reconcile-test-deploy": ["developer", "admin"],
  release: ["developer", "admin"], "poll-release": ["developer", "admin"], "reconcile-release": ["developer", "admin"],
  "audit-report": ["admin"], history: ["admin"], "auth-history": ["admin"],
  "import-project": ["admin"],
  "configure-project": ["admin"],
  "configure-environment": ["admin", "developer"],
  "assign-team": ["product", "admin"], "review-plan": ["developer", "admin"],
};

const agentActions = new Set([
  "submit-review", "run-review", "plan", "fast-track",
  "implement", "verify", "inspect-interrupted", "recover-lock",
  "record-published", "deploy-test", "poll-deploy", "verify-candidate",
  "release", "poll-release",
]);

function credentialFile(project) { return path.join(project.accountsArchive ?? project.archive, "auth.json"); }

export async function authenticationHistory(project) {
  const file = path.join(project.accountsArchive ?? project.archive, "auth-events.jsonl");
  const prior = await fs.readFile(file, "utf8").then((value) => value.trim().split("\n").map((line) => JSON.parse(line)), (error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let previous = null;
  for (const row of prior) {
    if (row.previous !== previous || row.hash !== sha256(JSON.stringify({ ...row, hash: undefined }))) {
      throw new Error("Authentication audit chain changed");
    }
    previous = row.hash;
  }
  return prior;
}

async function authAuditHead(project) {
  return (await authenticationHistory(project)).at(-1)?.hash ?? null;
}

async function appendAuthEvent(project, type, detail) {
  const context = actionAuditContext.getStore();
  if (context) detail = { ...detail, initiatedBy: context.actor, action: context.action };
  const file = path.join(project.accountsArchive ?? project.archive, "auth-events.jsonl");
  const previous = await authAuditHead(project);
  const event = { at: new Date().toISOString(), type, detail, previous };
  event.hash = sha256(JSON.stringify({ ...event, hash: undefined }));
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function validateAssignedRoles(assignedRoles) {
  if (!Array.isArray(assignedRoles) || !assignedRoles.length || assignedRoles.some((role) => !humanRoles.has(role))) {
    throw new Error("At least one valid human role is required (admin, product, or developer)");
  }
  if (assignedRoles.includes("admin") && assignedRoles.length !== 1) {
    throw new Error("Admin is a read-only role and cannot be combined with other roles");
  }
}

export function authorize(principal, action) {
  if (!principal || !Array.isArray(principal.roles)) throw new Error("Authenticated principal is required");
  const allowed = access[action];
  if (!allowed) throw new Error(`Unknown authorized action: ${action}`);
  if (!principal.roles.some((role) => allowed.includes(role))) {
    const error = new Error(`Role cannot perform ${action}`);
    error.code = "EACCES";
    throw error;
  }
}

export function allowedActions(principal) {
  if (!principal || !Array.isArray(principal.roles)) throw new Error("Authenticated principal is required");
  return Object.keys(access).filter((action) => principal.roles.some((role) => access[action].includes(role)));
}

export function canReadTask(principal, meta) {
  if (!principal || !Array.isArray(principal.roles)) throw new Error("Authenticated principal is required");
  if (principal.roles.includes("admin") || meta.createdBy === principal.id) return true;
  return Object.values(meta.assignments ?? {}).some((assignment) =>
    assignment.userId === principal.id && assignment.status !== "declined");
}

export function canConfigureEnvironment(principal, rows) {
  return principal.roles.includes("admin") || (principal.roles.includes("developer") && rows.some(row =>
    Object.values(row.assignments ?? {}).some(assignment => assignment.userId === principal.id && assignment.status === "accepted")));
}

export function authorizeTaskRead(principal, meta) {
  if (canReadTask(principal, meta)) return;
  const error = new Error("Role cannot read this requirement");
  error.code = "EACCES";
  throw error;
}

export function authorizeTaskAction(principal, action, meta, role = null) {
  authorize(principal, action);
  if (action === "accept-test" && meta.createdBy === principal.id) return;
  if (["assign-member", "assign-team", "confirm-contract", "revise-contract", "intake-message", "analyze-intake"].includes(action)) {
    if (meta.createdBy === principal.id) return;
  } else if (["accept-assignment", "decline-assignment"].includes(action)) {
    if (meta.assignments?.[role]?.userId === principal.id && meta.assignments[role].status === "pending") return;
  } else if (["review-plan", "discuss-plan", "edit-plan", "revise-plan"].includes(action)) {
    if (Object.values(meta.assignments ?? {}).some(assignment => assignment.userId === principal.id && assignment.status === "accepted")) return;
  } else if (agentActions.has(action)) {
    if (meta.assignments?.developer?.userId === principal.id
        && meta.assignments.developer.status === "accepted") return;
  } else {
    if (meta.assignments?.developer?.userId === principal.id
        && meta.assignments.developer.status === "accepted") return;
  }
  const error = new Error(`User is not assigned to perform ${action} on this requirement`);
  error.code = "EACCES";
  throw error;
}

function validateCredentials(value) {
  if (value.schemaVersion === 4) {
    if (!Array.isArray(value.users)) throw new Error("Invalid authentication file");
    for (const user of value.users) {
      safeId(user.id);
      if (typeof user.username !== "string" || !user.username) throw new Error(`Invalid username for ${user.id}`);
      validateAssignedRoles(user.roles);
      if (!/^[a-f0-9]{64}$/.test(user.passwordHash)) throw new Error(`Invalid password hash for ${user.id}`);
      if (!/^[a-f0-9]{32}$/.test(user.passwordSalt) || typeof user.authVersion !== "string" || !user.authVersion) {
        throw new Error(`Invalid password salt or authentication version for ${user.id}`);
      }
      if (user.tokenHash && !/^[a-f0-9]{64}$/.test(user.tokenHash)) throw new Error(`Invalid token hash for ${user.id}`);
    }
    if (new Set(value.users.map((user) => user.id)).size !== value.users.length) throw new Error("Duplicate authentication user");
    if (new Set(value.users.map((user) => user.username)).size !== value.users.length) throw new Error("Duplicate username");
    const tokens = value.users.map((user) => user.tokenHash).filter(Boolean);
    if (new Set(tokens).size !== tokens.length) throw new Error("Duplicate authentication token");
    return value;
  }
  throw new Error("Unsupported authentication schema version; provision schema 4 credentials explicitly before starting the service");
}

export async function loadCredentials(project) {
  const file = credentialFile(project);
  const stat = await fs.stat(file);
  if ((stat.mode & 0o077) !== 0) throw new Error("Authentication file must be owner-only (0600)");
  const credentials = await readJson(file);
  if (credentials.schemaVersion !== 4) throw new Error("Unsupported authentication schema version; credentials must be explicitly reprovisioned, never automatically migrated");
  return validateCredentials(credentials);
}

export async function reprovisionCredentials(project, passwords) {
  if (!passwords || typeof passwords !== "object" || Array.isArray(passwords)) throw new Error("Passwords must be an object keyed by user ID");
  return withLock(path.join(project.accountsArchive ?? project.archive, "auth.lock"), async () => {
    const file = credentialFile(project);
    const stat = await fs.stat(file);
    if (stat.mode & 0o077) throw new Error("Authentication file must be owner-only (0600)");
    const old = await readJson(file);
    if (![2, 3].includes(old.schemaVersion) || !Array.isArray(old.users)) throw new Error("Explicit reprovisioning accepts schema 2 or 3 credentials only");
    if (Object.keys(passwords).length !== old.users.length) throw new Error("Provide a new password for every existing user, without additional users");
    const users = [];
    for (const user of old.users) {
      safeId(user.id);
      validateAssignedRoles(user.roles);
      const password = passwords[user.id];
      if (!Object.hasOwn(passwords, user.id) || typeof password !== "string" || Buffer.byteLength(password) < 6) {
        throw new Error(`New password of at least 6 bytes required for ${user.id}`);
      }
      const passwordSalt = randomBytes(16).toString("hex");
      users.push({ ...user, passwordSalt, passwordHash: (await scrypt(password, passwordSalt, 32)).toString("hex"),
        authVersion: randomUUID(), mustChangePassword: true });
    }
    const upgraded = validateCredentials({ schemaVersion: 4, users });
    await authAuditHead(project);
    const backup = path.join(project.accountsArchive ?? project.archive, `auth-before-schema4-${randomUUID()}.json`);
    await writeJson(backup, old);
    await writeJson(file, upgraded);
    await appendAuthEvent(project, "credentials_reprovisioned", { userIds: users.map((user) => user.id), backup });
    return { schemaVersion: 4, backup, users: users.map((user) => user.id) };
  });
}

export async function addCredential(project, id, assignedRoles, options) {
  safeId(id);
  validateAssignedRoles(assignedRoles);
  const { username, password, token } = options;
  if (typeof username !== "string" || !username) throw new Error("Username is required");
  if (typeof password !== "string" || Buffer.byteLength(password) < 6) throw new Error("Password must contain at least 6 bytes");
  if (token !== undefined && (typeof token !== "string" || Buffer.byteLength(token) < 32)) throw new Error("Token must contain at least 32 bytes");
  return withLock(path.join(project.accountsArchive ?? project.archive, "auth.lock"), async () => {
    const file = credentialFile(project);
    const current = await fs.stat(file).then(() => loadCredentials(project), (error) => {
      if (error.code === "ENOENT") return { schemaVersion: 4, users: [] };
      throw error;
    });
    if (current.schemaVersion !== 4) throw new Error("Authentication file must be schema version 4");
    if (current.users.some((user) => user.id === id)) throw new Error(`User already exists: ${id}`);
    if (current.users.some((user) => user.username === username)) throw new Error(`Username already exists: ${username}`);
    if (token && current.users.some((user) => user.tokenHash === sha256(token))) throw new Error("Duplicate authentication token");
    await authAuditHead(project);
    const passwordSalt = randomBytes(16).toString("hex");
    const newUser = {
      id,
      username,
      roles: [...new Set(assignedRoles)],
      passwordHash: (await scrypt(password, passwordSalt, 32)).toString("hex"),
      passwordSalt,
      authVersion: randomUUID(),
      mustChangePassword: false,
    };
    if (token) newUser.tokenHash = sha256(token);
    current.users.push(newUser);
    await writeJson(file, current);
    await appendAuthEvent(project, "credential_added", { id, username, roles: assignedRoles });
    return { id, username, roles: assignedRoles };
  });
}

export async function revokeCredential(project, id) {
  safeId(id);
  return withLock(path.join(project.accountsArchive ?? project.archive, "auth.lock"), async () => {
    const current = await loadCredentials(project);
    const user = current.users.find((entry) => entry.id === id);
    if (!user) throw new Error(`User does not exist: ${id}`);
    await authAuditHead(project);
    current.users = current.users.filter((entry) => entry.id !== id);
    await writeJson(credentialFile(project), current);
    await appendAuthEvent(project, "credential_revoked", { id, roles: user.roles });
    return { id, revoked: true };
  });
}

export async function validSessionPrincipal(project, principal) {
  const credentials = await loadCredentials(project);
  const user = credentials.users.find((entry) => entry.id === principal.id);
  if (!user) return false;
  return user.authVersion === principal.authVersion && JSON.stringify(user.roles) === JSON.stringify(principal.roles);
}

export async function authenticate(project, token) {
  if (typeof token !== "string" || !token) throw new Error("Access token is required");
  const credentials = await loadCredentials(project);
  const digest = Buffer.from(sha256(token), "hex");
  let matched = null;
  for (const user of credentials.users) {
    if (user.tokenHash && timingSafeEqual(digest, Buffer.from(user.tokenHash, "hex"))) matched = user;
  }
  if (!matched) throw new Error("Invalid access token");
  return { id: matched.id, username: matched.username, roles: [...matched.roles], authVersion: matched.authVersion,
    mustChangePassword: matched.mustChangePassword === true };
}

export async function authenticateByUsername(project, username, password) {
  if (typeof username !== "string" || !username) throw new Error("Username is required");
  if (typeof password !== "string" || !password) throw new Error("Password is required");
  const credentials = await loadCredentials(project);
  const user = credentials.users.find((entry) => entry.username === username);
  if (!user) throw new Error("Invalid username or password");
  const digest = await scrypt(password, user.passwordSalt, 32);
  if (!timingSafeEqual(digest, Buffer.from(user.passwordHash, "hex"))) throw new Error("Invalid username or password");
  return { id: user.id, username: user.username, roles: [...user.roles], authVersion: user.authVersion, mustChangePassword: user.mustChangePassword === true };
}

export async function listUsers(project) {
  const credentials = await loadCredentials(project);
  return credentials.users.map((user) => ({
    id: user.id,
    username: user.username,
    roles: [...user.roles],
    hasToken: Boolean(user.tokenHash),
    mustChangePassword: user.mustChangePassword === true,
  }));
}

export async function updateUserRoles(project, id, newRoles) {
  safeId(id);
  validateAssignedRoles(newRoles);
  return withLock(path.join(project.accountsArchive ?? project.archive, "auth.lock"), async () => {
    const current = await loadCredentials(project);
    const user = current.users.find((entry) => entry.id === id);
    if (!user) throw new Error(`User does not exist: ${id}`);
    await authAuditHead(project);
    const oldRoles = [...user.roles];
    user.roles = [...new Set(newRoles)];
    user.authVersion = randomUUID();
    await writeJson(credentialFile(project), current);
    await appendAuthEvent(project, "user_roles_updated", { id, oldRoles, newRoles: user.roles });
    return { id, roles: user.roles };
  });
}

export async function resetPassword(project, id, newPassword) {
  safeId(id);
  if (typeof newPassword !== "string" || Buffer.byteLength(newPassword) < 6) throw new Error("Password must contain at least 6 bytes");
  return withLock(path.join(project.accountsArchive ?? project.archive, "auth.lock"), async () => {
    const current = await loadCredentials(project);
    const user = current.users.find((entry) => entry.id === id);
    if (!user) throw new Error(`User does not exist: ${id}`);
    await authAuditHead(project);
    user.passwordSalt = randomBytes(16).toString("hex");
    user.passwordHash = (await scrypt(newPassword, user.passwordSalt, 32)).toString("hex");
    user.authVersion = randomUUID();
    user.mustChangePassword = false;
    await writeJson(credentialFile(project), current);
    await appendAuthEvent(project, "password_reset", { id });
    return { id, passwordReset: true };
  });
}

export async function changePassword(project, principal, oldPassword, newPassword) {
  if (typeof oldPassword !== "string" || !oldPassword) throw new Error("Current password is required");
  if (typeof newPassword !== "string" || Buffer.byteLength(newPassword) < 6) throw new Error("New password must contain at least 6 bytes");
  return withLock(path.join(project.accountsArchive ?? project.archive, "auth.lock"), async () => {
    const current = await loadCredentials(project);
    const user = current.users.find((entry) => entry.id === principal.id);
    if (!user) throw new Error("User not found");
    const oldDigest = await scrypt(oldPassword, user.passwordSalt, 32);
    if (!timingSafeEqual(oldDigest, Buffer.from(user.passwordHash, "hex"))) throw new Error("Current password is incorrect");
    await authAuditHead(project);
    user.passwordSalt = randomBytes(16).toString("hex");
    user.passwordHash = (await scrypt(newPassword, user.passwordSalt, 32)).toString("hex");
    user.authVersion = randomUUID();
    user.mustChangePassword = false;
    await writeJson(credentialFile(project), current);
    await appendAuthEvent(project, "password_changed", { id: principal.id });
    return { passwordChanged: true };
  });
}

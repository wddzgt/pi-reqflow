import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanLocalEnvironment, environmentScanDiff } from "../src/environment-scan.js";
import { configureLocalEnvironment, inspectLocalEnvironment, environmentStartup } from "../src/local-environment.js";

async function projectFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, ".reqflow");
  await fs.mkdir(archive); await fs.writeFile(path.join(archive, "index.json"), "[]");
  await fs.mkdir(path.join(root, "frontend")); await fs.mkdir(path.join(root, "backend/src/main/resources"), { recursive: true });
  await fs.writeFile(path.join(root, "frontend/package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "1", redis: "1" } }));
  await fs.writeFile(path.join(root, "frontend/app.js"), "const endpoint = process.env.API_ENDPOINT || 'http://example.invalid';\nconst token=process.env.API_TOKEN;\n");
  await fs.writeFile(path.join(root, "backend/pom.xml"), "<project>spring-boot</project>");
  await fs.writeFile(path.join(root, "backend/src/main/resources/application.yml"), `spring:
  datasource:
    url: jdbc:mysql://db.invalid:3307/test
    username: source-user
    password: secret-from-source
  sql:
    init:
      mode: always
  data:
    redis:
      host: redis.invalid
      port: 6379
      password: redis-source-secret
`);
  const project = { root, archive, config: { excludedPaths: [], maxSnapshotBytes: 1048576, environment: { localDeployment: [] } } };
  const scan = await scanLocalEnvironment(project);
  return { project, scan, input: { expectedRevision: null, expectedScanHash: scan.hash, target: "all", decisions: {}, values: {}, environmentFile: "" } };
}

test("scan identifies startup evidence without adopting source credentials or reading private dotenv", async t => {
  const { project, scan } = await projectFixture(t);
  await fs.writeFile(path.join(project.root, "frontend/.env"), "PRIVATE_ONLY=private-dotenv-secret\n");
  assert.equal((await scanLocalEnvironment(project)).hash, scan.hash);
  assert.equal(scan.services.find(row => row.id === "mysql:backend").requirement, "required");
  assert.equal(scan.services.find(row => row.id === "redis:backend").requirement, "unknown");
  assert.equal(scan.services.filter(row => row.kind === "redis").length, 1);
  assert.doesNotMatch(JSON.stringify(scan), /secret-from-source|source-user|redis-source-secret|PRIVATE_ONLY|private-dotenv-secret/);
  assert.equal(scan.services[0].fields.find(row => row.key === "API_ENDPOINT").requirement, "optional");
  assert.equal(scan.services[0].fields.find(row => row.key === "API_TOKEN").requirement, "unknown");
});

test("frontend target excludes backend dependencies and injects only selected service secrets", async t => {
  const { project, input } = await projectFixture(t);
  await configureLocalEnvironment(project, "dev", { ...input, target: "frontend", decisions: { "app:frontend/API_TOKEN": "enabled" },
    values: { "app:frontend/API_TOKEN": "frontend-private", "mysql:backend/password": "backend-private" } });
  const inspected = await inspectLocalEnvironment(project);
  assert.equal(inspected.report.status, "ready");
  assert.deepEqual(inspected.names, ["API_TOKEN"]);
  assert.deepEqual(Object.keys(inspected.environments), ["app:frontend"]);
  const startup = [{ name: "frontend", command: ["npm", "--prefix", "frontend", "run", "dev"], url: "http://localhost:3000/" },
    { name: "backend", command: ["mvn", "-f", "backend/pom.xml", "spring-boot:run"], url: "http://localhost:8080/" }];
  const selected = environmentStartup(inspected, startup);
  assert.deepEqual(selected.startup, [startup[0]]);
  assert.deepEqual(selected.environments, { frontend: { API_TOKEN: "frontend-private" } });
  assert.throws(() => environmentStartup(inspected, [startup[1]]), /没有已确认的启动命令/);
});

test("required dependencies and undecided variables block startup with explicit missing conditions", async t => {
  const { project, input } = await projectFixture(t);
  await assert.rejects(configureLocalEnvironment(project, "dev", { ...input, decisions: { "mysql:backend": "disabled" } }), /依赖判断/);
  await configureLocalEnvironment(project, "dev", input);
  const result = await inspectLocalEnvironment(project);
  assert.equal(result.report.status, "blocked");
  assert.ok(result.report.items.some(row => row.name.includes("MySQL") && row.message === "缺少必需配置。"));
  assert.ok(result.report.items.some(row => row.name === "Redis" && /确认/.test(row.message)));
  assert.ok(result.report.items.some(row => row.name.includes("API_TOKEN") && /确认/.test(row.message)));
  assert.deepEqual(result.environments, { "app:backend": {} });
});

test("rescan requires applying differences and preserves private values across versions", async t => {
  const { project, scan, input } = await projectFixture(t);
  const initial = await configureLocalEnvironment(project, "dev", { ...input, target: "frontend",
    decisions: { "app:frontend/API_TOKEN": "enabled" }, values: { "app:frontend/API_TOKEN": "retained-secret" } });
  await fs.appendFile(path.join(project.root, "frontend/app.js"), "const added=process.env.NEW_REQUIRED;\n");
  const fresh = await scanLocalEnvironment(project);
  assert.deepEqual(environmentScanDiff(scan, fresh).changed, ["前端 · frontend"]);
  assert.equal((await inspectLocalEnvironment(project)).report.status, "blocked");
  await assert.rejects(configureLocalEnvironment(project, "dev", { ...input, expectedRevision: initial.revision }), /扫描结果已改变/);
  const next = { ...input, expectedRevision: initial.revision, expectedScanHash: fresh.hash, target: "frontend",
    decisions: { "app:frontend/API_TOKEN": "enabled", "app:frontend/NEW_REQUIRED": "disabled" }, values: { "app:frontend/API_TOKEN": "" } };
  await assert.rejects(configureLocalEnvironment(project, "dev", next), /确认重新扫描/);
  const saved = await configureLocalEnvironment(project, "dev", { ...next, acceptScanChanges: true });
  assert.equal(saved.version, 2); assert.equal(saved.secretConfigured["app:frontend/API_TOKEN"], true);
  assert.doesNotMatch(JSON.stringify(saved), /retained-secret/);
  assert.equal((await inspectLocalEnvironment(project)).environments["app:frontend"].API_TOKEN, "retained-secret");
  await fs.access(path.join(project.archive, "local-environment-values", `${initial.settings.valueFile}.json`));
});

test("dependency check reports a failed TCP connection without running application initialization", async t => {
  const { project, input } = await projectFixture(t);
  const values = { "mysql:backend/host": "127.0.0.1", "mysql:backend/port": "1", "mysql:backend/database": "test",
    "mysql:backend/username": "test-user", "mysql:backend/password": "private-password" };
  await assert.rejects(configureLocalEnvironment(project, "dev", { ...input, values: { ...values, "mysql:backend/port": "0" } }), /有效端口/);
  await configureLocalEnvironment(project, "dev", { ...input, target: "app:backend", decisions: { "redis:backend": "disabled" }, values });
  const checked = await inspectLocalEnvironment(project);
  assert.equal(checked.report.status, "blocked");
  assert.match(checked.report.items.find(row => row.name === "MySQL").message, /ECONNREFUSED/);
  assert.doesNotMatch(JSON.stringify(checked.report), /private-password/);
  assert.equal(checked.environments["app:backend"].SPRING_DATASOURCE_URL, "jdbc:mysql://127.0.0.1:1/test");
});

test("unsupported backend configuration blocks that target without preventing frontend verification", async t => {
  const { project } = await projectFixture(t);
  await fs.appendFile(path.join(project.root, "backend/src/main/resources/application.yml"), "  profiles:\n    active: development\n");
  const scan = await scanLocalEnvironment(project);
  assert.match(scan.services.find(row => row.id === "app:backend").scanErrors[0], /未解析/);
  const input = { expectedRevision: null, expectedScanHash: scan.hash, target: "frontend", decisions: { "app:frontend/API_TOKEN": "disabled" }, values: {}, environmentFile: "" };
  const saved = await configureLocalEnvironment(project, "dev", input);
  assert.equal((await inspectLocalEnvironment(project)).report.status, "ready");
  await configureLocalEnvironment(project, "dev", { ...input, expectedRevision: saved.revision, target: "app:backend" });
  assert.ok((await inspectLocalEnvironment(project)).report.items.some(row => /未解析/.test(row.message)));
});

test("scan syntax errors report the source without exposing credentials in YAML diagnostics", async t => {
  const { project } = await projectFixture(t);
  await fs.writeFile(path.join(project.root, "backend/src/main/resources/application.yml"), "spring: [secret-malformed-password\n");
  await assert.rejects(scanLocalEnvironment(project), error => /YAML 解析失败/.test(error.message) && !/secret-malformed-password/.test(error.message));
});

test("rescan cannot expose an existing secret when a source field becomes public", async t => {
  const { project } = await projectFixture(t);
  const entry = path.join(project.root, "frontend/app.js");
  await fs.writeFile(entry, "const api=process.env.API_ENDPOINT || 'http://user:password@example.invalid';\n");
  const scan = await scanLocalEnvironment(project);
  assert.doesNotMatch(JSON.stringify(scan), /user:password/);
  const initial = await configureLocalEnvironment(project, "dev", { expectedRevision: null, expectedScanHash: scan.hash, target: "frontend",
    decisions: {}, values: { "app:frontend/API_ENDPOINT": "http://private:credential@example.invalid" }, environmentFile: "" });
  await fs.writeFile(entry, "const api=process.env.API_ENDPOINT || 'http://example.invalid';\n");
  const fresh = await scanLocalEnvironment(project);
  await assert.rejects(configureLocalEnvironment(project, "dev", { expectedRevision: initial.revision, expectedScanHash: fresh.hash,
    acceptScanChanges: true, target: "frontend", decisions: {}, values: {}, environmentFile: "" }), /私有属性已改变/);
});

test("shared source variables remain visible with ownership uncertainty rather than being omitted", async t => {
  const { project } = await projectFixture(t);
  await fs.writeFile(path.join(project.root, "shared-config.js"), "const shared=process.env.SHARED_TOKEN;\n");
  const scan = await scanLocalEnvironment(project);
  for (const app of scan.services.filter(row => row.kind === "application"))
    assert.equal(app.fields.find(row => row.key === "SHARED_TOKEN").requirement, "unknown");
  assert.ok(scan.warnings.some(row => /共享配置/.test(row)));
});

test("a source credential default requires a verification value even when another read has no default", async t => {
  const { project } = await projectFixture(t);
  await fs.writeFile(path.join(project.root, "frontend/app.js"), "const a=process.env.API_TOKEN || 'original-source-token';\nconst b=process.env.API_TOKEN;\n");
  const scan = await scanLocalEnvironment(project); const field = scan.services[0].fields[0];
  assert.equal(field.requirement, "required"); assert.equal(field.secret, true); assert.equal(field.reference, undefined);
  assert.doesNotMatch(JSON.stringify(scan), /original-source-token/);
  await configureLocalEnvironment(project, "dev", { expectedRevision: null, expectedScanHash: scan.hash, target: "frontend", environmentFile: "", decisions: {}, values: {} });
  const result = await inspectLocalEnvironment(project);
  assert.equal(result.report.status, "blocked");
  assert.match(result.report.items[0].message, /缺少必需配置/);
});

test("overriding database location preserves declared JDBC behavior parameters", async t => {
  const { project } = await projectFixture(t);
  const file = path.join(project.root, "backend/src/main/resources/application.yml");
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("jdbc:mysql://db.invalid:3307/test",
    "jdbc:mysql://db.invalid:3307/test?allowMultiQueries=true&useAffectedRows=true&serverTimezone=Asia/Shanghai"));
  const scan = await scanLocalEnvironment(project);
  await configureLocalEnvironment(project, "dev", { expectedRevision: null, expectedScanHash: scan.hash, target: "app:backend", environmentFile: "",
    decisions: { "redis:backend": "disabled" }, values: { "mysql:backend/host": "127.0.0.1", "mysql:backend/port": "1",
      "mysql:backend/database": "local test", "mysql:backend/username": "tester", "mysql:backend/password": "private-password" } });
  const checked = await inspectLocalEnvironment(project);
  const url = checked.environments["app:backend"].SPRING_DATASOURCE_URL;
  assert.match(url, /^jdbc:mysql:\/\/127\.0\.0\.1:1\/local%20test\?/);
  assert.match(url, /allowMultiQueries=true&useAffectedRows=true&serverTimezone=Asia%2FShanghai/);
});

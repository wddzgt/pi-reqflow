#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { readJson } from "../src/files.js";
import { openProject, projects, saveSettings } from "./projects.js";
import { initializeFirstProject } from './first-run.js';
import { startWebServer } from "./server.js";

async function adminPassword() {
  const terminal = Boolean(process.stdin.isTTY);
  const muted = new Writable({ write(_chunk, _encoding, next) { next(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal, historySize: 0 });
  input.on('SIGINT', () => input.close());
  const lines = input[Symbol.asyncIterator]();
  try {
    if (terminal) process.stderr.write('设置 admin 密码（至少 8 字节，输入隐藏）：');
    const first = await lines.next();
    if (first.done) throw new Error('未收到管理员密码');
    if (terminal) {
      process.stderr.write('\n再次输入密码：');
      const confirmation = await lines.next();
      if (confirmation.done || confirmation.value !== first.value) throw new Error('两次密码不一致');
    }
    return first.value;
  } finally { input.close(); if (terminal) process.stderr.write('\n'); }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: "string" }, port: { type: "string" }, file: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    process.stdout.write("pi-reqflow init <项目目录>\npi-reqflow web [--project /absolute/project] [--port 4173]\npi-reqflow configure --project /absolute/project --file delivery.json\n"); return;
  }
  const command = positionals[0];
  if (command === 'init') {
    if (positionals.length !== 2 || Object.keys(values).length) throw new Error('首次配置请运行 npm run setup -- "/项目目录"');
    const name = await initializeFirstProject(path.resolve(positionals[1]), adminPassword);
    process.stdout.write(`已接入「${name}」。运行 npm start，用 admin 和刚设置的密码登录。\n`); return;
  }
  if (positionals.length !== 1 || !["web", "configure"].includes(command)) throw new Error("请使用 init、web 或 configure；--help 查看用法");
  if (command === "configure") {
    if (!values.project || !values.file || values.port) throw new Error("configure 需要 --project 和 --file");
    const target = await openProject(path.resolve(values.project), "configured", path.basename(values.project));
    await saveSettings(target, await readJson(path.resolve(values.file)), "cli:configure");
    process.stdout.write("执行设置已保存，未调用模型、未修改账号。\n"); return;
  }
  if (values.file) throw new Error("web 不接受 --file");
  if (!values.project) await projects().catch(error => {
    if (error.code === 'ENOENT') throw new Error('请先运行 npm run setup -- "/要接入的项目目录"，设置管理员密码');
    throw error;
  });
  const port = values.port === undefined ? 4173 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口应为1至65535之间的整数");
  const server = await startWebServer(values.project ? path.resolve(values.project) : undefined, port);
  process.stdout.write(`需求工作台 ${server.url}\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await server.stop(); };
  process.once("SIGINT", () => { void stop().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void stop().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; }); });
}
main().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });

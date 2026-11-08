import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { LoginFlow } from "./login-flow.js";
import { RpcProcess } from "./rpc-process.js";
import { objectJSON } from "./workflow.js";
import { nativeEnvironment } from "./child-env.js";
import { providerFailure } from "./provider-errors.js";
import { findExecutable } from './providers.js';

export async function findCursorLaunch() {
  if (process.platform !== 'win32') {
    const executable = await findExecutable('agent');
    return executable ? { executable, prefix: [] } : null;
  }
  if (!process.env.LOCALAPPDATA) return null;
  const root = join(process.env.LOCALAPPDATA, "cursor-agent");
  const candidates = [root];
  try {
    const versions = (
      await readdir(join(root, "versions"), { withFileTypes: true })
    )
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i.test(
            entry.name,
          ),
      )
      .sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true }),
      );
    candidates.push(
      ...versions.map((entry) => join(root, "versions", entry.name)),
    );
  } catch {}
  for (const directory of candidates) {
    const executable = join(directory, "node.exe"),
      entry = join(directory, "index.js");
    try {
      await access(executable);
      await access(entry);
      return { executable, prefix: [entry] };
    } catch {}
  }
  return null;
}
export function captureCursor(launch, args, { timeout = 15000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.executable, [...launch.prefix, ...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: nativeEnvironment({ CURSOR_INVOKED_AS: "agent" }),
    });
    let text = "",
      done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Cursor CLI 응답 시간이 초과되었습니다."));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
      if (text.length > 1_000_000) {
        child.kill();
        finish(new Error("Cursor CLI 응답이 너무 큽니다."));
      }
    });
    child.once("error", () =>
      finish(new Error("공식 Cursor CLI를 실행하지 못했습니다.")),
    );
    child.once("close", (code) => finish(null, { code, text }));
  });
}
export function parseCursorStatus(value, code = 0) {
  const connected =
    code === 0 &&
    (value.authenticated === true ||
      value.loggedIn === true ||
      value.isAuthenticated === true ||
      value.isLoggedIn === true);
  return {
    installed: true,
    connected,
    state: connected ? "connected" : "disconnected",
    source: "cursor",
  };
}
export function parseCursorModels(text) {
  const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  try {
    const json = JSON.parse(clean);
    const rows = Array.isArray(json) ? json : json.models;
    if (Array.isArray(rows))
      return rows
        .map((row) => ({
          id:
            typeof row === "string" ? row : (row.id ?? row.modelId ?? row.name),
          name:
            typeof row === "string"
              ? row
              : (row.name ?? row.displayName ?? row.id),
        }))
        .filter((row) => typeof row.id === "string" && /grok/i.test(row.id));
  } catch {}
  const models = [];
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[>*•]\s*/, "");
    const match = trimmed.match(
      /^((?:cursor-)?grok[a-zA-Z0-9_.:[\],=-]*)\s+(?:[-–:]\s*)?(.*)$/i,
    );
    if (match) models.push({ id: match[1], name: match[2].trim() || match[1] });
    else if (/^(?:cursor-)?grok[a-zA-Z0-9_.-]*$/i.test(trimmed))
      models.push({ id: trimmed, name: trimmed });
  }
  const unique = new Map();
  for (const row of models) if (!unique.has(row.id)) unique.set(row.id, row);
  return [...unique.values()];
}
export function cursorACPModels(session) {
  return (session?.models?.availableModels ?? [])
    .filter(
      (row) =>
        typeof row.modelId === "string" && /^grok[-\w.]*\[/i.test(row.modelId),
    )
    .map((row) => ({ id: row.modelId, name: row.name || row.modelId }));
}
export class CursorConnection {
  constructor(notify = () => {}, dependencies = {}) {
    this.find = dependencies.find ?? findCursorLaunch;
    this.capture = dependencies.capture ?? captureCursor;
    this.rpcFactory =
      dependencies.rpcFactory ?? ((...args) => new RpcProcess(...args));
    this.login = new LoginFlow(
      "cursor",
      (event) => {
        if (event.state === "connected") this.modelCache = null;
        notify({ ...event, type: "grok", source: "cursor" });
      },
      dependencies,
    );
    this.cache = null;
    this.checking = null;
    this.modelCache = null;
    this.metadataCwd = dependencies.cwd ?? process.cwd();
    this.modelChecking = null;
    this.open = dependencies.open;
  }
  async status({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.at < 30000)
      return { ...this.cache.value, login: this.login.state() };
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const launch = await this.find();
      let value;
      if (!launch)
        value = {
          installed: false,
          connected: false,
          state: "not-installed",
          source: "cursor",
        };
      else
        try {
          const result = await this.capture(launch, [
            "status",
            "--format",
            "json",
          ]);
          value = parseCursorStatus(JSON.parse(result.text), result.code);
        } catch {
          value = {
            installed: true,
            connected: false,
            state: "unknown",
            source: "cursor",
          };
        }
      this.cache = { at: Date.now(), value };
      return { ...value, login: this.login.state() };
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  async connect({ forceLogin = false } = {}) {
    const status = await this.status({ force: true });
    if (status.connected && !forceLogin)
      return {
        reused: true,
        connected: true,
        message:
          "터미널의 Cursor Agent 로그인을 재사용합니다. Grok 모델은 Cursor 계정으로 실행합니다.",
      };
    const launch = await this.find();
    if (!launch) throw new Error("공식 Cursor Agent CLI를 먼저 설치하세요.");
    return this.login.start(
      launch.executable,
      [...launch.prefix, "login"],
      () => this.status({ force: true }),
      {
        cwd: this.metadataCwd,
        env: nativeEnvironment({
          NO_OPEN_BROWSER: "1",
          CURSOR_INVOKED_AS: "agent",
        }),
        open: this.open,
      },
    );
  }
  async models({ force = false } = {}) {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < 60000)
      return this.modelCache.rows;
    if (this.modelChecking) return this.modelChecking;
    this.modelChecking = (async () => {
      const status = await this.status();
      if (!status.connected)
        throw new Error("Cursor Agent 로그인을 먼저 연결하세요.");
      const launch = await this.find();
      if (!launch) throw new Error("Cursor Agent CLI 설치가 필요합니다.");
      const rpc = this.rpcFactory(
        launch.executable,
        [...launch.prefix, "acp"],
        { cwd: this.metadataCwd },
      );
      try {
        const init = await rpc.request(
          "initialize",
          {
            protocolVersion: 1,
            clientInfo: { name: "CW_Handsoff_sys", version: "0.5.0" },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          },
          45000,
        );
        if (!init.authMethods?.some((method) => method.id === "cursor_login"))
          throw new Error("Cursor ACP 인증 방식이 호환되지 않습니다.");
        await rpc.request("authenticate", { methodId: "cursor_login" });
        const session = await rpc.request("session/new", {
          cwd: this.metadataCwd,
          mcpServers: [],
        });
        const rows = cursorACPModels(session);
        this.modelCache = { at: Date.now(), rows };
        return rows;
      } finally {
        rpc.close();
      }
    })().finally(() => {
      this.modelChecking = null;
    });
    return this.modelChecking;
  }
  async ask(instructions, context, model) {
    const launch = await this.find();
    if (!launch) throw new Error("공식 Cursor Agent CLI가 없습니다.");
    let text = "";
    const signal = context.signal;
    signal.throwIfAborted();
    const rpc = this.rpcFactory(launch.executable, [...launch.prefix, "acp"], {
      cwd: context.snapshot.root,
      onNotification: (method, params) => {
        if (method !== "session/update") return;
        const update = params?.update;
        if (
          update?.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        )
          text += update.content.text ?? "";
        if (text.length > 4_000_000) rpc.close();
      },
    });
    const abort = () => rpc.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const init = await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "CW_Handsoff_sys", version: "0.5.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        45000,
      );
      if (!init.authMethods?.some((method) => method.id === "cursor_login"))
        throw new Error(
          "이 Cursor CLI의 ACP 인증 방식이 호환되지 않습니다. 업데이트 후 다시 확인하세요.",
        );
      await rpc.request("authenticate", { methodId: "cursor_login" });
      const session = await rpc.request("session/new", {
        cwd: context.snapshot.root,
        mcpServers: [],
      });
      if (!session.modes?.availableModes?.some((mode) => mode.id === "ask"))
        throw new Error(
          "Cursor ACP의 읽기 전용 ask 모드를 확인하지 못했습니다.",
        );
      if (!cursorACPModels(session).some((row) => row.id === model))
        throw new Error(
          "선택한 Grok 모델이 현재 Cursor ACP 목록에 없습니다. 모델 목록을 다시 확인하세요.",
        );
      await rpc.request("session/set_mode", {
        sessionId: session.sessionId,
        modeId: "ask",
      });
      await rpc.request("session/set_model", {
        sessionId: session.sessionId,
        modelId: model,
      });
      const { signal: _signal, designImage, ...data } = context;
      if(designImage&&!init.agentCapabilities?.promptCapabilities?.image)throw new Error('선택한 Cursor 연결은 이미지 입력을 지원하지 않아 시안을 검토할 수 없습니다.');
      const payload = { ...data, snapshot: { ...data.snapshot, root: "." } };
      const result = await rpc.request(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [
            ...(designImage && init.agentCapabilities?.promptCapabilities?.image ? [{ type: "image", mimeType: "image/png", data: designImage }] : []),
            {
              type: "text",
              text: `${instructions}\n\n${JSON.stringify(payload)}`,
            },
          ],
        },
        300000,
      );
      if (result.stopReason !== "end_turn")
        throw new Error("Cursor의 Grok 작업이 정상 완료되지 않았습니다.");
      return objectJSON(text);
    } catch (error) {
      throw providerFailure("grok", error, error.message);
    } finally {
      signal.removeEventListener("abort", abort);
      await rpc.close();
    }
  }
  cancel() {
    this.login.cancel();
  }
}

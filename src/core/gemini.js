import { access, mkdir, readFile } from "node:fs/promises";
import { join, delimiter, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { RpcProcess } from "./rpc-process.js";
import { authorizationURL } from "./login-flow.js";
import {
  BUILD_FORMAT,
  planningInstructions,
  reviewInstructions,
} from "./providers.js";
import { objectJSON } from "./workflow.js";
import { nativeEnvironment } from "./child-env.js";
import { isolatedRequest } from "./isolated-request.js";
import { nodeRuntime } from "./node-runtime.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CHAT_FORMAT } from "./agent-chat.js";
import { providerFailure } from "./provider-errors.js";

export const GEMINI_VERSION = "0.66.0";
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function findNode() {
  return nodeRuntime();
}
export async function findGemini(directory, developmentRoot = null) {
  const executable = await findNode();
  if (!executable) return null;
  const roots = [
    directory && join(directory, "tools", "gemini"),
    developmentRoot,
    process.env.APPDATA && join(process.env.APPDATA, "npm"),
    dirname(dirname(executable)),
    ...(process.env.PATH?.split(delimiter) ?? []),
  ].filter((root) => root && /^(?:[A-Za-z]:[\\/]|\/)/.test(root));
  for (const root of roots) {
    for (const relative of [
      "node_modules/@google/gemini-cli/bundle/gemini.js",
      "node_modules/@google/gemini-cli/dist/index.js",
      "lib/node_modules/@google/gemini-cli/bundle/gemini.js",
      "lib/node_modules/@google/gemini-cli/dist/index.js",
    ]) {
      const entry = join(root, relative);
      if (await exists(entry)) return { executable, prefix: [entry] };
    }
  }
  return null;
}
export function geminiEnvironment(login = false) {
  const env = nativeEnvironment({
    NO_BROWSER: "true",
    GEMINI_CLI_NO_RELAUNCH: "1",
  });
  if (login) delete env.NO_BROWSER;
  for (const key of [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
    "GOOGLE_CLOUD_ACCESS_TOKEN",
  ])
    delete env[key];
  return env;
}
export function geminiModels(session) {
  return (session?.models?.availableModels ?? [])
    .filter((row) => typeof row.modelId === "string")
    .map((row) => ({ id: row.modelId, name: row.name ?? row.modelId }));
}
export async function geminiAuthType() {
  try {
    const settings = JSON.parse(
      await readFile(
        join(
          process.env.GEMINI_CLI_HOME ?? join(homedir(), ".gemini"),
          "settings.json",
        ),
        "utf8",
      ),
    );
    return settings.security?.auth?.selectedType ?? null;
  } catch {
    return null;
  }
}
export class GeminiConnection {
  constructor(directory, notify = () => {}, dependencies = {}) {
    this.directory = directory;
    this.notify = notify;
    this.open = dependencies.open;
    this.find =
      dependencies.find ??
      (() => findGemini(directory, dependencies.developmentRoot));
    this.authType = dependencies.authType ?? geminiAuthType;
    this.rpcFactory =
      dependencies.rpcFactory ?? ((...args) => new RpcProcess(...args));
    this.active = null;
    this.cache = null;
    this.checking = null;
    this.modelCache = [];
    this.installing = null;
    this.login = {
      state: () => this.loginState(),
      cancel: () => this.cancel(),
      openBrowser: async (open) => {
        if (!this.active?.url)
          throw new Error("Google 승인 링크를 아직 받지 못했습니다.");
        await open(this.active.url);
      },
      code: () => {
        throw new Error("Google 공식 브라우저에서 승인을 완료하세요.");
      },
    };
  }
  loginState() {
    return {
      waiting: !!this.active,
      hasBrowserLink: !!this.active?.url,
      codeRequired: false,
    };
  }
  async launch(root, login = false, onNotification = () => {}) {
    const launch = await this.find();
    if (!launch) throw new Error("Gemini CLI 설치가 필요합니다.");
    const loginAttempt = this.active;
    return this.rpcFactory(
      launch.executable,
      [
        ...launch.prefix,
        "--acp",
        "--extensions",
        "none",
        "--allowed-mcp-server-names",
        `cw-no-mcp-${randomUUID()}`,
        "--policy",
        fileURLToPath(
          new URL("../skills/gemini-readonly.toml", import.meta.url),
        ),
      ],
      {
        cwd: root,
        env: geminiEnvironment(login),
        onNotification,
        onOutput: (chunk) => {
          if (!this.active || this.active !== loginAttempt || !login) return;
          this.active.output = (this.active.output + chunk.toString()).slice(
            -18000,
          );
          const url = authorizationURL(this.active.output, "gemini");
          if (url && !this.active.url) {
            this.active.url = url;
            this.emit(
              "waiting",
              "Google 공식 브라우저에서 로그인을 완료하세요. 브라우저가 열리지 않으면 다시 열기를 누르세요.",
            );
          }
        },
      },
    );
  }
  async initialize(rpc) {
    const value = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "CW_Handsoff_sys", version: "0.5.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      60000,
    );
    if (!value.authMethods?.some((row) => row.id === "oauth-personal"))
      throw new Error("Google 로그인용 Gemini ACP가 호환되지 않습니다.");
    return value;
  }
  async status({ force = false } = {}) {
    if (this.active)
      return {
        ...this.cache?.value,
        installed: true,
        connected: false,
        state: "waiting",
        login: this.loginState(),
      };
    if (!force && this.cache && Date.now() - this.cache.at < 30000)
      return { ...this.cache.value, login: this.loginState() };
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const launch = await this.find();
      let value = {
        installed: !!launch,
        connected: false,
        state: launch ? "disconnected" : "not-installed",
      };
      if (launch && (await this.authType()) === "oauth-personal") {
        let rpc;
        try {
          rpc = await this.launch(this.directory);
          await this.initialize(rpc);
          const session = await rpc.request(
            "session/new",
            { cwd: this.directory, mcpServers: [] },
            30000,
          );
          this.modelCache = geminiModels(session);
          value = { installed: true, connected: true, state: "connected" };
        } catch (error) {
          value = {
            installed: true,
            connected: false,
            state:
              error.rpcCode === -32000 ? "disconnected" : "verification-failed",
          };
        } finally {
          rpc?.close();
        }
      }
      this.cache = { at: Date.now(), value };
      return { ...value, login: this.loginState() };
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  emit(state, message) {
    this.notify({ type: "gemini", state, message, login: this.loginState() });
  }
  async connect() {
    if (this.active) throw new Error("Google 로그인이 진행 중입니다.");
    if ((await this.status()).connected)
      return {
        reused: true,
        connected: true,
        message: "기존 Gemini CLI Google 로그인을 사용합니다.",
      };
    const active = { url: null, output: "", rpc: null };
    this.active = active;
    this.emit("waiting", "Google 공식 로그인을 준비하고 있습니다.");
    active.promise = (async () => {
      try {
        const rpc = (active.rpc = await this.launch(this.directory, true));
        if (this.active !== active) return;
        await this.initialize(rpc);
        if (this.active !== active) return;
        await rpc.request(
          "authenticate",
          { methodId: "oauth-personal" },
          300000,
        );
        const session = await rpc.request(
          "session/new",
          { cwd: this.directory, mcpServers: [] },
          30000,
        );
        this.modelCache = geminiModels(session);
        if (this.active !== active) return;
        this.cache = {
          at: Date.now(),
          value: { installed: true, connected: true, state: "connected" },
        };
        this.active = null;
        this.emit(
          "connected",
          "Google 로그인이 연결되었습니다. 다음 실행부터 Gemini CLI의 저장된 인증을 사용합니다.",
        );
      } catch {
        if (this.active === active) {
          this.active = null;
          this.emit(
            "error",
            "Google 로그인을 완료하지 못했습니다. 공식 브라우저의 계정·권한과 Gemini CLI 상태를 확인하세요.",
          );
        }
      } finally {
        active.rpc?.close();
        active.output = "";
        active.url = null;
      }
    })();
    return { waiting: true };
  }
  async models({ force = false } = {}) {
    const status = await this.status({ force });
    if (!status.connected)
      throw new Error("Gemini Google 로그인을 먼저 연결하세요.");
    return this.modelCache;
  }
  async install() {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      const executable = await findNode();
      if (!executable) throw new Error("Node.js 20 이상을 먼저 설치하세요.");
      const npm = join(
        dirname(executable),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      if (!(await exists(npm)))
        throw new Error("Node.js와 npm 설치를 확인하세요.");
      const target = join(this.directory, "tools", "gemini");
      await mkdir(target, { recursive: true });
      this.emit("waiting", "공식 Gemini CLI를 설치하고 있습니다.");
      await new Promise((resolvePromise, reject) => {
        const child = spawn(
          executable,
          [
            npm,
            "install",
            "--prefix",
            target,
            `@google/gemini-cli@${GEMINI_VERSION}`,
            "--no-audit",
            "--no-fund",
          ],
          { cwd: target, windowsHide: true, shell: false, stdio: "ignore" },
        );
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Gemini CLI 설치 시간이 초과되었습니다."));
        }, 300000);
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Gemini CLI 설치를 시작하지 못했습니다."));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          code === 0
            ? resolvePromise()
            : reject(
                new Error(
                  "Gemini CLI 설치에 실패했습니다. 네트워크와 npm 설정을 확인하세요.",
                ),
              );
        });
      });
      this.cache = null;
      return { installed: true };
    })().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }
  async ask(instructions, context, model) {
    context.signal.throwIfAborted();
    if (!model) throw new Error("Gemini 실행 모델을 선택하세요.");
    let text = "";
    const rpc = await this.launch(
      context.snapshot.root,
      false,
      (method, params) => {
        const update = params?.update;
        if (
          method === "session/update" &&
          update?.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        ) {
          text += update.content.text ?? "";
          if (text.length > 4_000_000) rpc.close();
        }
      },
    );
    const abort = () => rpc.close();
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      context.signal.throwIfAborted();
      const init = await this.initialize(rpc);
      context.signal.throwIfAborted();
      const session = await rpc.request(
        "session/new",
        { cwd: context.snapshot.root, mcpServers: [] },
        30000,
      );
      if (!geminiModels(session).some((row) => row.id === model))
        throw new Error("선택한 Gemini 모델이 현재 목록에 없습니다.");
      const mode = session.modes?.availableModes?.find((row) =>
        ["plan", "ask"].includes(row.id),
      );
      if (!mode)
        throw new Error("Gemini 읽기 전용 모드를 확인하지 못했습니다.");
      await rpc.request("session/set_mode", {
        sessionId: session.sessionId,
        modeId: mode.id,
      });
      await rpc.request("session/set_model", {
        sessionId: session.sessionId,
        modelId: model,
      });
      const { signal, designImage, ...source } = context;
      if(designImage&&!init.agentCapabilities?.promptCapabilities?.image)throw new Error('선택한 Gemini 연결은 이미지 입력을 지원하지 않아 시안을 검토할 수 없습니다.');
      const data = { ...source, snapshot: { ...source.snapshot, root: "." } };
      const result = await rpc.request(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [
            ...(designImage && init.agentCapabilities?.promptCapabilities?.image ? [{ type: "image", mimeType: "image/png", data: designImage }] : []),
            { type: "text", text: `${instructions}\n${JSON.stringify(data)}` },
          ],
        },
        300000,
      );
      if (result.stopReason !== "end_turn")
        throw new Error("Gemini 작업이 정상 완료되지 않았습니다.");
      return objectJSON(text);
    } catch (error) {
      throw providerFailure("gemini", error, error.message);
    } finally {
      context.signal.removeEventListener("abort", abort);
      await rpc.close();
    }
  }
  cancel() {
    if (this.active) {
      const active = this.active;
      this.active = null;
      active.rpc?.close();
      active.output = "";
      active.url = null;
      this.emit(
        "cancelled",
        "Google 로그인 시도만 취소했습니다. 기존 CLI 인증은 유지합니다.",
      );
    }
  }
}
export class GeminiProvider {
  constructor(connection) {
    this.connection = connection;
  }
  async ready(options) {
    if (typeof options.geminiModel !== "string" || !options.geminiModel)
      return false;
    return (
      (await this.connection.status()).connected &&
      (await this.connection.models()).some(
        (row) => row.id === options.geminiModel,
      )
    );
  }
  ask(instructions, context) {
    return isolatedRequest(context, (root, safe) =>
      this.connection.ask(
        instructions,
        { ...safe, snapshot: { ...safe.snapshot, root } },
        context.options.geminiModel,
      ),
    );
  }
  async plan(context) {
    return this.ask(await planningInstructions(undefined, context.options), context);
  }
  build(context) {
    return this.ask(BUILD_FORMAT, context);
  }
  chat(context) {
    return this.ask(CHAT_FORMAT, context);
  }
  review(context) {
    return this.ask(reviewInstructions(context.visualComparison), context);
  }
}

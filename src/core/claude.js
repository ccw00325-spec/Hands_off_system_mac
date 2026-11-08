import { spawn } from "node:child_process";
import { LoginFlow } from "./login-flow.js";
import { nativeEnvironment } from "./child-env.js";
import { findExecutable } from "./providers.js";

export class ClaudeConnection {
  constructor(notify = () => {}, dependencies = {}) {
    this.notify = notify;
    this.login = new LoginFlow("claude", notify, dependencies);
    this.find = dependencies.find ?? (() => findExecutable("claude"));
    this.spawn = dependencies.spawn ?? spawn;
    this.cache = null;
    this.checking = null;
  }
  async executable() {
    return this.find();
  }
  async status({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.at < 30000)
      return { ...this.cache.value, login: this.login.state() };
    if (this.checking) return this.checking;
    this.checking = this.readStatus()
      .then((value) => {
        this.cache = { at: Date.now(), value };
        return { ...value, login: this.login.state() };
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }
  async readStatus() {
    const executable = await this.executable();
    if (!executable)
      return { installed: false, connected: false, state: "not-installed" };
    return new Promise((resolve) => {
      const child = this.spawn(executable, ["auth", "status", "--json"], {
        env: nativeEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve({ installed: true, connected: false, state: "unknown" });
      }, 10000);
      child.stdout.on("data", (data) => {
        if (output.length < 32000) output += data.toString();
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ installed: true, connected: false, state: "unknown" });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          const status = JSON.parse(output);
          // Return only safe status fields. Credentials remain under the official CLI's control.
          resolve({
            installed: true,
            connected: code === 0 && status.loggedIn === true,
            state: code === 0 && status.loggedIn === true ? "connected" : "disconnected",
            method: String(status.authMethod || ""),
            label: String(status.email || "Claude Code"),
          });
        } catch {
          resolve({ installed: true, connected: false, state: "unknown" });
        }
      });
    });
  }
  async connect({ forceLogin = false } = {}) {
    const existing = await this.status({ force: true });
    if (existing.connected && !forceLogin)
      return {
        reused: true,
        connected: true,
        message: "이 PC의 Claude Code 로그인을 재사용합니다. 터미널을 열 필요가 없습니다.",
      };
    const executable = await this.executable();
    if (!executable) throw new Error("공식 Claude Code 실행 도구가 필요합니다. Claude 데스크톱 앱만 설치한 경우 별도 설치가 필요할 수 있습니다. 시작 준비의 설치 안내를 확인하세요.");
    return this.login.start(executable, ["auth", "login"], () =>
      this.status({ force: true }),
    );
  }
  cancel() {
    this.login.cancel();
  }
}

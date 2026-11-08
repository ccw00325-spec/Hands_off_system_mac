import { deviceBinding } from "./device-binding.js";
import { pushVerifiedCommit } from "./release-commit.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, delimiter, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { findExecutable } from "./providers.js";
import { nodeRuntime } from "./node-runtime.js";
import { secretFinding } from "./secrets.js";
import { nativeEnvironment } from "./child-env.js";
import { digest, relativeFile } from "./workspace.js";
import { macLoginScript } from './mac-terminal.js';

const execute = promisify(execFile);
const services = ["github", "vercel", "supabase"];
const deploymentHost = /^(?:https:\/\/)?([a-z0-9-]+\.vercel\.app)\/?$/i;
export function priorVercelDeployment(output, runId) {
  let listing;
  try { listing = JSON.parse(output); }
  catch { throw new Error("이전 Vercel 요청의 JSON 상태를 확인할 수 없습니다."); }
  if (!Array.isArray(listing?.deployments) ||
      listing.deployments.some((row) => row?.meta?.handsOffRun !== runId))
    throw new Error("이전 Vercel 요청의 상태를 확인할 수 없습니다.");
  const ready = listing.deployments.find((row) => row.state === "READY");
  if (ready) {
    const host = deploymentHost.exec(ready.url)?.[1];
    if (host) return "https://" + host;
    throw new Error("이전 Vercel 배포 주소를 확인할 수 없습니다.");
  }
  if (listing.pagination?.next ||
      listing.deployments.some((row) => !["ERROR", "CANCELED"].includes(row.state)))
    throw new Error("이전 Vercel 배포가 아직 처리 중이거나 상태가 확정되지 않았습니다. 대시보드에서 확인하세요.");
  return null;
}
const slug = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function repositoryName(title, id) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 45)
    .replace(/-$/, "");
  return `${base || "hands-off-project"}-${id.slice(0, 8)}`;
}

async function commandFor(service) {
  const name = service === "github" ? "gh" : service;
  const executable = await findExecutable(name);
  if (executable) return [executable];
  if (service !== "vercel") return null;
  const node = await nodeRuntime();
  if (!node) return null;
  for (const root of (process.env.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)) {
    const manifest = join(root, "node_modules", "vercel", "dist", "index.js");
    if (
      await access(manifest).then(
        () => true,
        () => false,
      )
    )
      return [node, manifest];
  }
  return null;
}

function serviceEnvironment() {
  const env = nativeEnvironment();
  for (const key of Object.keys(env))
    if (/^(?:GH_|VERCEL_|SUPABASE_)/i.test(key)) delete env[key];
  return env;
}

async function run(
  command,
  args,
  { cwd = homedir(), env = serviceEnvironment(), timeout = 25000 } = {},
) {
  const { stdout } = await execute(command[0], [...command.slice(1), ...args], {
    cwd,
    env,
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export class AuxiliaryServices {
  constructor(store, projects, workspace, notify, { resolveCommand = commandFor, execute = run, identity = deviceBinding } = {}) {
    Object.assign(this, { store, projects, workspace, notify, resolveCommand, execute, identity });
    this.running = new Set();
    this.logins = new Map();
  }

  async account(service, command, options) {
    if (service === "github")
      return this.execute(command, [
        "api",
        "--hostname",
        "github.com",
        "user",
        "--jq",
        ".login",
      ], options);
    if (service === "vercel") return this.execute(command, ["whoami"], options);
    await this.supabaseProjects(command);
    return "연결됨";
  }

  async supabaseProjects(command) {
    const projects = JSON.parse(await this.execute(command, ["projects", "list", "--output", "json"]));
    if (!Array.isArray(projects)) throw new Error("Supabase 프로젝트 목록을 확인할 수 없습니다.");
    return projects;
  }

  async configuration(id, project) {
    project ??= this.projects.find(await this.projects.list(), id);
    const config = project.delivery;
    if (!config || config.deviceBinding !== await this.identity()) return null;
    const grant = await this.workspace.grant(id, config.grantId).catch(() => null);
    return grant?.grantId === config.grantId ? config : null;
  }

  async status(id) {
    const project = this.projects.find(await this.projects.list(), id);
    const accounts = Object.fromEntries(
      await Promise.all(
        services.map(async (service) => {
          const command = await this.resolveCommand(service);
          const account = command
            ? await this.account(service, command).catch(() => null)
            : null;
          return [service, { installed: Boolean(command), account, waiting: this.logins.has(service) }];
        }),
      ),
    );
    const config = await this.configuration(id, project);
    return {
      accounts,
      config,
      reconnectRequired: Boolean(project.delivery && !config),
      name: repositoryName(project.title, id),
      result: await this.result(id),
    };
  }

  async result(id) {
    const project = this.projects.find(await this.projects.list(), id);
    const config = await this.configuration(id, project);
    const result = await this.store.read(`delivery-${id}`, null);
    return result?.revision === config?.revision && config ? result : null;
  }

  async login(service) {
    if (!services.includes(service))
      throw new Error("지원하지 않는 서비스입니다.");
    if (!['win32', 'darwin'].includes(process.platform))
      throw new Error("공식 CLI에서 로그인한 뒤 연결 상태를 다시 확인하세요.");
    if (this.running.size) throw new Error("릴리스가 끝난 뒤 보조 서비스 계정을 변경하세요.");
    if (this.logins.has(service)) return { waiting: true };
    const command = await this.resolveCommand(service);
    if (!command) throw new Error("공식 CLI를 설치하고 앱을 다시 열어 주세요.");
    if (this.logins.has(service)) return { waiting: true };
    if (this.running.size) throw new Error("릴리스가 끝난 뒤 보조 서비스 계정을 변경하세요.");
    const args =
      service === "github"
        ? [
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--web",
            "--git-protocol",
            "https",
            "--skip-ssh-key",
          ]
        : ["login"];
    if (process.platform === 'darwin') {
      const job = Promise.resolve().then(async () => {
        let connected = false;
        try {
          await this.execute(['/usr/bin/osascript'], macLoginScript(command, args), {timeout:15000});
          const deadline = Date.now() + 600000;
          while (Date.now() < deadline && !(connected = Boolean(await this.account(service, command).catch(() => null)))) await new Promise(resolve => setTimeout(resolve, 2500));
        } finally { this.logins.delete(service); this.notify({type:'service-login', service, connected}); }
      }).catch(() => {});
      this.logins.set(service, job); return {waiting:true};
    }
    // Login needs a visible console for official prompts and device codes.
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = `& ${[...command, ...args].map(quote).join(" ")}; exit $LASTEXITCODE`;
    const shell = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const launch = `$ErrorActionPreference = 'Stop'; $child = Start-Process -FilePath ${quote(shell)} -ArgumentList @('-NoProfile','-EncodedCommand','${encoded}') -WindowStyle Normal -PassThru; $child.WaitForExit(); exit $child.ExitCode`;
    const job = Promise.resolve().then(async () => {
      let connected = false;
      try {
        await this.execute([shell], ["-NoProfile", "-EncodedCommand", Buffer.from(launch, "utf16le").toString("base64")], { timeout: 600000 });
        connected = Boolean(await this.account(service, command));
      } catch {} finally {
        this.logins.delete(service);
        this.notify({ type: "service-login", service, connected });
      }
    });
    this.logins.set(service, job);
    return { waiting: true };
  }

  async save(id, input) {
    if (this.running.has(id) || this.logins.size) throw new Error("릴리스 또는 보조 서비스 로그인이 끝난 뒤 저장하세요.");
    const grant = await this.workspace.grant(id);
    const project = this.projects.find(await this.projects.list(), id);
    const github = input.github === true;
    const vercel = input.vercel === true;
    const name = String(input.name ?? "")
      .trim()
      .toLowerCase();
    const scope = String(input.scope ?? "").trim();
    const target = String(input.target ?? "").trim();
    const supabaseRef = String(input.supabaseRef ?? "").trim();
    if (
      (github && name && !slug.test(name)) ||
      (vercel && (!slug.test(scope) || !slug.test(target))) ||
      (supabaseRef && !/^[a-z0-9]{1,64}$/.test(supabaseRef))
    )
      throw new Error(
        "저장소 이름, Vercel 범위와 프로젝트 이름에 영문·숫자·하이픈을 사용하세요.",
      );
    const prior = await this.configuration(id, project);
    const accounts = { github: prior?.accounts.github };
    for (const service of ["github", "vercel"]) {
      if (!(service === "github" ? github : vercel)) continue;
      const command = await this.resolveCommand(service);
      accounts[service] =
        command && (await this.account(service, command).catch(() => null));
      if (!accounts[service])
        throw new Error(`${service} 로그인 상태를 확인하세요.`);
    }
    if (accounts.github && !slug.test(accounts.github))
      throw new Error("GitHub 계정을 확인할 수 없습니다.");
    if (supabaseRef) {
      const command = await this.resolveCommand("supabase");
      const available = command ? await this.supabaseProjects(command).catch(() => []) : [];
      if (!available.some((row) => row?.id === supabaseRef || row?.reference_id === supabaseRef))
        throw new Error("현재 Supabase 계정에서 이 프로젝트 참조 ID를 확인할 수 없습니다.");
    }
    const sameGitHub =
      prior?.grantId === grant.grantId &&
      prior?.name === name &&
      prior?.accounts.github === accounts.github;
    const production = input.production === true;
    const sameVercel =
      prior?.grantId === grant.grantId &&
      prior?.scope === scope &&
      prior?.target === target &&
      prior?.accounts.vercel === accounts.vercel &&
      prior?.production === production;
    const config = {
      revision: randomUUID(),
      deviceBinding: await this.identity(),
      grantId: grant.grantId,
      github,
      vercel,
      name,
      scope,
      target,
      production,
      supabaseRef,
      accounts,
      always: {
        github: Boolean(
          github && sameGitHub && prior.always?.github && !input.resetApproval,
        ),
        vercel: Boolean(
          vercel && sameVercel && prior.always?.vercel && !input.resetApproval,
        ),
      },
      repoId:
        prior?.grantId === grant.grantId &&
        prior?.name === name &&
        prior?.accounts.github === accounts.github
          ? prior.repoId
          : undefined,
      resolvedName:
        prior?.grantId === grant.grantId &&
        prior?.name === name &&
        prior?.accounts.github === accounts.github
          ? prior.resolvedName
          : undefined,
      lastCommit:
        prior?.grantId === grant.grantId &&
        prior?.name === name &&
        prior?.accounts.github === accounts.github
          ? prior.lastCommit
          : undefined,
    };
    await this.projects.mutate((data) => {
      if (this.running.has(id)) throw new Error("자동 릴리스가 진행 중입니다.");
      this.projects.find(data, id).delivery = config;
    });
    return config;
  }

  async publish(state, retry = false, answer = null) {
    const id = state.projectId;
    const revision = state.options?.deliveryRevision;
    if (
      state.status !== "completed" ||
      !state.validation?.passed ||
      !revision ||
      this.running.has(id) || this.logins.size
    )
      return false;
    this.running.add(id);
    let temp;
    let result;
    let stage = "snapshot";
    const report = async (status, message) => {
      Object.assign(result, { status, message, failedService: status === "failed" ? stage : null });
      await this.store.write(`delivery-${id}`, result);
      if (status === "awaiting_approval") return;
      this.notify({
        type: "delivery",
        projectId: id,
        result: structuredClone(result),
      });
    };
    try {
      const project = this.projects.find(await this.projects.list(), id);
      const config = await this.configuration(id, project);
      if (
        config?.revision !== revision ||
        config.grantId !== state.grantId ||
        (!config.github && !config.vercel)
      )
        return;
      const prior = await this.store.read(`delivery-${id}`, null);
      if (prior?.runId === state.id && !retry) return;
      if (
        answer &&
        (prior?.runId !== state.id ||
          prior.revision !== revision ||
          prior.pending?.id !== answer.id ||
          typeof answer.yes !== "boolean")
      )
        throw new Error("이 승인 요청은 이미 처리됐거나 만료됐습니다.");
      result =
        prior?.runId === state.id ? prior : { runId: state.id, revision };
      if (result.status === "completed") return;
      if (result.pending && !answer) {
        return true;
      }
      const answeredService = answer ? result.pending.service : null;
      delete result.pending;
      result.decisions ??= {};
      if (answer) result.decisions[answeredService] = answer.yes;
      await report("running", "검증된 파일을 배포용으로 준비 중…");
      const restored = await this.workspace.read(id, ".control-tower/restored.json", {
        internal: true, grantId: state.grantId,
      }).then((data) => JSON.parse(data), (error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (restored && (!state.createdAt || restored.at >= state.createdAt))
        throw new Error("체크포인트 복원 이후 새 작업에서 검증하세요.");
      const snapshot = await this.workspace.snapshot(id);
      if (
        snapshot.grantId !== state.grantId ||
        snapshot.hash !== state.snapshotHash ||
        snapshot.truncated
      )
        throw new Error("검증 이후 파일이 달라졌습니다. 다시 검증하세요.");
      if (answer?.yes && answer.remember === true) {
        await this.projects.mutate((data) => {
          const stored = this.projects.find(data, id).delivery;
          if (stored?.revision !== revision)
            throw new Error("릴리스 설정이 변경됐습니다.");
          stored.always ??= {};
          stored.always[answeredService] = true;
        });
      }
      const repoName =
        config.resolvedName ||
        config.name ||
        repositoryName(state.repositoryName || project.title, id);
      const requestApproval = async (service, target, action) => {
        if (
          config.always?.[service] && ((await this.store.read('preferences',{}))??{}).autopilotEnabled!==false ||
          Object.hasOwn(result.decisions, service)
        )
          return false;
        result.pending = {
          id: randomUUID(),
          service,
          target,
          action,
          projectTitle: project.title,
        };
        await report("awaiting_approval", `${action} 승인 대기 중`);
        return true;
      };
      temp = await mkdtemp(join(tmpdir(), "hands-off-delivery-"));
      const files = snapshot.files.filter(
        (file) => !relativeFile(file.path).some((part) => part.startsWith(".")),
      );
      if (!files.length) throw new Error("배포할 검증 파일이 없습니다.");
      for (const file of files) {
        if (
          digest(file.content) !== file.hash ||
          secretFinding(file.content)
        )
          throw new Error(`배포할 수 없는 파일입니다: ${file.path}`);
        const target = join(temp, ...relativeFile(file.path));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { flag: "wx" });
      }
      if (
        config.github &&
        !result.github &&
        result.decisions.github !== false
      ) {
        await this.workspace.grant(id, state.grantId);
        if (
          await requestApproval(
            "github",
            `${config.accounts.github}/${repoName}`,
            config.repoId
              ? "GitHub 커밋·푸시"
              : "비공개 저장소 생성 및 커밋·푸시",
          )
        )
          return true;
        stage = "github";
        await report("running", "GitHub에 커밋·푸시 중…");
        result.github = await this.pushGitHub(
          id,
          config,
          temp,
          state.repositoryName || project.title,
          state,
        );
        await report("running", "GitHub 푸시 완료");
      }
      if (
        config.vercel &&
        !result.vercel &&
        result.decisions.vercel !== false
      ) {
        await this.workspace.grant(id, state.grantId);
        if (
          await requestApproval(
            "vercel",
            `${config.scope}/${config.target}`,
            config.production ? "Vercel 운영 배포" : "Vercel 미리보기 배포",
          )
        )
          return true;
        stage = "vercel";
        await report("running", "Vercel 배포 중…");
        const cli = await this.resolveCommand("vercel");
        if (
          !cli ||
          (await this.account("vercel", cli).catch(() => null)) !==
            config.accounts.vercel
        )
          throw new Error("저장한 Vercel 계정으로 로그인하세요.");
        const options = { cwd: temp, timeout: 10 * 60 * 1000 };
        try {
          await run(
            cli,
            [
              "link",
              "--yes",
              "--scope",
              config.scope,
              "--project",
              config.target,
            ],
            options,
          );
          const metadata = "handsOffRun=" + state.id;
          let knownUrl;
          if (result.vercelAttempted) {
            const listing = await run(cli, [
              "list", config.target, "--scope", config.scope, "--meta", metadata, "--format", "json",
            ], options).catch(() => {
              throw new Error("이전 Vercel 배포 조회에 실패했습니다. CLI 버전과 로그인 상태를 확인하세요.");
            });
            knownUrl = priorVercelDeployment(listing, state.id);
          }
          if (!knownUrl && (await this.account("vercel", cli).catch(() => null)) !== config.accounts.vercel)
            throw new Error("Vercel 배포 중 계정이 바뀌었습니다.");
          result.vercelAttempted = true;
          await report("running", "Vercel 원격 상태 확인 · 배포 처리 중…");
          const output = knownUrl ?? await run(
            cli,
            [
              "deploy",
              "--meta",
              metadata,
              "--yes",
              "--scope",
              config.scope,
              ...(config.production ? ["--prod"] : []),
            ],
            options,
          );
          const url = output
            .split(/\s+/)
            .find((part) =>
              /^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/i.test(part),
            );
          if (!url) throw new Error("이전 Vercel 요청의 성공 여부를 확인할 수 없습니다. Vercel 대시보드에서 실행 기록을 확인하세요.");
          result.vercel = { url, production: config.production };
        } catch (error) {
          if (/^(?:이전 Vercel|Vercel 배포 중)/.test(error.message)) throw error;
          throw new Error(
            "Vercel 배포에 실패했습니다. 프로젝트 범위와 Vercel 빌드 로그를 확인하세요.",
          );
        }
      }
      await report(
        "completed",
        result.github || result.vercel
          ? "릴리스 처리 완료"
          : "이번 작업의 릴리스를 건너뛰었습니다.",
      );
      return true;
    } catch (error) {
      if (result) await report("failed", error.message).catch(() => {});
      else if (answer) throw error;
    } finally {
      try {
        if (temp)
          await rm(temp, {
            recursive: true,
            force: true,
            maxRetries: 4,
            retryDelay: 150,
          });
      } finally {
        this.running.delete(id);
        if (result?.pending)
          this.notify({
            type: "delivery",
            projectId: id,
            result: structuredClone(result),
          });
      }
    }
  }

  async pushGitHub(id, config, cwd, suggestedName, state) {
    const gh = await this.resolveCommand("github");
    const git = await findExecutable("git");
    if (
      !gh ||
      !git ||
      (await this.account("github", gh).catch(() => null)) !==
        config.accounts.github
    )
      throw new Error("Git과 저장한 GitHub 계정의 CLI 로그인이 필요합니다.");
    const name =
      config.resolvedName || config.name || repositoryName(suggestedName, id);
    const repo = `${config.accounts.github}/${name}`;
    const token = await this.execute(gh, ["auth", "token", "--hostname", "github.com", "--user", config.accounts.github])
      .catch(() => null);
    if (!token || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error("저장한 GitHub 계정의 자격증명을 확인하지 못했습니다.");
    const githubEnv = { ...serviceEnvironment(), GH_HOST: "github.com", GH_TOKEN: token };
    if ((await this.account("github", gh, { env: githubEnv }).catch(() => null)) !== config.accounts.github)
      throw new Error("GitHub 자격증명의 계정이 저장한 배포 계정과 다릅니다.");
    const view = async () =>
      JSON.parse(
        await this.execute(gh, [
          "repo",
          "view",
          repo,
          "--json",
          "id,isPrivate,nameWithOwner",
        ], { env: githubEnv }),
      );
    try {
      if (!config.repoId) {
        await this.execute(gh, ["repo", "create", repo, "--private"], { env: githubEnv });
        const created = await view();
        config.repoId = created.id;
        await this.projects.mutate((data) => {
          const stored = this.projects.find(data, id).delivery;
          if (stored?.revision !== config.revision)
            throw new Error("배포 설정이 변경됐습니다.");
          stored.repoId = created.id;
          stored.resolvedName = name;
        });
      }
      const current = await view();
      if (
        !current.isPrivate ||
        current.id !== config.repoId ||
        current.nameWithOwner.toLowerCase() !== repo.toLowerCase()
      )
        throw new Error("Unexpected repository identity");
      const env = nativeEnvironment();
      for (const key of Object.keys(env))
        if (/^GIT_/i.test(key)) delete env[key];
      Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(cwd, ".git", "hands-off-empty-config"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      });
      const url = `https://github.com/${repo}.git`;
      const gitRun = (...args) =>
        run([git], args, { cwd, env, timeout: 90000 });
      await gitRun("init", "--initial-branch=main", "--template=");
      let parent;
      if (await gitRun("ls-remote", url, "refs/heads/main")) {
        await gitRun("fetch", "--no-tags", url, "refs/heads/main");
        await gitRun("reset", "--soft", "FETCH_HEAD");
        parent = await gitRun("rev-parse", "HEAD");
      }
      await gitRun("add", "--all", "--", ".");
      const { commit, key, bundle } = await pushVerifiedCommit({
        gitRun, url, cwd, store: this.store, parent,
        identity: [id, state.id, state.snapshotHash, config.revision, config.repoId],
        expectedParent: config.lastCommit, account: config.accounts.github,
      });
      await this.projects.mutate((data) => {
        const stored = this.projects.find(data, id).delivery;
        if (stored?.revision === config.revision) stored.lastCommit = commit;
      });
      await this.store.remove(key).catch(() => {});
      await rm(bundle, { force: true }).catch(() => {});
      return {
        url: `https://github.com/${repo}`,
        commit,
      };
    } catch {
      throw new Error(
        "GitHub 푸시에 실패했습니다. 로그인, 저장소 이름 중복, 비공개 권한과 원격 변경을 확인하세요.",
      );
    }
  }
}

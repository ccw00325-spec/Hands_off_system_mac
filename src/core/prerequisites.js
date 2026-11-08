import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { access } from 'node:fs/promises';
import { nodeRuntime } from './node-runtime.js';
import { findExecutable } from './providers.js';
import { projectEnvironment } from './child-env.js';

export const INSTALL_SITES = Object.freeze({
  node: 'https://nodejs.org/en/download',
  git: process.platform === 'darwin' ? 'https://git-scm.com/install/mac' : process.platform === 'win32' ? 'https://git-scm.com/install/windows' : 'https://git-scm.com/install/linux',
  gpt: 'https://developers.openai.com/codex/cli',
  claude: 'https://code.claude.com/docs/en/setup',
  grok: 'https://cursor.com/docs/cli/installation',
  gemini: 'https://geminicli.com/docs/get-started/installation/',
  docker: 'https://docs.docker.com/get-started/get-docker/',
});

export function requiredTools(report) {
  if (!report || !Array.isArray(report.rows)) throw new Error('필수 프로그램 상태를 확인하지 못했습니다. 설치 안내에서 다시 확인해 주세요.');
  return report.rows.filter(row => row.required === true && row.state !== 'ready');
}

export async function requireTools(scan, action) {
  const report = await scan(), missing = requiredTools(report);
  if (missing.length) throw Object.assign(new Error(`설치를 진행해주세요. ${missing.map(row => row.label).join(' · ')} 준비가 끝나야 AI 작업과 앱 제작을 시작할 수 있습니다.`), { code: 'PREREQUISITES_REQUIRED', prerequisites: report });
  return action ? action(report) : report;
}

export function probeTool(executable, args, timeout = 5000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: homedir(), shell: false, windowsHide: true, env: projectEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', done = false;
    const finish = (code = -1) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, output }); };
    const timer = setTimeout(() => { child.kill(); finish(); }, timeout);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 32000) { child.kill(); finish(); } });
    child.once('error', () => finish()); child.once('close', finish);
  });
}

export class Prerequisites {
  constructor({ find = findExecutable, node = nodeRuntime, probe = probeTool } = {}) { Object.assign(this, { find, node, probe }); this.current = null; }
  async scan(status, { providers = ['gpt', 'grok', 'claude'], executionBackend = 'docker', dockerImage = 'node:24-bookworm-slim' } = {}) {
    const [node, git, docker] = await Promise.all([this.node(), this.find('git'), this.find('docker')]);
    const gitStub = process.platform === 'darwin' && git === '/usr/bin/git' && (await this.probe('/usr/bin/xcode-select', ['-p'])).code !== 0;
    const [nodeInfo, gitInfo, dockerInfo] = await Promise.all([
      node ? this.probe(node, ['--version']) : null,
      git && !gitStub ? this.probe(git, ['--version']) : null,
      docker ? this.probe(docker, ['info', '--format', '{{.ServerVersion}}'], 5000) : null,
    ]);
    const imageReady = dockerInfo?.code === 0 && (await this.probe(docker, ['image', 'inspect', '--format', '{{.Os}}', dockerImage])).code === 0;
    const version = row => row?.code === 0 ? row.output.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null : null;
    const nodeVersion = version(nodeInfo);
    let npm = false;
    if (node) for (const suffix of ['node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npm-cli.js', '../share/nodejs/npm/bin/npm-cli.js'])
      if (await access(join(dirname(node), suffix)).then(() => true, () => false)) { npm = true; break; }
    const rows = [
      { id: 'node', label: 'Node.js 24+ · npm', state: !node ? 'missing' : !nodeVersion ? 'unknown' : Number(nodeVersion.split('.')[0]) < 24 ? 'outdated' : !npm ? 'npm-missing' : 'ready', version: nodeVersion, required: true, purpose: 'JavaScript 앱 실행, 라이브러리 설치, 테스트·빌드와 일부 AI CLI를 구동합니다. 준비 전에는 설정·연결과 기록을 확인할 수 있지만 AI 작업과 앱 제작은 시작할 수 없습니다.' },
      { id: 'git', label: 'Git · GitHub 전송 기반', state: !git || gitStub ? 'missing' : version(gitInfo) ? 'ready' : 'unknown', version: version(gitInfo), required: false, purpose: '코드 변경 이력을 커밋으로 남기고 GitHub에 올려 백업·공유할 때 사용합니다. Git은 로컬 도구이며 GitHub 계정 연결은 왼쪽 ‘보조 서비스 연결’에서 별도로 진행합니다. 로컬 작업만 할 때는 선택입니다.' },
      { id: 'docker', label: 'Docker · 격리 실행', state: !docker ? 'missing' : dockerInfo?.code !== 0 ? 'not-running' : imageReady ? 'ready' : 'image-missing', version: version(dockerInfo), required: executionBackend === 'docker', purpose: `프로젝트 테스트·빌드를 PC와 분리해 실행합니다. ${executionBackend === 'docker' ? '현재 Docker 실행을 선택했으므로 작업 시작에 필수입니다.' : '현재 PC 직접 실행을 선택했으므로 선택입니다.'} 엔진과 로컬 이미지 ${dockerImage}가 필요하며, 없을 때 PC 직접 실행으로 자동 전환하지 않습니다.` },
      ...Object.entries({ gpt: 'GPT · Codex CLI', claude: 'Claude Code', grok: 'Cursor Agent CLI', gemini: 'Gemini CLI' }).map(([id, label]) => ({ id, label, state: status?.[id]?.installed ? 'ready' : 'missing', required: providers.includes(id), purpose: ({
        gpt: 'ChatGPT 계정으로 GPT 작업·대화와 코드 작성을 실행합니다. GPT를 API로 연결할 때는 이 CLI가 없어도 됩니다.',
        claude: 'Claude 계정으로 코드 작성·UI 구현·검토 등 배정한 역할을 실행합니다.',
        grok: 'Cursor 계정과 선택한 모델로 코드 작성·디버깅·검토를 실행합니다. Grok 모델도 Cursor가 제공하는 목록에서 선택합니다.',
        gemini: 'Gemini 계정으로 설계·코드 작성·검토 등 배정한 역할을 실행합니다. 이미지 API 연결과는 별개입니다.',
      })[id] + (providers.includes(id) ? ' 현재 팀에서 사용하므로 설치가 필요합니다.' : ' 현재 팀에서 사용하지 않으므로 선택입니다.'), version: status?.[id]?.version ?? null,
      ...(status?.[id]?.installState ? { state: status[id].installState } : {}) })),
    ];
    this.current = { checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, rows, needsAttention: rows.some(row => row.required && row.state !== 'ready') };
    return structuredClone(this.current);
  }
}

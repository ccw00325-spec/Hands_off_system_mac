import { execFile } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { win32, posix } from 'node:path';

// Discover public application binaries only. Authentication stays with the
// official engine; never read/copy app cookies, auth.json or another OS user.
const FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';
export function isCodexAppAlias(binary, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || !env.LOCALAPPDATA || !binary) return false;
  const relative = win32.relative(win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'), binary);
  return relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative);
}
export function desktopCodexCandidates({ platform = process.platform, env = process.env, home = homedir(), packages = [] } = {}) {
  const p = platform === 'win32' ? win32 : posix;
  if (platform === 'darwin') return ['/Applications', p.join(home, 'Applications')].map(root => ({ root: p.join(root, 'Codex.app'), binary: p.join(root, 'Codex.app', 'Contents', 'Resources', 'codex') }));
  if (platform !== 'win32') return [];
  return packages.filter(item => item.PackageFamilyName === FAMILY && [3, 'Store'].includes(item.SignatureKind) && typeof item.InstallLocation === 'string' && /^[a-z]:\\/i.test(item.InstallLocation))
    .map(item => ({ root: item.InstallLocation, binary: p.join(item.InstallLocation, 'app', 'resources', 'codex.exe') }));
}

function installedPackages() {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return Promise.resolve([]);
  return new Promise(resolve => {
    execFile(win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-AppxPackage -Name OpenAI.Codex | Select-Object PackageFamilyName,InstallLocation,SignatureKind | ConvertTo-Json -Compress",
    ], { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 64000, cwd: homedir() }, (error, stdout) => {
      try { const data = error ? [] : JSON.parse(stdout || '[]'); resolve(Array.isArray(data) ? data : data ? [data] : []); } catch { resolve([]); }
    });
  });
}

export function createDesktopCodexFinder({ platform = process.platform, env = process.env, home = homedir(), packages = installedPackages, fileStat = stat, canonical = realpath, now = Date.now } = {}) {
  let saved = null, expires = 0, pending = null;
  const p = platform === 'win32' ? win32 : posix;
  async function valid(candidate) {
    try {
      if (!(await fileStat(candidate.binary)).isFile()) return false;
      const [root, binary] = await Promise.all([canonical(candidate.root), canonical(candidate.binary)]);
      const relative = p.relative(root, binary);
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + p.sep) && !p.isAbsolute(relative);
    } catch { return false; }
  }
  return async function find() {
    if (pending) return pending;
    if (now() < expires && (!saved || await valid(saved))) return saved?.binary ?? null;
    if (pending) return pending;
    pending = (async () => {
      saved = null;
      const candidates = desktopCodexCandidates({ platform, env, home, packages: platform === 'win32' ? await packages() : [] });
      for (const candidate of candidates) if (await valid(candidate)) { saved = candidate; break; }
      expires = now() + (saved ? 60000 : 15000);
      return saved?.binary ?? null;
    })().finally(() => { pending = null; });
    return pending;
  };
}

export const findDesktopCodex = createDesktopCodexFinder();

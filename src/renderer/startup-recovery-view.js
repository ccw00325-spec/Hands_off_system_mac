import { PROVIDERS, CAPABILITIES } from '../core/team.js';
import { disconnectedTeam } from '../core/startup-recovery.js';

export function createStartupRecovery({ currentProject, state, models, login, replace, modelSetup, notice }) {
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const dialog = node('dialog'); dialog.id = 'startup-recovery-dialog'; dialog.setAttribute('aria-labelledby', 'startup-recovery-title');
  const heading = node('header'), title = node('h2'), close = node('button', '×'), body = node('div'), footer = node('footer');
  heading.className = 'dialog-heading'; title.id = 'startup-recovery-title'; close.type = 'button'; close.className = 'icon-button'; close.id = 'startup-recovery-close'; close.setAttribute('aria-label', '연결 확인 나중에 하기');
  body.className = 'startup-recovery-body'; footer.className = 'startup-recovery-footer'; heading.append(title, close); dialog.append(heading, body, footer); document.body.append(dialog);
  let running = false;
  const pause = () => new Promise(resolve => setTimeout(resolve, 250));
  function prompt(entry, team, connections) {
    return new Promise(resolve => {
      let busy = false;
      const finish = value => { if (busy) return; dialog.close(); resolve(value); };
      close.onclick = () => finish({ action: 'later' });
      dialog.oncancel = event => { event.preventDefault(); finish({ action: 'later' }); };
      dialog.onclose = () => { if (!busy) resolve({ action: 'later' }); };
      const add = (id, label, action) => { const button = node('button', label); button.id = id; button.type = 'button'; button.onclick = action; footer.append(button); return button; };
      const choose = () => {
        title.textContent = `${PROVIDERS[entry.provider]} 대신 사용할 AI`;
        body.replaceChildren(); footer.replaceChildren();
        const explanation = node('p', '역할과 패널 수는 유지하고, 해당 AI가 맡던 모든 패널을 새 AI로 교체합니다. 제외한 AI로 돌아가는 대체 경로는 삭제합니다.'), providerLabel = node('label', '새로운 AI'), select = node('select'), modelLabel = node('label', '사용할 모델'), model = node('select'), hint = node('p'), error = node('p');
        select.id = 'startup-replacement-provider'; model.id = 'startup-replacement-model'; providerLabel.htmlFor = select.id; modelLabel.htmlFor = model.id; hint.className = 'hint'; error.className = 'hint error'; error.setAttribute('role', 'alert');
        const choices = Object.keys(PROVIDERS).filter(id => id !== entry.provider).sort((a, b) => Number(connections[b]?.connected === true) - Number(connections[a]?.connected === true));
        for (const provider of choices) select.append(new Option(`${PROVIDERS[provider]} · ${connections[provider]?.connected ? '연결됨' : '연결 필요'}`, provider));
        const updateModels = () => {
          const rows = models(select.value), explicit = ['grok', 'gemini'].includes(select.value);
          model.replaceChildren(new Option(explicit ? '모델을 선택하세요' : '현재 계정 설정으로 자동 선택', ''), ...rows.map(row => new Option(row.name ?? row.id, row.id)));
          if (explicit && rows.length) model.value = (rows.find(row => row.isDefault || row.current) ?? rows[0]).id;
          hint.textContent = connections[select.value]?.connected ? explicit && !rows.length ? '모델 목록을 준비하지 못했습니다. 저장 후 계정·모델 화면에서 선택하세요.' : '저장 즉시 다음 작업부터 사용하며, 다음 실행과 새 프로젝트에도 이 구성을 사용합니다.' : '구성을 저장한 뒤 공식 로그인·설치 화면으로 안내합니다. 승인 전에는 연결됨으로 표시하지 않습니다.';
        };
        select.onchange = updateModels; updateModels(); body.append(explanation, providerLabel, select, modelLabel, model, hint, error);
        add('startup-replacement-back', '이전', ask);
        const save = add('startup-replacement-save', '이 AI로 교체·저장', async () => {
          busy = true; for (const button of dialog.querySelectorAll('button')) button.disabled = true; select.disabled = model.disabled = true;
          save.textContent = '교체·저장 중…';
          try {
            if (['grok', 'gemini'].includes(select.value) && models(select.value).length && !model.value) throw Error('사용할 모델을 선택하세요.');
            const ready = await replace(entry, select.value, model.value);
            busy = false; finish({ action: 'replaced', provider: select.value, modelId: model.value, connected: ready.connected });
          } catch (e) { error.textContent = e.message; }
          finally { busy = false; for (const button of dialog.querySelectorAll('button')) button.disabled = false; select.disabled = model.disabled = false; save.textContent = '이 AI로 교체·저장'; }
        }); save.className = 'primary';
      };
      const ask = () => {
        const lost = ['disconnected', 'authentication-required', 'not-connected'].includes(entry.state);
        title.textContent = `${PROVIDERS[entry.provider]} ${lost ? '로그인을 다시 연결할까요?' : '연결을 확인해 주세요'}`;
        body.replaceChildren(node('p', lost ? '저장된 로그인으로 연결되지 않았습니다. 다시 로그인하시겠습니까?' : '실행 도구 또는 네트워크 문제로 인증을 확인하지 못했습니다. 구독 해지 여부는 이 상태만으로 판단할 수 없습니다.'));
        const roles = [...new Set(team.filter(row => row.provider === entry.provider).flatMap(row => row.roles))].map(role => CAPABILITIES[role]).join(' · ');
        body.append(node('p', `현재 담당: ${roles}`), node('p', '‘아니요’를 선택하면 다른 AI로 빠르게 교체할 수 있습니다. 바꾸기 전까지 기존 설정은 유지되며 로그인을 자동으로 시작하지 않습니다.'));
        footer.replaceChildren(); add('startup-recovery-later', '나중에', () => finish({ action: 'later' }));
        add('startup-recovery-no', '아니요, AI 바꾸기', choose);
        add('startup-recovery-yes', '예, 다시 로그인', () => finish({ action: 'login' })).className = 'primary';
      };
      ask(); dialog.showModal();
    });
  }
  return { async begin({ enabled, projectId }) {
    if (!enabled || running) return;
    running = true; dialog.dataset.state = 'checking'; const handled = new Set();
    try {
      while (currentProject() === projectId) {
        while (document.querySelector('dialog[open]') && currentProject() === projectId) await pause();
        if (currentProject() !== projectId) break;
        const snapshot = await state(projectId);
        if (currentProject() !== projectId) break;
        if (document.querySelector('dialog[open]')) continue;
        const entry = disconnectedTeam(snapshot.team, snapshot.connections).find(row => !handled.has(row.provider));
        if (!entry) break;
        entry.projectId = projectId;
        const answer = await prompt(entry, snapshot.team, snapshot.connections); handled.add(entry.provider);
        if (currentProject() !== projectId) break;
        if (answer.action === 'login') await login(entry.actor);
        if (answer.action === 'replaced') {
          handled.add(answer.provider);
          if (!answer.connected) await login(entry.actor);
          else if (['grok', 'gemini'].includes(answer.provider) && !answer.modelId) modelSetup(answer.provider);
        }
      }
    } catch (error) { notice(error.message, 'error'); }
    finally { running = false; dialog.dataset.state = 'idle'; }
  } };
}

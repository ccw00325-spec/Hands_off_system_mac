import {preferenceQuestion} from '../core/autopilot-policy.js';
const $ = selector => document.querySelector(selector);
const node = (tag, text) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  return item;
};

export function createClarifications({ submit, changed, error }) {
  const dialog = $('#fun-questions-dialog');
  const form = $('#fun-questions-form');
  const fields = $('#fun-question-fields');
  let current = null, displayed = null, busy = false;
  const deferred = new Set(), drafts = new Map(), remembered=new Map();
  const key = run => run && `${run.id}:${run.questionBatchId}`;
  function close() { if (dialog.open) dialog.close(); }
  function defer() { if (current) deferred.add(key(current)); close(); }
  function open(force = false) {
    if (!current || current.status !== 'needs_input' || !current.questionBatchId || busy) return;
    if (!force && deferred.has(key(current))) return;
    if ([...document.querySelectorAll('dialog[open]')].some(row => row !== dialog)) return;
    if (displayed !== key(current)) {
      displayed = key(current);
      fields.replaceChildren();
      $('#fun-questions-title').textContent = current.questionSource==='critical-challenge'?'독립 비판 검증 · 전제를 확인해 주세요':current.options.funEnabled === false ? '진행 전 확인이 필요해요' : '/fun · 요구사항의 빈칸을 채워 주세요';
      $('#fun-questions-context').textContent = current.request;
      const draft = drafts.get(displayed) ?? new Map(); drafts.set(displayed, draft);
      for (const question of current.questions) {
        const field = node('fieldset'); field.dataset.questionId = question.id;
        field.append(node('legend', question.prompt));
        for (const [index, value] of question.options.entries()) {
          const label = node('label'); label.className = 'fun-choice';
          const input = node('input'); input.type = 'radio'; input.name = question.id; input.value = String(index);
          input.checked = draft.get(question.id)?.kind === 'option' && draft.get(question.id)?.value === value;
          input.onchange = () => { draft.set(question.id, { kind: 'option', value }); text.disabled = true; };
          label.append(input, node('span', value)); field.append(label);
        }
        const label = node('label'); label.className = 'fun-choice';
        const custom = node('input'); custom.type = 'radio'; custom.name = question.id; custom.value = 'text';
        custom.checked = draft.get(question.id)?.kind === 'text';
        label.append(custom, node('span', '위 선택지와 다르다면 직접 입력')); field.append(label);
        const text = node('textarea'); text.maxLength = 4000; text.rows = 3;
        text.setAttribute('aria-label', question.prompt + ' · 직접 답변'); text.placeholder = '원하는 조건이나 동작을 자유롭게 적어 주세요.';
        text.value = draft.get(question.id)?.kind === 'text' ? draft.get(question.id).value : '';
        text.disabled = !custom.checked;
        custom.onchange = () => { text.disabled = false; draft.set(question.id, { kind: 'text', value: text.value }); text.focus(); };
        text.oninput = () => draft.set(question.id, { kind: 'text', value: text.value });
        field.append(text);
        if(preferenceQuestion(question,current.questionSource)){
          const label=node('label'),remember=node('input');remember.type='checkbox';remember.dataset.rememberQuestion=question.id;const selected=remembered.get(displayed)??new Set();remembered.set(displayed,selected);remember.checked=selected.has(question.id);remember.onchange=()=>remember.checked?selected.add(question.id):selected.delete(question.id);label.className='check-label';label.append(remember,node('span','같은 프로젝트·요청·질문에 이 답변 기억하기'));field.append(label);
        }
        fields.append(field);
      }
    }
    if (!dialog.open) dialog.showModal();
  }
  $('#close-fun-questions').onclick = defer;
  $('#defer-fun-questions').onclick = defer;
  $('#answer-fun-questions').onclick = () => open(true);
  dialog.addEventListener('cancel', event => { event.preventDefault(); defer(); });
  document.addEventListener('close', () => { setTimeout(() => open(), 0); }, true);
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !current) return;
    const draft = drafts.get(displayed) ?? new Map();
    if (current.questions.some(question => !draft.get(question.id)?.value?.trim())) {
      $('#fun-questions-error').textContent = '각 질문의 선택지를 고르거나 직접 답변을 입력하세요.';
      return;
    }
    const scope = current;
    const answers = scope.questions.map(question => ({ id: question.id, ...draft.get(question.id) }));
    busy = true; $('#submit-fun-questions').disabled = true; $('#fun-questions-error').textContent = '';
    try {
      const state = await submit(scope, answers,[...(remembered.get(displayed)??[])]);
      deferred.add(key(scope)); drafts.delete(key(scope)); close(); changed(state);
    } catch (failure) { $('#fun-questions-error').textContent = failure.message; error(failure); }
    finally { busy = false; $('#submit-fun-questions').disabled = false; open(); }
  };
  return {
    update(run) {
      current = run;
      $('#answer-fun-questions').hidden = run?.status !== 'needs_input' || !run.questionBatchId;
      if (!current || displayed !== key(current) || current.status !== 'needs_input') close();
      open();
    },
    open: () => open(true),
  };
}

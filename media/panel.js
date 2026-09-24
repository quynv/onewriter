(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    file: document.getElementById('file'),
    meta: document.getElementById('meta'),
    comment: document.getElementById('comment'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    anki: document.getElementById('anki'),
  };

  const i18n = window.__i18n || {};
  const t = (key, params) =>
    (i18n[key] || key).replace(/\{(\w+)\}/g, (whole, name) =>
      params && name in params ? params[name] : whole,
    );

  document.getElementById('empty').textContent = t('panel.empty');

  el.anki.addEventListener('click', () => vscode.postMessage({ type: 'anki' }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'empty') {
      render(null);
    } else if (message.type === 'render') {
      render(message.payload);
    }
  });

  function render(payload) {
    el.list.replaceChildren();

    if (!payload) {
      el.file.textContent = t('panel.nothing');
      el.meta.textContent = '';
      el.comment.textContent = '';
      el.anki.hidden = true;
      el.empty.hidden = false;
      return;
    }

    el.file.textContent = payload.fileName || t('panel.text');
    el.empty.hidden = true;
    el.comment.textContent = payload.comment || '';
    el.anki.hidden = payload.chunkCount === 0;
    el.anki.textContent = t('panel.saveChunks', { count: payload.chunkCount });

    const remaining = payload.issues.filter((i) => !i.done).length;
    el.meta.textContent =
      remaining === 0
        ? `${payload.level} · ${t('panel.allDone')}`
        : `${payload.level} · ${t('panel.progress', {
            remaining: remaining,
            total: payload.issues.length,
          })}`;

    for (const issue of payload.issues) {
      el.list.appendChild(card(issue));
    }
  }

  function card(issue) {
    const root = document.createElement('div');
    root.className = issue.done ? 'issue done' : 'issue';
    root.dataset.severity = String(issue.severity);

    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = t('category.' + issue.category);
    if (issue.grammarPoint) {
      tag.append(' · ');
      const code = document.createElement('code');
      code.textContent = issue.grammarPoint;
      tag.appendChild(code);
    }
    root.appendChild(tag);

    const split = document.createElement('div');
    split.className = 'split';
    split.appendChild(side('before', issue.original, () => reveal(issue.id)));
    split.appendChild(side('after', issue.replacement, () => reveal(issue.id)));
    root.appendChild(split);

    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = issue.explanation;
    root.appendChild(why);

    if (!issue.done) {
      const actions = document.createElement('div');
      actions.className = 'actions';

      const apply = document.createElement('button');
      apply.textContent = t('action.apply');
      apply.addEventListener('click', () => vscode.postMessage({ type: 'apply', id: issue.id }));

      const skip = document.createElement('button');
      skip.className = 'ghost';
      skip.textContent = t('action.keep');
      skip.addEventListener('click', () => vscode.postMessage({ type: 'skip', id: issue.id }));

      actions.append(apply, skip);
      root.appendChild(actions);
    }

    return root;
  }

  function side(kind, text, onClick) {
    const node = document.createElement('div');
    node.className = `side ${kind}`;
    node.textContent = text;
    node.title = t('panel.jump');
    node.addEventListener('click', onClick);
    return node;
  }

  function reveal(id) {
    vscode.postMessage({ type: 'reveal', id });
  }

  vscode.postMessage({ type: 'ready' });
})();

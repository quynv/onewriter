(function () {
  const vscode = acquireVsCodeApi();

  const i18n = window.__i18n || {};
  const t = (key, params) =>
    (i18n[key] || key).replace(/\{(\w+)\}/g, (whole, name) =>
      params && name in params ? params[name] : whole,
    );

  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }

  const el = {
    target: document.getElementById('target'),
    context: document.getElementById('context'),
    provider: document.getElementById('provider'),
    anki: document.getElementById('anki'),
    chunkEmpty: document.getElementById('chunk-empty'),
    chunkList: document.getElementById('chunk-list'),
    saveChunks: document.getElementById('save-chunks'),
    clearChunks: document.getElementById('clear-chunks'),
  };

  for (const button of document.querySelectorAll('button[data-command]')) {
    button.addEventListener('click', () =>
      vscode.postMessage({ type: 'command', value: button.dataset.command }),
    );
  }

  document.getElementById('settings').addEventListener('click', () =>
    vscode.postMessage({ type: 'openSettings' }),
  );

  document.getElementById('check').addEventListener('click', () => {
    el.anki.textContent = t('sidebar.checking');
    el.anki.classList.remove('bad');
    vscode.postMessage({ type: 'checkAnki' });
  });

  document.getElementById('clear-chunks').addEventListener('click', () =>
    vscode.postMessage({ type: 'clearChunks' }),
  );

  document.getElementById('clean-chunks').addEventListener('click', () =>
    vscode.postMessage({ type: 'cleanChunks' }),
  );

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () =>
      vscode.postMessage({ type: 'reviewMode', value: radio.value }),
    );
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      renderState(message.payload);
    } else if (message.type === 'anki') {
      el.anki.textContent = message.text;
      el.anki.classList.toggle('bad', !message.ok);
    }
  });

  function renderState(s) {
    el.target.textContent = `${s.language.toUpperCase()} · ${s.level}`;

    const parts = [];
    if (s.fileName) {
      parts.push(s.fileName);
    }
    if (s.topic) {
      parts.push(s.topic);
    }
    if (s.issueCount !== null) {
      parts.push(t('sidebar.remaining', { count: s.issueCount }));
    }
    if (s.chunkCount) {
      parts.push(t('sidebar.chunksWaiting', { count: s.chunkCount }));
    }
    el.context.textContent = parts.length ? parts.join(' · ') : t('sidebar.noFile');

    el.provider.textContent = s.provider;
    renderQueuedChunks(s.queuedChunks || []);

    const radio = document.querySelector(`input[name="mode"][value="${s.reviewMode}"]`);
    if (radio) {
      radio.checked = true;
    }
  }

  function renderQueuedChunks(items) {
    el.chunkList.replaceChildren();
    el.chunkEmpty.hidden = items.length > 0;
    el.saveChunks.disabled = items.length === 0;
    el.clearChunks.disabled = items.length === 0;

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'chunk-row';
      row.setAttribute('role', 'listitem');

      const content = document.createElement('div');
      const chunk = document.createElement('div');
      chunk.className = 'chunk-text';
      chunk.textContent = item.chunk;
      const context = document.createElement('div');
      context.className = 'chunk-context';
      context.textContent = item.context;
      content.append(chunk, context);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chunk-remove';
      remove.textContent = '×';
      const removeLabel = t('sidebar.removeChunk', { chunk: item.chunk });
      remove.title = removeLabel;
      remove.setAttribute('aria-label', removeLabel);
      remove.addEventListener('click', () =>
        vscode.postMessage({ type: 'removeChunk', id: item.id }),
      );

      row.append(content, remove);
      el.chunkList.append(row);
    }
  }

  vscode.postMessage({ type: 'ready' });
})();

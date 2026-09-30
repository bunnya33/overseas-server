const $ = (selector) => document.querySelector(selector);
let state = null;
let editingId = null;
let toastTimer = null;

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = error ? 'toast error' : 'toast';
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 4500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/admin/login') showLogin();
    throw new Error(result.error || `HTTP ${response.status}`);
  }
  return result;
}

function showLogin() {
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
}

function selectView(view) {
  $('#nodes-view').hidden = view !== 'nodes';
  $('#account-view').hidden = view !== 'account';
  $('#breadcrumb').textContent = view === 'nodes' ? '服务器节点' : '账号设置';
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.view === view);
  });
}

function stateText(summary, enabled) {
  if (!enabled) return '已停用';
  return { healthy: '正常', degraded: '波动', down: '中断', waiting: '等待采样' }[summary?.state] || '待检测';
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function actionButton(label, action, id, className = '') {
  const button = makeElement('button', className, label);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

function render() {
  const targets = state.targets || [];
  const active = targets.find((target) => target.id === state.activeTargetId);
  $('#account-name').textContent = state.admin.username;
  $('#active-node-name').textContent = active?.label || '尚未选择';
  $('#active-node-state').textContent = active ? stateText(active.summary, active.enabled) : '未配置';
  $('#node-count').textContent = `${targets.length} 台`;
  $('#list-updated').textContent = `共 ${targets.length} 台服务器`;
  $('#override-notice').hidden = !state.environmentOverride;

  const list = $('#node-list');
  if (!targets.length) {
    list.replaceChildren(makeElement('div', 'empty-list'));
    const empty = list.firstChild;
    empty.append(makeElement('strong', '', '还没有保存的服务器'));
    empty.append(makeElement('p', '', '添加国外服务器后即可开始监测并在节点之间切换。'));
    return;
  }

  list.replaceChildren(...targets.map((target) => {
    const isActive = target.id === state.activeTargetId;
    const row = makeElement('article', `node-row${isActive ? ' active' : ''}`);
    const name = makeElement('div', 'node-name');
    name.append(makeElement('strong', '', target.label));
    name.append(makeElement('small', '', isActive ? '当前使用' : target.enabled ? '已保存' : '已停用'));
    const endpoint = makeElement('div', 'node-endpoint');
    endpoint.append(makeElement('span', '', `${target.host}:${target.port}`));
    endpoint.append(makeElement('small', '', `${target.mode.toUpperCase()} · ${target.speedTestUrl ? '带宽探针已配置' : '未配置带宽探针'}`));
    const badge = makeElement('span', `state ${target.summary?.state || ''}`, stateText(target.summary, target.enabled));
    const actions = makeElement('div', 'row-actions');
    if (!isActive) actions.append(actionButton('设为当前', 'activate', target.id, 'activate'));
    actions.append(actionButton('测试', 'test', target.id));
    actions.append(actionButton('编辑', 'edit', target.id));
    actions.append(actionButton('删除', 'delete', target.id, 'delete'));
    row.append(name, endpoint, badge, actions);
    return row;
  }));
}

async function refresh() {
  state = await api('/api/admin/state');
  render();
}

function openDialog(target = null) {
  editingId = target?.id || null;
  const form = $('#node-form');
  form.reset();
  $('#dialog-title').textContent = target ? `编辑 · ${target.label}` : '新增节点';
  if (target) {
    for (const name of ['label', 'host', 'port', 'mode', 'speedTestUrl', 'speedTestToken']) {
      form.elements[name].value = target[name] ?? '';
    }
    form.elements.enabled.checked = target.enabled !== false;
  }
  $('#node-dialog').showModal();
  form.elements.label.focus();
}

function closeDialog() {
  $('#node-dialog').close();
  editingId = null;
}

async function saveNode(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('#save-node');
  const body = Object.fromEntries(new FormData(form));
  body.port = Number(body.port);
  body.enabled = form.elements.enabled.checked;
  submit.disabled = true;
  try {
    await api(editingId ? `/api/admin/targets/${encodeURIComponent(editingId)}` : '/api/admin/targets', {
      method: editingId ? 'PUT' : 'POST', body: JSON.stringify(body),
    });
    closeDialog();
    await refresh();
    toast('节点已保存');
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function handleNodeAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || !state) return;
  const target = state.targets.find((item) => item.id === button.dataset.id);
  if (!target) return;
  const action = button.dataset.action;
  if (action === 'edit') { openDialog(target); return; }
  if (action === 'delete' && !window.confirm(`删除“${target.label}”？此操作会移除保存的节点配置。`)) return;
  button.disabled = true;
  try {
    if (action === 'activate') {
      await api(`/api/admin/targets/${encodeURIComponent(target.id)}/activate`, { method: 'POST' });
      toast(`已切换到 ${target.label}`);
    } else if (action === 'test') {
      toast(`正在测试 ${target.label}`);
      const result = await api(`/api/admin/targets/${encodeURIComponent(target.id)}/test`, { method: 'POST' });
      const connection = result.connection.ok ? `探测端口可达 ${result.connection.latencyMs} ms` : `探测端口异常：${result.connection.error}`;
      const agent = result.agent.configured
        ? result.agent.ok ? `测速探针可达 ${result.agent.latencyMs} ms` : `测速探针异常：${result.agent.error}`
        : '未配置测速探针';
      toast(`${connection}；${agent}`, !result.connection.ok || result.agent.ok === false);
    } else if (action === 'delete') {
      await api(`/api/admin/targets/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      toast('节点已删除');
    }
    if (action !== 'test') await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (values.newPassword !== values.confirmPassword) {
    toast('两次输入的新密码不一致', true);
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/admin/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }),
    });
    form.reset();
    showLogin();
    toast('密码已修改，请重新登录');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.elements.password.value = '';
    await refresh();
    showApp();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  showLogin();
});
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view)));
$('#add-button').addEventListener('click', () => openDialog());
$('#close-dialog').addEventListener('click', closeDialog);
$('#cancel-dialog').addEventListener('click', closeDialog);
$('#node-form').addEventListener('submit', saveNode);
$('#node-list').addEventListener('click', handleNodeAction);
$('#password-form').addEventListener('submit', changePassword);

api('/api/admin/session').then(async (session) => {
  if (!session.authenticated) { showLogin(); return; }
  await refresh();
  showApp();
}).catch(() => showLogin());

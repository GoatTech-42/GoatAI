'use strict';

// Swallow noisy browser-extension errors that have nothing to do with us.
window.addEventListener('error', (e) => {
  const msg = (e && (e.message || e.error?.message)) || '';
  if (/duplicate id|Invalid frameId|runtime\.lastError|chrome-extension:/i.test(msg)) {
    e.preventDefault(); e.stopImmediatePropagation();
    return false;
  }
}, true);
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e && (e.reason?.message || String(e.reason || ''))) || '';
  if (/duplicate id|Invalid frameId|runtime\.lastError/i.test(msg)) e.preventDefault();
});

const $  = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const escapeHtml = (s) => (s ?? '').toString()
  .replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const debounce = (fn, ms) => { let t; return (...a)=>{clearTimeout(t); t=setTimeout(()=>fn(...a), ms);}; };
const estimateTokens = (s) => Math.ceil(((s ?? '') + '').length / 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeMarkdown(text) {
  if (!window.marked) return escapeHtml(text);
  const html = marked.parse(text || '', { breaks: true });
  return (window.DOMPurify ? DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'script'],
  }) : html);
}

function shortenPath(p, home) {
  if (!p) return '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

// ----- HTTP helper -----
async function fetchJson(url, opts = {}) {
  let r;
  try { r = await fetch(url, opts); }
  catch (e) {
    if (e.name === 'AbortError') return { ok: false, status: 0, error: { type: 'aborted', message: 'Aborted' } };
    return { ok: false, status: 0, error: { type: 'network', message: e.message || 'Network error' } };
  }
  const ct = r.headers.get('content-type') || '';
  let data = null;
  try { data = ct.includes('application/json') ? await r.json() : { raw: await r.text() }; }
  catch { data = null; }
  if (!r.ok) {
    const err = (data && data.error) || { type: 'http', status: r.status, message: (data && data.raw) || `HTTP ${r.status}` };
    return { ok: false, status: r.status, error: err };
  }
  return { ok: true, status: r.status, data };
}

// ============================================================
//  CLIENT-SIDE STORAGE  (localStorage — all data stays in the browser)
// ============================================================
const LS = {
  // ── Config ──────────────────────────────────────────────
  DEFAULT_CONFIG: {
    stream: true, web_search_enabled: false, web_search_results: 5,
    default_temperature: 0.7, theme: 'dark',
    default_chat_provider: 'pollinations', default_chat_model: '',
    default_image_provider: 'pollinations', default_image_model: '',
    api_keys: {}, provider_config: {},
    workspace: '', workspace_favorites: [], workspace_history: [],
  },
  getConfig() {
    try { return Object.assign({}, this.DEFAULT_CONFIG, JSON.parse(localStorage.getItem('goatai_config') || '{}')); }
    catch { return Object.assign({}, this.DEFAULT_CONFIG); }
  },
  setConfig(patch) {
    const cfg = this.getConfig();
    // Deep-merge api_keys and provider_config
    if (patch.api_keys) cfg.api_keys = Object.assign(cfg.api_keys || {}, patch.api_keys);
    if (patch.provider_config) {
      cfg.provider_config = cfg.provider_config || {};
      for (const [k, v] of Object.entries(patch.provider_config)) {
        cfg.provider_config[k] = Object.assign(cfg.provider_config[k] || {}, v);
      }
    }
    const flat = Object.assign(cfg, patch);
    // Don't double-merge these — already handled above
    if (patch.api_keys) flat.api_keys = cfg.api_keys;
    if (patch.provider_config) flat.provider_config = cfg.provider_config;
    localStorage.setItem('goatai_config', JSON.stringify(flat));
    return flat;
  },
  // ── Chats ───────────────────────────────────────────────
  getChats() {
    try { return JSON.parse(localStorage.getItem('goatai_chats') || '[]'); }
    catch { return []; }
  },
  getChat(id) {
    return this.getChats().find(c => c.id === id) || null;
  },
  saveChat(id, body) {
    const chats = this.getChats().filter(c => c.id !== id);
    const chat = Object.assign({ id }, body);
    chats.unshift(chat);
    // Keep at most 200 chats
    if (chats.length > 200) chats.splice(200);
    try { localStorage.setItem('goatai_chats', JSON.stringify(chats)); }
    catch(e) {
      // Storage full — drop oldest half and retry
      const trimmed = chats.slice(0, 100);
      try { localStorage.setItem('goatai_chats', JSON.stringify(trimmed)); } catch {}
    }
  },
  deleteChat(id) {
    const chats = this.getChats().filter(c => c.id !== id);
    localStorage.setItem('goatai_chats', JSON.stringify(chats));
  },
  // ── Prompts ─────────────────────────────────────────────
  getPrompts() {
    try { return JSON.parse(localStorage.getItem('goatai_prompts') || '{}'); }
    catch { return {}; }
  },
  savePrompt({ id, name, body }) {
    const prompts = this.getPrompts();
    const pid = id || `prompt_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    prompts[pid] = { id: pid, name, body };
    localStorage.setItem('goatai_prompts', JSON.stringify(prompts));
    return pid;
  },
  deletePrompt(pid) {
    const prompts = this.getPrompts();
    delete prompts[pid];
    localStorage.setItem('goatai_prompts', JSON.stringify(prompts));
  },
  // ── Gallery ─────────────────────────────────────────────
  getGallery() {
    try { return JSON.parse(localStorage.getItem('goatai_gallery') || '[]'); }
    catch { return []; }
  },
  addGalleryItem(item) {
    const items = this.getGallery();
    items.unshift(item);
    if (items.length > 100) items.splice(100);
    try { localStorage.setItem('goatai_gallery', JSON.stringify(items)); }
    catch(e) {
      // Storage full — drop images (they're large base64 strings)
      const trimmed = items.slice(0, 20);
      try { localStorage.setItem('goatai_gallery', JSON.stringify(trimmed)); } catch {}
    }
  },
  deleteGalleryItem(name) {
    const items = this.getGallery().filter(it => it.name !== name);
    localStorage.setItem('goatai_gallery', JSON.stringify(items));
  },
  clearGallery() { localStorage.removeItem('goatai_gallery'); },
};

// ── Helper: build the config payload to send to every API call ─────────────
function _apiConfig() {
  const cfg = state.config || LS.getConfig();
  // Map api_keys: strip __SET__ sentinel — send actual key only
  // Keys are stored verbatim (never __SET__) in this client-side implementation
  return cfg;
}

// ── API: only real network calls remain ────────────────────────────────────
const API = {
  // Metadata from server (providers list, system prompts, model categories)
  config: () => fetchJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: _apiConfig() }),
  }),
  // Per-provider model list (passes keys so paid providers work)
  providerModels: (p) => fetchJson(`/api/providers/${p}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: _apiConfig() }),
  }),
  // Voices
  pollinationsVoices: () => fetchJson('/api/pollinations/voices'),
  openaiVoices:  () => fetchJson('/api/openai/voices'),
  elevenVoices:  (b) => fetchJson('/api/elevenlabs/voices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ config: _apiConfig() }, b || {})),
  }),
  // Agent cancel
  agentCancel:   (runId) => fetchJson(`/api/agent/cancel/${runId}`, { method:'POST' }),
  // Translate
  translate:     (b) => fetchJson('/api/translate', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(Object.assign({ config: _apiConfig() }, b)),
  }),

  // ── Client-side shims (localStorage) ──────────────────────────────────
  saveConfig:    (patch) => { const cfg = LS.setConfig(patch); state.config = cfg; return Promise.resolve({ ok: true, data: { config: cfg } }); },
  setWorkspace:  (workspace) => { const cfg = LS.setConfig({ workspace }); state.config = cfg; return Promise.resolve({ ok: true, data: { workspace } }); },
  chats:         () => Promise.resolve({ ok: true, data: { chats: LS.getChats().map(c => ({ id: c.id, title: c.title, provider: c.provider, model: c.model, message_count: (c.messages||[]).length })) } }),
  getChat:       (id) => { const c = LS.getChat(id); return Promise.resolve(c ? { ok: true, data: { chat: c } } : { ok: false, error: { type: 'not_found', message: 'Chat not found' } }); },
  saveChat:      (id, body) => { LS.saveChat(id, body); return Promise.resolve({ ok: true, data: {} }); },
  deleteChat:    (id) => { LS.deleteChat(id); return Promise.resolve({ ok: true, data: {} }); },
  prompts:       () => Promise.resolve({ ok: true, data: { prompts: LS.getPrompts() } }),
  savePrompt:    (p) => { const pid = LS.savePrompt(p); return Promise.resolve({ ok: true, data: { id: pid } }); },
  deletePrompt:  (pid) => { LS.deletePrompt(pid); return Promise.resolve({ ok: true, data: {} }); },
  gallery:       () => Promise.resolve({ ok: true, data: { items: LS.getGallery() } }),
  galleryDelete: (name) => { LS.deleteGalleryItem(name); return Promise.resolve({ ok: true, data: {} }); },
  galleryClear:  () => { LS.clearGallery(); return Promise.resolve({ ok: true, data: {} }); },
  // Files / shell — not supported on Vercel (serverless)
  fsList:   () => Promise.resolve({ ok: false, error: { type: 'internal', message: 'File system not available in serverless mode.' } }),
  fsRead:   () => Promise.resolve({ ok: false, error: { type: 'internal', message: 'File system not available in serverless mode.' } }),
  fsWrite:  () => Promise.resolve({ ok: false, error: { type: 'internal', message: 'File system not available in serverless mode.' } }),
  fsMkdir:  () => Promise.resolve({ ok: false, error: { type: 'internal', message: 'File system not available in serverless mode.' } }),
  fsDelete: () => Promise.resolve({ ok: false, error: { type: 'internal', message: 'File system not available in serverless mode.' } }),
  shellExec:() => Promise.resolve({ ok: false, error: { type: 'internal', message: 'Shell not available in serverless mode.' } }),
};

// ----- State -----
const state = {
  config: null,
  keepSentinel: '__KEEP__',
  providers: {},
  models: {},
  modelFetches: {},
  warnedProviders: new Set(),
  currentChatId: null,
  currentChat: null,
  chats: [],
  streaming: false,
  streamAbort: null,
  attachment: null,
  webSearchOn: false,
  imageModeOn: false,
  uncensoredOn: false,
  fsCurrentPath: '',
  openFiles: {},
  activeFile: null,
  agentRunId: null,
  agentAbort: null,
  agentStartedAt: 0,
  agentTurnTimer: null,
  agentStats: { turn: 0, turn_max: 0, tool_calls: 0, tok_in: 0, tok_out: 0 },
  theme: 'dark',
  systemPrompts: {},
  userPrompts: {},
  visionModels: {},
  toolModels: {},
  uncensoredModels: {},
  termHistory: [],
  termHistoryIndex: -1,
  chatAutoScroll: true,
  wgpu: {
    available: null,
    pipe: null,
    loading: false,
    model: null,
    device: 'webgpu',
    messages: [],
    generating: false,
    stopFlag: false,
  },
};

const WEBGPU_TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1';

// ----- Errors -----
const ERR_TITLES = {
  auth: 'Authentication failed', rate_limit: 'Rate limited', not_found: 'Not found',
  bad_request: 'Bad request', upstream: 'Provider error', network: 'Network error',
  parse: 'Unexpected response', timeout: 'Request timed out', internal: 'Internal error',
  aborted: 'Request aborted', payment_required: 'Upgrade required',
};
const errTitle = (e) => ERR_TITLES[e && e.type] || 'Error';
function describeError(e) {
  if (!e) return 'Unknown error.';
  if (typeof e === 'string') return e;
  const parts = [e.message || 'Unknown error.'];
  if (e.type === 'rate_limit' && e.retry_after) parts.push(`Retry after ${e.retry_after}s.`);
  if (e.type === 'auth') parts.push('Check your API key in Settings.');
  if (e.type === 'payment_required') parts.push('This model needs a paid tier.');
  return parts.join(' ');
}

// ----- Toast -----
const recentToasts = new Map();
function toast(msg, kind='info', ms=3200) {
  const key = `${kind}:${msg}`;
  const now = Date.now();
  if (now - (recentToasts.get(key) || 0) < 2500) return;
  recentToasts.set(key, now);
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'err' : kind === 'success' ? 'ok' : kind}`;
  el.innerHTML = `<span>${escapeHtml(msg)}</span><button class="toast-close" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>`;
  const remove = () => { el.style.opacity='0'; el.style.transform='translateX(16px)'; el.style.transition='opacity .2s, transform .2s'; setTimeout(()=>el.remove(), 220); };
  const timer = setTimeout(remove, ms);
  el.querySelector('.toast-close').onclick = () => { clearTimeout(timer); remove(); };
  $('toastContainer').appendChild(el);
}

// ----- Modal helpers -----
function openModal(id) { const el = $(id); if (el) el.removeAttribute('hidden'); }
function closeModal(id) {
  const el = $(id);
  if (el) el.setAttribute('hidden', '');
  // If we're closing the prompt-text modal, ALWAYS resolve any pending Promise
  // so the dialog can never end up half-closed (DOM hidden but resolver alive).
  if (id === 'promptTextModal') {
    try { _resolveActivePromptModal(null); } catch (_) {}
  }
}
function closeAllModals() {
  // If a promptModal Promise is still pending, resolve it as cancelled so the
  // caller never gets stuck on `await promptModal(...)` and the dialog can
  // be reopened cleanly later.
  try { if (typeof _resolveActivePromptModal === 'function') _resolveActivePromptModal(null); } catch (_) {}
  $$('.modal-backdrop[data-modal]').forEach(m => m.setAttribute('hidden', ''));
}

function confirmModal(text, { okText='Confirm', danger=false }={}) {
  return new Promise((resolve) => {
    $('confirmText').textContent = text;
    const okBtn = $('confirmOk');
    okBtn.textContent = okText;
    okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    openModal('confirmModal');
    const cleanup = (val) => {
      okBtn.onclick = null;
      closeModal('confirmModal');
      resolve(val);
    };
    okBtn.onclick = () => cleanup(true);
    $$('#confirmModal .modal-dismiss').forEach(b => { b.onclick = () => cleanup(false); });
  });
}

// Track the active prompt-modal resolver so that ANY close path (Esc, backdrop
// click, dismiss button, programmatic closeAllModals) cleanly resolves the
// pending Promise instead of leaving the dialog half-wired.
let _activePromptModalResolve = null;

function _resolveActivePromptModal(val) {
  const fn = _activePromptModalResolve;
  _activePromptModalResolve = null;
  if (typeof fn === 'function') {
    try { fn(val); } catch (_) {}
  }
}

function promptModal(label, defaultValue='') {
  return new Promise((resolve) => {
    // If a previous prompt is still open (e.g. its caller threw), resolve it
    // first so we never have two stacked instances fighting over the DOM.
    if (_activePromptModalResolve) _resolveActivePromptModal(null);

    const modal = $('promptTextModal');
    const inp   = $('promptTextInput');
    const okBtn = $('promptTextOk');
    if (!modal || !inp || !okBtn) { resolve(null); return; }

    $('promptTextLabel').textContent = label;
    inp.value = defaultValue;

    let done = false;
    const cleanup = (val) => {
      if (done) return;
      done = true;
      _activePromptModalResolve = null;
      // Detach handlers so a stale instance can never block a future one.
      okBtn.onclick = null;
      inp.onkeydown = null;
      modal.onclick = null;
      $$('#promptTextModal .modal-dismiss').forEach(b => { b.onclick = null; });
      // Force-hide the modal directly — bypasses any helper that might recurse.
      modal.setAttribute('hidden', '');
      resolve(val);
    };

    _activePromptModalResolve = cleanup;
    openModal('promptTextModal');
    setTimeout(() => { try { inp.focus(); inp.select(); } catch(_){} }, 50);

    okBtn.onclick = () => cleanup(inp.value);
    $$('#promptTextModal .modal-dismiss').forEach(b => { b.onclick = () => cleanup(null); });
    // Clicking the backdrop (outside the dialog) also cancels.
    modal.onclick = (e) => { if (e.target === modal) cleanup(null); };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); cleanup(inp.value); }
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
    };
  });
}

// ============================================================
//  INIT
// ============================================================
async function init() {
  // Each step is wrapped — a single failure can never leave the page broken
  // (and can never leave a modal stuck open).
  const safe = async (label, fn) => {
    try { await fn(); }
    catch (e) {
      console.error(`[init:${label}]`, e);
    }
  };

  // Make sure every modal starts hidden (defensive — in case stale state leaks in).
  closeAllModals();

  await safe('bindGlobalEvents',  () => bindGlobalEvents());
  await safe('bindModalDismiss',  () => bindModalDismiss());
  await safe('bindNav',           () => bindNav());
  await safe('bindShortcuts',     () => bindShortcuts());

  await safe('loadConfig',             () => loadConfig());
  await safe('loadProvidersAndModels', () => loadProvidersAndModels());
  await safe('loadPrompts',            () => loadPrompts());
  await safe('loadChats',              () => loadChats());

  await safe('bindChat',         () => bindChat());
  await safe('bindImage',        () => bindImage());
  await safe('bindAudio',        () => bindAudio());
  await safe('bindAgent',        () => bindAgent());
  await safe('bindWebGPU',       () => bindWebGPU());
  await safe('bindTranslate',    () => bindTranslate());
  await safe('bindFiles',        () => bindFiles());
  await safe('bindTerminal',     () => bindTerminal());
  await safe('bindGallery',      () => bindGallery());
  await safe('bindSettings',     () => bindSettings());
  await safe('bindPromptsView',  () => bindPromptsView());

  await safe('applyTheme', () => applyTheme((state.config && state.config.theme) || 'dark'));
  await safe('newChat',    () => newChat());
  await safe('refreshSidebarWorkspace', () => refreshSidebarWorkspace());

  // Final safety net: make sure NOTHING was left as a stuck modal during init.
  closeAllModals();
}

// ----- Global -----
function bindGlobalEvents() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Force-hide every modal at the DOM level AND resolve any pending
      // prompt-modal Promise. Belt + suspenders so nothing can ever get stuck.
      try { _resolveActivePromptModal(null); } catch (_) {}
      $$('.modal-backdrop[data-modal]').forEach(m => m.setAttribute('hidden', ''));
    }
  }, true); // capture-phase so nothing can stop it.
}

function bindModalDismiss() {
  // Use event delegation on document so dismiss ALWAYS works — even if a
  // modal's inner handler is overwritten by promptModal/confirmModal.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;

    // Click on backdrop itself (not inside the modal content) → close.
    if (target.classList && target.classList.contains('modal-backdrop') && target.hasAttribute('data-modal')) {
      const id = target.id;
      target.setAttribute('hidden', '');
      // If this was the prompt-text modal, resolve its pending Promise so the
      // caller doesn't hang and a stale resolver can't block the next open.
      if (id === 'promptTextModal') {
        try { _resolveActivePromptModal(null); } catch (_) {}
      }
      return;
    }

    // Click on any .modal-dismiss button → close its parent modal.
    const dismiss = target.closest('.modal-dismiss');
    if (dismiss) {
      const bd = dismiss.closest('.modal-backdrop[data-modal]');
      if (bd) {
        const id = bd.id;
        bd.setAttribute('hidden', '');
        if (id === 'promptTextModal') {
          try { _resolveActivePromptModal(null); } catch (_) {}
        }
      }
    }
  }, true);
}

function bindNav() {
  $$('[data-view]').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });
}

function switchView(view) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-item').forEach(b => b.classList.remove('active'));
  const target = $(`view-${view}`);
  if (target) target.classList.add('active');
  $$(`[data-view="${view}"]`).forEach(b => b.classList.add('active'));
  if (view === 'gallery') refreshGallery();
  if (view === 'files')   refreshFileTree();
  if (view === 'webgpu')  ensureWebGPUInit();
  if (view === 'prompts') renderPromptsView();
}

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (!meta) return;
    if (e.key === 'n') { e.preventDefault(); newChat(); }
    if (e.key === 'k') { e.preventDefault(); $('chatInput')?.focus(); }
    if (e.key === ',') { e.preventDefault(); switchView('settings'); }
    if (e.key === '1') { e.preventDefault(); switchView('chat'); }
    if (e.key === '2') { e.preventDefault(); switchView('image'); }
    if (e.key === '3') { e.preventDefault(); switchView('audio'); }
    if (e.key === '4') { e.preventDefault(); switchView('agent'); }
    if (e.key === '5') { e.preventDefault(); switchView('webgpu'); }
    if (e.key === '6') { e.preventDefault(); switchView('translate'); }
  });
}

// ============================================================
//  CONFIG / PROVIDERS / MODELS
// ============================================================
// ── Static fallback provider metadata so the UI can still boot even if /api/config fails.
//    Keep this in sync with PROVIDERS in app.py (only the basics needed to render the UI).
const FALLBACK_PROVIDERS = {
  pollinations:   { name: 'Pollinations',    short: 'pol', color: '#1f8f62', capabilities: ['chat','image','tts'], free: true,      description: 'Free, anonymous.' },
  llm7:           { name: 'LLM7.io',         short: 'l7',  color: '#9333ea', capabilities: ['chat'],                free: true,      description: 'Free OpenAI-compatible gateway.' },
  duckduckgo:     { name: 'DuckDuckGo AI',   short: 'ddg', color: '#de5833', capabilities: ['chat'],                free: true,      description: 'Private, free.' },
  cerebras:       { name: 'Cerebras',        short: 'crb', color: '#ff4a4a', capabilities: ['chat'],                free_tier: true, description: 'Ultra-fast LPU inference.', key_hint: 'csk-…' },
  groq:           { name: 'Groq',            short: 'grq', color: '#f55036', capabilities: ['chat','stt'],          free_tier: true, description: 'LPU speed.', key_hint: 'gsk_…' },
  google:         { name: 'Google Gemini',   short: 'ggl', color: '#4285f4', capabilities: ['chat'],                free_tier: true, description: 'Gemini 2.5.', key_hint: 'AIza…' },
  github_models:  { name: 'GitHub Models',   short: 'gh',  color: '#24292f', capabilities: ['chat'],                free_tier: true, description: 'Free with any GitHub account.', key_hint: 'ghp_…' },
  nvidia_nim:     { name: 'NVIDIA NIM',      short: 'nv',  color: '#76b900', capabilities: ['chat','image'],        free_tier: true, description: 'DeepSeek, Nemotron, Llama 4.', key_hint: 'nvapi-…' },
  siliconflow:    { name: 'SiliconFlow',     short: 'sf',  color: '#0ea5e9', capabilities: ['chat','image'],        free_tier: true, description: 'Chinese open-source models.', key_hint: 'sk-…' },
  cloudflare:     { name: 'Cloudflare AI',   short: 'cf',  color: '#f38020', capabilities: ['chat','image'],        free_tier: true, description: 'Workers AI.', key_hint: 'token' },
  mistral:        { name: 'Mistral',         short: 'ms',  color: '#fa520f', capabilities: ['chat'],                free_tier: true, description: 'Mistral models.', key_hint: 'sk-…' },
  huggingface:    { name: 'Hugging Face',    short: 'hf',  color: '#ffcc4d', capabilities: ['chat'],                free_tier: true, description: 'Inference API.', key_hint: 'hf_…' },
  openai:         { name: 'OpenAI',          short: 'oai', color: '#10a37f', capabilities: ['chat','image','tts','stt'], description: 'GPT models.', key_hint: 'sk-…' },
  anthropic:      { name: 'Anthropic',       short: 'ant', color: '#c96442', capabilities: ['chat'],                description: 'Claude.', key_hint: 'sk-ant-…' },
  xai:            { name: 'xAI',             short: 'xai', color: '#000000', capabilities: ['chat'],                description: 'Grok.', key_hint: 'xai-…' },
  deepseek:       { name: 'DeepSeek',        short: 'ds',  color: '#4d6bfe', capabilities: ['chat'],                description: 'DeepSeek models.', key_hint: 'sk-…' },
  openrouter:     { name: 'OpenRouter',      short: 'or',  color: '#6366f1', capabilities: ['chat'],                description: 'Multi-provider gateway.', key_hint: 'sk-or-…' },
  together:       { name: 'Together AI',     short: 'tog', color: '#0f172a', capabilities: ['chat','image'],        description: 'Open models.', key_hint: 'tok-…' },
  fireworks:      { name: 'Fireworks',       short: 'fw',  color: '#dc2626', capabilities: ['chat'],                description: 'Fast open models.', key_hint: 'fw-…' },
  perplexity:     { name: 'Perplexity',      short: 'pplx',color: '#1e3a5f', capabilities: ['chat'],                description: 'Sonar models.', key_hint: 'pplx-…' },
  cohere:         { name: 'Cohere',          short: 'co',  color: '#39594d', capabilities: ['chat'],                description: 'Command models.', key_hint: 'co-…' },
  anyscale:       { name: 'Anyscale',        short: 'as',  color: '#0070f3', capabilities: ['chat'],                description: 'Llama / Mixtral.', key_hint: 'esecret-…' },
  replicate:      { name: 'Replicate',       short: 'rep', color: '#000000', capabilities: ['image'],               description: 'Image models.', key_hint: 'r8_…' },
  stability:      { name: 'Stability AI',    short: 'sai', color: '#ec4899', capabilities: ['image'],               description: 'Stable Diffusion.', key_hint: 'sk-…' },
  elevenlabs:     { name: 'ElevenLabs',      short: 'el',  color: '#000000', capabilities: ['tts','stt'],           description: 'Voice synthesis.', key_hint: 'sk_…' },
  deepl:          { name: 'DeepL',           short: 'dl',  color: '#0f2b46', capabilities: [],                       description: 'Translation.', key_hint: 'key' },
  webgpu:         { name: 'Local WebGPU',    short: 'wg',  color: '#7c3aed', capabilities: ['chat'],                local: true,     description: 'Runs in your browser.' },
};

function _toMetaWithActive(providers, cfg) {
  const out = {};
  const apiKeys = (cfg && cfg.api_keys) || {};
  const providerCfg = (cfg && cfg.provider_config) || {};
  for (const [pid, meta] of Object.entries(providers || {})) {
    let active = !!meta.free;
    if (!active) {
      const k = (apiKeys[pid] || '').trim();
      if (pid === 'cloudflare') active = !!(k && providerCfg.cloudflare?.account_id);
      else                      active = !!k;
    }
    out[pid] = Object.assign({}, meta, { active });
  }
  return out;
}

async function loadConfig() {
  // Load user prefs from localStorage
  state.config = LS.getConfig();
  state.theme = state.config.theme || 'dark';

  // Always seed defaults FIRST so a failed /api/config can never leave the UI broken.
  state.providers       = state.providers       && Object.keys(state.providers).length       ? state.providers       : _toMetaWithActive(FALLBACK_PROVIDERS, state.config);
  state.systemPrompts   = state.systemPrompts   || { general: 'You are a helpful assistant.', image_prompt: 'You are an expert image-prompt writer.' };
  state.visionModels    = state.visionModels    || {};
  state.toolModels      = state.toolModels      || {};
  state.uncensoredModels= state.uncensoredModels|| {};

  // Load static metadata from server (providers, system prompts, model categories)
  let r;
  try { r = await API.config(); }
  catch (e) { r = { ok: false, error: { type: 'network', message: e.message || String(e) } }; }

  if (r && r.ok && r.data) {
    state.providers = r.data.providers && Object.keys(r.data.providers).length
      ? r.data.providers
      : _toMetaWithActive(FALLBACK_PROVIDERS, state.config);
    state.systemPrompts = r.data.system_prompts || state.systemPrompts;
    state.visionModels = r.data.vision_models || {};
    state.toolModels = r.data.tool_models || {};
    state.uncensoredModels = r.data.uncensored_models || {};
    if ($('aboutPlatform')) $('aboutPlatform').textContent = r.data.platform || 'vercel';
  } else {
    // Server unreachable — keep working with built-in fallback metadata.
    console.warn('[loadConfig] /api/config failed, using fallback providers:', r && r.error);
    toast(`Server metadata unavailable — using offline defaults. ${describeError(r && r.error)}`, 'info');
  }

  // Populate settings UI from localStorage config
  if ($('streamEnabledSetting')) $('streamEnabledSetting').checked = !!state.config.stream;
  if ($('webSearchEnabledSetting')) $('webSearchEnabledSetting').checked = !!state.config.web_search_enabled;
  if ($('webSearchResultsSetting')) $('webSearchResultsSetting').value = state.config.web_search_results || 5;
  if ($('defaultTempSetting')) $('defaultTempSetting').value = state.config.default_temperature || 0.7;
  if ($('defaultTempVal')) $('defaultTempVal').textContent = (+state.config.default_temperature || 0.7).toFixed(1);
  if ($('chatTemperature')) $('chatTemperature').value = state.config.default_temperature || 0.7;
  if ($('chatTemperatureVal')) $('chatTemperatureVal').textContent = (+state.config.default_temperature || 0.7).toFixed(1);
  if ($('workspaceInput')) $('workspaceInput').value = '';  // workspace N/A in serverless
  state.webSearchOn = !!state.config.web_search_enabled;
  try { applyToolbarBadges(); }    catch (e) { console.warn('[loadConfig] applyToolbarBadges:', e); }
  try { renderKeysGrid(); }        catch (e) { console.warn('[loadConfig] renderKeysGrid:', e); }
  try { renderWorkspaceLists(); }  catch (e) { console.warn('[loadConfig] renderWorkspaceLists:', e); }
}

async function loadProvidersAndModels() {
  const all = Object.keys(state.providers || {});
  // Only fetch models for providers that have a UI dropdown — fetch lazily for the chosen provider.
  await fetchModelsForProvider(state.config.default_chat_provider || 'pollinations');
  populateProviderSelectors();
}

async function fetchModelsForProvider(p) {
  if (!p) return;
  if (state.modelFetches[p]) return state.modelFetches[p];
  const promise = (async () => {
    const r = await API.providerModels(p);
    if (!r.ok) {
      if (!state.warnedProviders.has(p)) {
        state.warnedProviders.add(p);
        // silent for free providers — anyway use the static fallback
      }
      return;
    }
    state.models[p] = r.data.models || {};
  })();
  state.modelFetches[p] = promise;
  return promise;
}

function populateProviderSelectors() {
  // Each view filters providers by the capability they need.
  fillProviderSelect('chatProvider', 'chat', state.config.default_chat_provider || 'pollinations');
  fillProviderSelect('imageProvider', 'image', state.config.default_image_provider || 'pollinations');
  fillProviderSelect('agentProvider', 'chat', state.config.default_chat_provider || 'pollinations');
  fillProviderSelect('ttsProvider', 'tts', 'pollinations');
  fillProviderSelect('sttProvider', 'stt', 'groq');

  $('chatProvider').addEventListener('change', () => onProviderChange('chat'));
  $('imageProvider').addEventListener('change', () => onProviderChange('image'));
  $('agentProvider').addEventListener('change', () => onProviderChange('agent'));
  $('ttsProvider').addEventListener('change', () => onProviderChange('tts'));
  $('sttProvider').addEventListener('change', () => onProviderChange('stt'));

  $('chatModel').addEventListener('change', updateModelIcons);
  $('agentModel').addEventListener('change', updateAgentToolIcon);

  onProviderChange('chat');
  onProviderChange('image');
  onProviderChange('agent');
  onProviderChange('tts');
  onProviderChange('stt');
}

function fillProviderSelect(selectId, capability, def) {
  const sel = $(selectId);
  if (!sel) return;
  sel.innerHTML = '';
  const ids = Object.keys(state.providers || {}).filter((pid) => {
    const meta = state.providers[pid];
    if (!meta) return false;
    // Allow webgpu only for agent (chat uses separate view)
    if (pid === 'webgpu' && capability !== 'chat') return false;
    if (pid === 'webgpu' && selectId !== 'agentProvider') return false;
    return (meta.capabilities || []).includes(capability);
  });
  // Sort: free first, then free-tier, then paid
  ids.sort((a, b) => {
    const A = state.providers[a], B = state.providers[b];
    const sa = (A.free ? 0 : (A.free_tier ? 1 : 2));
    const sb = (B.free ? 0 : (B.free_tier ? 1 : 2));
    if (sa !== sb) return sa - sb;
    return (A.name || a).localeCompare(B.name || b);
  });
  for (const pid of ids) {
    const meta = state.providers[pid];
    const opt = document.createElement('option');
    opt.value = pid;
    let badge = meta.free ? ' · free' : meta.free_tier ? ' · free tier' : '';
    const hasKey = !!(state.config?.api_keys || {})[pid];
    let ok = (meta.free || meta.free_tier || hasKey) ? '' : ' · key needed';
    opt.textContent = `${meta.name || pid}${badge}${ok}`;
    if (!meta.free && !meta.free_tier && !hasKey) opt.style.color = 'var(--ink-faint)';
    sel.appendChild(opt);
  }
  if (def && ids.includes(def)) sel.value = def;
}

async function onProviderChange(view) {
  const provMap = { chat:'chatProvider', image:'imageProvider', agent:'agentProvider', tts:'ttsProvider', stt:'sttProvider' };
  const modelMap = { chat:'chatModel', image:'imageModel', agent:'agentModel', tts:'ttsModel', stt:'sttModel' };
  const capMap = { chat:'chat', image:'image', agent:'chat', tts:'tts', stt:'stt' };
  const provSel = $(provMap[view]); const modelSel = $(modelMap[view]);
  if (!provSel || !modelSel) return;
  const provider = provSel.value;
  await fetchModelsForProvider(provider);
  modelSel.innerHTML = '';
  const cat = (state.models[provider] || {})[capMap[view]] || [];
  for (const m of cat) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelSel.appendChild(opt);
  }
  if (cat.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(no models — add API key)';
    modelSel.appendChild(opt);
  }
  // Default model
  if (view === 'chat' && state.config.default_chat_provider === provider && state.config.default_chat_model) {
    if (cat.includes(state.config.default_chat_model)) modelSel.value = state.config.default_chat_model;
  }
  if (view === 'image' && state.config.default_image_provider === provider && state.config.default_image_model) {
    if (cat.includes(state.config.default_image_model)) modelSel.value = state.config.default_image_model;
  }
  // Voices for TTS
  if (view === 'tts') {
    const vsel = $('ttsVoice');
    vsel.innerHTML = '';
    let voices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    if (provider === 'openai') {
      const r = await API.openaiVoices(); if (r.ok) voices = r.data.voices;
    } else if (provider === 'pollinations') {
      const r = await API.pollinationsVoices(); if (r.ok) voices = r.data.voices;
    } else if (provider === 'elevenlabs') {
      const r = await API.elevenVoices();
      if (r.ok) {
        vsel.innerHTML = '';
        for (const v of (r.data.voices || [])) {
          const o = document.createElement('option');
          o.value = v.id; o.textContent = v.name;
          vsel.appendChild(o);
        }
        return;
      }
    }
    for (const v of voices) {
      const o = document.createElement('option'); o.value = v; o.textContent = v;
      vsel.appendChild(o);
    }
  }
  if (view === 'chat') updateModelIcons();
  if (view === 'agent') updateAgentToolIcon();
}

function updateModelIcons() {
  const p = $('chatProvider').value;
  const m = $('chatModel').value;
  const v = state.visionModels[p] || [];
  const u = state.uncensoredModels[p] || [];
  const isVision = v.includes('*') || v.includes(m);
  const isUnc = u.includes('*') || u.includes(m);
  const vi = $('chatVisionIcon'); const ui = $('chatUncensoredIcon');
  if (vi) (isVision ? vi.removeAttribute('hidden') : vi.setAttribute('hidden',''));
  if (ui) (isUnc ? ui.removeAttribute('hidden') : ui.setAttribute('hidden',''));
}

function updateAgentToolIcon() {
  const p = $('agentProvider').value;
  const m = $('agentModel').value;
  const t = state.toolModels[p] || [];
  const can = t.includes('*') || t.includes(m);
  const el = $('agentToolIcon');
  if (el) (can ? el.removeAttribute('hidden') : el.setAttribute('hidden',''));
}

// ============================================================
//  CHAT
// ============================================================
function bindChat() {
  $('chatInput').addEventListener('input', autoGrow);
  $('chatInput').addEventListener('input', () => {
    $('chatTokenCount').textContent = `~${estimateTokens($('chatInput').value)} tok`;
  });
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  $('chatSendBtn').addEventListener('click', sendChat);
  $('newChatBtn').addEventListener('click', newChat);
  $('chatExportBtn').addEventListener('click', exportChat);

  $('chatTemperature').addEventListener('input', () => {
    $('chatTemperatureVal').textContent = (+$('chatTemperature').value).toFixed(1);
  });

  $('chatAttachment').addEventListener('change', (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.attachment = reader.result;
      $('attachmentPreview').innerHTML = `<img src="${reader.result}" alt=""/><button class="toolbar-btn" id="removeAttBtn"><i class="fa-solid fa-xmark"></i></button>`;
      $('removeAttBtn').addEventListener('click', () => {
        state.attachment = null; $('attachmentPreview').innerHTML = ''; $('chatAttachment').value = '';
      });
    };
    reader.readAsDataURL(f);
  });

  $('webSearchToggle').addEventListener('click', () => {
    state.webSearchOn = !state.webSearchOn;
    applyToolbarBadges();
  });
  $('imageModeToggle').addEventListener('click', () => {
    state.imageModeOn = !state.imageModeOn;
    applyToolbarBadges();
  });
  $('uncensoredModeToggle').addEventListener('click', () => {
    state.uncensoredOn = !state.uncensoredOn;
    if (state.uncensoredOn) pickUncensoredModel();
    applyToolbarBadges();
  });

  $('sysPromptBtn').addEventListener('click', openSystemPromptModal);

  // chip clicks
  $$('.quick-chip').forEach((c) => {
    c.addEventListener('click', () => {
      $('chatInput').value = c.dataset.prompt || '';
      autoGrow();
      $('chatInput').focus();
    });
  });

  $('chatSearchInput').addEventListener('input', debounce(renderChatHistory, 150));

  // Preset picker
  const presetSel = $('sysPresetSelect');
  for (const k of Object.keys(state.systemPrompts || {})) {
    const o = document.createElement('option'); o.value = k; o.textContent = k;
    presetSel.appendChild(o);
  }

  $('sysModalSave').addEventListener('click', () => {
    if (!state.currentChat) return;
    state.currentChat.system = $('sysModalText').value;
    saveCurrentChat();
    closeModal('sysModal');
    toast('System prompt updated', 'success');
  });
  $('sysModalSaveToLibrary').addEventListener('click', async () => {
    const name = await promptModal('Name for this prompt:');
    if (!name) return;
    const r = await API.savePrompt({ name, body: $('sysModalText').value });
    if (r.ok) { toast('Saved to library', 'success'); loadPrompts(); }
  });
  $('sysModalPromptPicker').addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) return;
    const p = state.userPrompts[id];
    if (p) $('sysModalText').value = p.body;
    e.target.value = '';
  });
}

function applyToolbarBadges() {
  $('webSearchBadge').toggleAttribute('hidden', !state.webSearchOn);
  $('imageModeBadge').toggleAttribute('hidden', !state.imageModeOn);
  $('uncensoredBadge').toggleAttribute('hidden', !state.uncensoredOn);
  $('webSearchToggle').classList.toggle('active', state.webSearchOn);
  $('imageModeToggle').classList.toggle('active', state.imageModeOn);
  $('uncensoredModeToggle').classList.toggle('active', state.uncensoredOn);
}

async function pickUncensoredModel() {
  const candidates = [
    ['pollinations', 'evil'],
    ['openrouter',   'cognitivecomputations/dolphin-mistral-24b-venice-edition:free'],
    ['openrouter',   'venice/uncensored:free'],
    ['openrouter',   'nousresearch/hermes-3-llama-3.1-70b:free'],
  ];
  for (const [p, m] of candidates) {
    if (!state.providers[p]) continue;
    if (!state.providers[p].active && !state.providers[p].free) continue;
    $('chatProvider').value = p;
    await onProviderChange('chat');
    if ([...$('chatModel').options].some(o => o.value === m)) {
      $('chatModel').value = m;
      updateModelIcons();
      return true;
    }
  }
  return false;
}

function autoGrow() {
  const ta = $('chatInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}

function newChat() {
  state.currentChatId = `chat_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  state.currentChat = {
    id: state.currentChatId,
    title: 'Untitled',
    provider: $('chatProvider').value,
    model: $('chatModel').value,
    messages: [],
    system: '',
    system_preset: $('sysPresetSelect').value || '',
    temperature: parseFloat($('chatTemperature').value) || 0.7,
  };
  renderMessages();
  renderChatHistory();
}

function exportChat() {
  if (!state.currentChat || !state.currentChat.messages.length) return toast('Nothing to export', 'info');
  const blob = new Blob([JSON.stringify(state.currentChat, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.currentChat.title || 'chat').replace(/\W+/g,'_')}.json`;
  a.click();
}

async function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text) return;
  if (state.streaming) { stopStream(); return; }

  // Auto-detect image generation requests and auto-prefix with /image
  const imageReq = /\b(make|generate|create|draw|paint|render|compose|design)\s+.*(image|picture|photo|graphic|artwork|scene)\b/i;
  if (imageReq.test(text) && !text.startsWith('/')) {
    text = '/image ' + text;
  }

  // /image command — never blocks the chat
  if (text.startsWith('/image ') || (state.imageModeOn && text)) {
    const prompt = text.replace(/^\/image\s+/i, '');
    return sendChatImage(prompt);
  }

  const provider = $('chatProvider').value;
  const model    = $('chatModel').value;
  if (!model) return toast('No model selected', 'error');
  // Check if provider needs a key and whether the user has stored one
  const provMeta = state.providers[provider] || {};
  if (!provMeta.free && !provMeta.free_tier) {
    const savedKey = (state.config?.api_keys || {})[provider] || '';
    if (!savedKey) {
      return toast(`Add an API key for ${provMeta.name || provider} in Settings`, 'error');
    }
  }

  // Add user message
  const userMsg = { role: 'user', content: text };
  if (state.attachment) userMsg.image = state.attachment;
  state.currentChat.messages.push(userMsg);
  state.currentChat.provider = provider;
  state.currentChat.model = model;
  state.currentChat.system_preset = $('sysPresetSelect').value || '';
  state.currentChat.temperature = parseFloat($('chatTemperature').value) || 0.7;

  $('chatInput').value = '';
  $('chatTokenCount').textContent = '~0 tok';
  state.attachment = null; $('attachmentPreview').innerHTML = ''; $('chatAttachment').value = '';
  autoGrow();
  renderMessages();

  // Title from first message
  if (!state.currentChat.title || state.currentChat.title === 'Untitled') {
    state.currentChat.title = text.slice(0, 64);
  }

  // Build the streaming request
  state.streaming = true;
  $('chatSendBtn').innerHTML = '<i class="fa-solid fa-stop"></i>';
  const ctrl = new AbortController();
  state.streamAbort = ctrl;

  // Append empty assistant placeholder
  const asstMsg = { role: 'assistant', content: '' };
  state.currentChat.messages.push(asstMsg);
  renderMessages();
  const last = $('messages').lastElementChild;
  const contentEl = last?.querySelector('.message-content');

  try {
    const body = {
      provider, model,
      messages: state.currentChat.messages.slice(0, -1),  // exclude the placeholder
      temperature: state.currentChat.temperature,
      stream: !!state.config.stream,
      web_search: state.webSearchOn,
      system: state.currentChat.system || undefined,
      system_preset: state.currentChat.system_preset || undefined,
      config: _apiConfig(),
    };
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok && !r.body) {
      const ed = await r.json().catch(() => null);
      throw ed?.error || { type: 'http', status: r.status, message: `HTTP ${r.status}` };
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const chunk = line.slice(6).trim();
        if (chunk === '[DONE]') break;
        try {
          const j = JSON.parse(chunk);
          if (j.error) {
            asstMsg.error = j.error;
            asstMsg.content = describeError(j.error);
            renderMessages(); break;
          }
          if (j.delta) {
            asstMsg.content += j.delta;
            if (contentEl) contentEl.innerHTML = safeMarkdown(asstMsg.content);
            if (state.chatAutoScroll) $('messages').scrollTop = $('messages').scrollHeight;
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      asstMsg.error = e;
      asstMsg.content = describeError(e);
      renderMessages();
    }
  } finally {
    state.streaming = false;
    state.streamAbort = null;
    $('chatSendBtn').innerHTML = '<i class="fa-solid fa-arrow-up"></i>';
    saveCurrentChat();
    renderMessages();
    renderChatHistory();
    // Highlight code blocks
    if (window.hljs) {
      $$('.message-content pre code').forEach(b => { try { hljs.highlightElement(b); } catch {} });
    }
  }
}

function stopStream() {
  if (state.streamAbort) state.streamAbort.abort();
}

function parseImageParams(text) {
  // Extract count: "one", "two", "three", "four", "five" or "1"-"5"
  let n = 1;
  const countMatch = text.match(/\b(one|two|three|four|five|1|2|3|4|5)\s+(images?|pictures?|imgs?)/i);
  if (countMatch) {
    const num = { one: 1, two: 2, three: 3, four: 4, five: 5 }[countMatch[1].toLowerCase()] || parseInt(countMatch[1]);
    n = Math.min(Math.max(num, 1), 5);
  }
  
  // Extract aspect ratio: 16:9, 4:3, 1:1, 9:16, 3:2, 21:9, etc.
  let size = null;
  const ratioMatch = text.match(/(\d+):(\d+)\s*(aspect|ratio)?/i);
  if (ratioMatch) {
    const w = parseInt(ratioMatch[1]);
    const h = parseInt(ratioMatch[2]);
    if (w > 0 && h > 0) {
      const aspect = w / h;
      // Map to standard sizes (use 1024 as base)
      if (Math.abs(aspect - 1) < 0.1) size = '1024x1024'; // square
      else if (Math.abs(aspect - 16/9) < 0.1) size = '1456x819'; // 16:9
      else if (Math.abs(aspect - 4/3) < 0.1) size = '1024x768'; // 4:3
      else if (Math.abs(aspect - 3/2) < 0.1) size = '1024x683'; // 3:2
      else if (Math.abs(aspect - 21/9) < 0.1) size = '1456x626'; // 21:9 cinema
      else if (Math.abs(aspect - 9/16) < 0.1) size = '576x1024'; // 9:16 portrait
      else if (Math.abs(aspect - 3/4) < 0.1) size = '768x1024'; // 3:4 portrait
      else if (Math.abs(aspect - 2/3) < 0.1) size = '683x1024'; // 2:3 portrait
    }
  }
  
  // Extract model keywords
  let model = null;
  const modelMatch = text.match(/\b(flux|sdxl|playground|turbo|schnell|ideogram|recraft|stable)\b/i);
  if (modelMatch) {
    model = modelMatch[1].toLowerCase();
  }
  
  // Remove extracted params to get clean prompt
  let cleanPrompt = text
    .replace(/\b(one|two|three|four|five|1|2|3|4|5)\s+(images?|pictures?|imgs?)\b/i, '')
    .replace(/(\d+):(\d+)\s*(aspect|ratio)?\b/i, '')
    .replace(/\b(flux|sdxl|playground|turbo|schnell|ideogram|recraft|stable)\b/i, '')
    .trim();
  
  return { n, size, model, prompt: cleanPrompt };
}

async function sendChatImage(prompt) {
  if (!prompt) return;
  
  const params = parseImageParams(prompt);
  
  state.currentChat.messages.push({ role: 'user', content: `/image ${prompt}` });
  state.currentChat.messages.push({ role: 'assistant', content: '*Generating image…*' });
  $('chatInput').value = '';
  autoGrow();
  renderMessages();

  try {
    const body = {
      prompt: params.prompt, n: params.n,
      provider: $('imageProvider').value,
      model: $('imageModel').value,
      config: _apiConfig(),
    };
    if (params.size) body.size = params.size;
    if (params.model) body.model = params.model;
    
    const r = await fetchJson('/api/chat-image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const last = state.currentChat.messages[state.currentChat.messages.length - 1];
    if (!r.ok) {
      last.error = r.error;
      last.content = `**Image gen failed:** ${describeError(r.error)}`;
    } else {
      const urls = r.data.images || [];
      const usedPrompt = r.data.prompt || params.prompt;
      last.content = [
        `Here are ${urls.length} image${urls.length === 1 ? '' : 's'}:`,
        ...urls.map((u, idx) => `**Image ${idx + 1} prompt:** ${usedPrompt}\n\n![image](${u})`),
        `*via ${r.data.provider}/${r.data.model}*`
      ].join('\n\n');
      // Save to localStorage gallery
      urls.forEach((url, i) => {
        LS.addGalleryItem({ name: `chat_img_${Date.now()}_${i}.png`, url, kind: 'image', prompt: usedPrompt, ts: Date.now() });
      });
    }
    renderMessages();
    saveCurrentChat();
  } catch (e) {
    toast(`Image error: ${e.message || e}`, 'error');
  }
}

function renderMessages() {
  const root = $('messages');
  if (!state.currentChat || !state.currentChat.messages.length) {
    root.innerHTML = `<div class="empty">
      <h2 class="empty-title">Start a conversation</h2>
      <p class="empty-text">
        Free, no signup: <kbd>Pollinations</kbd>, <kbd>LLM7</kbd>, <kbd>DuckDuckGo AI</kbd>.<br/>
        Add API keys in <strong>Settings</strong> for OpenAI, Anthropic, Groq, Cerebras, xAI, OpenRouter, and 12+ more.<br/>
        Type <kbd>/image a red dragon over tokyo</kbd> to make pictures right in chat.
      </p>
      <div class="empty-chips">
        <button class="quick-chip" data-prompt="Explain how transformers attention works in two paragraphs.">How attention works</button>
        <button class="quick-chip" data-prompt="Write a haskell quicksort and explain it line by line.">Haskell quicksort</button>
        <button class="quick-chip" data-prompt="/image a cyberpunk cat detective in neon Tokyo, cinematic">/image cyberpunk cat</button>
      </div>
    </div>`;
    root.querySelectorAll('.quick-chip').forEach(c => c.addEventListener('click', () => {
      $('chatInput').value = c.dataset.prompt; autoGrow(); $('chatInput').focus();
    }));
    return;
  }
  let html = '';
  for (let i = 0; i < state.currentChat.messages.length; i++) {
    const m = state.currentChat.messages[i];
    const role = m.role === 'user' ? 'user' : 'assistant';
    const errCls = m.error ? ' error' : '';
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    html += `<div class="message ${role}${errCls}">
      <div class="message-role"><span class="role-dot"></span>${role === 'user' ? 'You' : 'Assistant'}</div>
      <div class="message-content">${role === 'user' ? escapeHtml(text).replace(/\n/g,'<br>') : safeMarkdown(text)}</div>
      <div class="message-actions">
        <button class="message-action-btn" data-act="copy" data-i="${i}"><i class="fa-regular fa-copy"></i> Copy</button>
        ${role === 'user' ? `<button class="message-action-btn" data-act="edit" data-i="${i}"><i class="fa-regular fa-pen-to-square"></i> Edit</button>` : ''}
      </div>
    </div>`;
  }
  root.innerHTML = html;
  root.querySelectorAll('.message-action-btn').forEach(b => {
    b.addEventListener('click', () => {
      const i = +b.dataset.i;
      if (b.dataset.act === 'copy') {
        navigator.clipboard.writeText(state.currentChat.messages[i].content);
        toast('Copied', 'success', 1200);
      }
      if (b.dataset.act === 'edit') {
        $('chatInput').value = state.currentChat.messages[i].content;
        // remove this and following messages
        state.currentChat.messages = state.currentChat.messages.slice(0, i);
        renderMessages();
        autoGrow();
        $('chatInput').focus();
      }
    });
  });
  root.scrollTop = root.scrollHeight;
}

async function loadChats() {
  const r = await API.chats();
  state.chats = r.ok ? (r.data.chats || []) : [];
  renderChatHistory();
}

function renderChatHistory() {
  const root = $('chatHistory');
  const filter = ($('chatSearchInput').value || '').toLowerCase();
  const list = state.chats.filter(c => !filter || (c.title || '').toLowerCase().includes(filter));
  if (!list.length) {
    root.innerHTML = '<div class="chat-history-empty">No saved chats yet.</div>';
    return;
  }
  root.innerHTML = list.map(c => `
    <div class="chat-history-item ${c.id === state.currentChatId ? 'active' : ''}" data-id="${c.id}">
      <div class="chat-history-item-title">${escapeHtml(c.title || 'Untitled')}</div>
      <div class="chat-history-item-meta"><span>${escapeHtml(c.provider || '')}</span><span>${c.message_count} msgs</span></div>
      <button class="chat-history-item-delete" data-del="${c.id}"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join('');
  root.querySelectorAll('.chat-history-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.chat-history-item-delete')) return;
      openChat(el.dataset.id);
    });
  });
  root.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await confirmModal('Delete this chat?', { okText: 'Delete', danger: true })) return;
      await API.deleteChat(b.dataset.del);
      if (state.currentChatId === b.dataset.del) newChat();
      loadChats();
    });
  });
}

async function openChat(id) {
  const r = await API.getChat(id);
  if (!r.ok) return toast(describeError(r.error), 'error');
  state.currentChatId = id;
  state.currentChat = r.data.chat;
  if (state.currentChat.provider) $('chatProvider').value = state.currentChat.provider;
  await onProviderChange('chat');
  if (state.currentChat.model) $('chatModel').value = state.currentChat.model;
  if (state.currentChat.temperature) {
    $('chatTemperature').value = state.currentChat.temperature;
    $('chatTemperatureVal').textContent = (+state.currentChat.temperature).toFixed(1);
  }
  if (state.currentChat.system_preset) $('sysPresetSelect').value = state.currentChat.system_preset;
  renderMessages();
  renderChatHistory();
}

async function saveCurrentChat() {
  if (!state.currentChat || !state.currentChat.messages.length) return;
  await API.saveChat(state.currentChatId, state.currentChat);
  loadChats();
}

function openSystemPromptModal() {
  $('sysModalText').value = state.currentChat?.system || '';
  // populate library picker
  const sel = $('sysModalPromptPicker');
  sel.innerHTML = '<option value="">Insert from library…</option>';
  for (const id of Object.keys(state.userPrompts || {})) {
    const p = state.userPrompts[id];
    const o = document.createElement('option');
    o.value = id; o.textContent = p.name;
    sel.appendChild(o);
  }
  openModal('sysModal');
}

// ============================================================
//  IMAGE
// ============================================================

const SURPRISE_PROMPTS = [
  "A majestic dragon perched on a cliff at sunset, photorealistic, 8k, dramatic lighting",
  "A cozy cyberpunk cafe interior, neon signs, rain outside, cinematic atmosphere, detailed",
  "An astronaut floating in a nebula, vibrant colors, surreal, digital art, highly detailed",
  "A mystical forest with glowing mushrooms and fireflies, fantasy art, ethereal lighting",
  "A retro-futuristic cityscape, flying cars, art deco meets sci-fi, sunset, detailed illustration",
  "A serene Japanese garden in autumn, red maple leaves, koi pond, watercolor style, peaceful",
  "A steampunk mechanical owl with brass gears and glowing amber eyes, intricate details",
  "An underwater coral reef city, bioluminescent, fantasy architecture, digital painting",
  "A lone wanderer in a vast desert with ancient ruins, golden hour, epic scale, cinematic",
  "A magical library with floating books and spiral staircases, warm candlelight, fantasy",
];

let imageHistory = JSON.parse(localStorage.getItem('goatai_image_history') || '[]');
let currentImageUrls = [];
let lightboxIndex = 0;

function bindImage() {
  // Generate button
  $('imageGenBtn').addEventListener('click', generateImages);
  $('imageEnhanceBtn').addEventListener('click', enhanceImagePrompt);

  // Surprise me
  $('imageSurpriseBtn').addEventListener('click', () => {
    const p = SURPRISE_PROMPTS[Math.floor(Math.random() * SURPRISE_PROMPTS.length)];
    $('imagePrompt').value = p;
    toast('Surprise prompt loaded!', 'success');
  });

  // Prompt history
  $('imageHistoryBtn').addEventListener('click', () => {
    const dd = $('promptHistoryDropdown');
    dd.hidden = !dd.hidden;
    if (!dd.hidden) renderPromptHistory();
  });
  $('clearHistoryBtn').addEventListener('click', () => {
    imageHistory = [];
    localStorage.removeItem('goatai_image_history');
    renderPromptHistory();
  });

  // Style chips
  const chips = $$('#imageStyleChips .style-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      $('imageStyle').value = chip.dataset.value;
    });
  });

  // Aspect ratio buttons
  const ratioBtns = $$('#imageRatioGrid .ratio-btn');
  ratioBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      ratioBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('imageSize').value = btn.dataset.size;
    });
  });

  // Accordion
  $('advancedToggle').addEventListener('click', () => {
    $('advancedToggle').classList.toggle('open');
    $('advancedBody').classList.toggle('open');
  });

  // Range slider
  $('imageStepsRange').addEventListener('input', (e) => {
    $('imageStepsValue').textContent = e.target.value;
    $('imageSteps').value = e.target.value;
  });

  // Reference image dropzone
  const dropzone = $('imageDropzone');
  const refInput = $('imageReference');
  dropzone.addEventListener('click', () => refInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length && files[0].type.startsWith('image/')) handleReferenceImage(files[0]);
  });
  refInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleReferenceImage(e.target.files[0]);
  });
  $('removeReferenceBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    clearReferenceImage();
  });

  // Example prompts
  $$('.example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $('imagePrompt').value = chip.dataset.prompt;
      generateImages();
    });
  });

  // Lightbox
  $('lightboxClose').addEventListener('click', closeLightbox);
  $('lightboxPrev').addEventListener('click', () => navigateLightbox(-1));
  $('lightboxNext').addEventListener('click', () => navigateLightbox(1));
  document.addEventListener('keydown', (e) => {
    if ($('imageLightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') navigateLightbox(-1);
    if (e.key === 'ArrowRight') navigateLightbox(1);
  });
}

function handleReferenceImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    $('dropzonePreviewImg').src = reader.result;
    $('dropzoneContent').hidden = true;
    $('dropzonePreview').hidden = false;
  };
  reader.readAsDataURL(file);
}

function clearReferenceImage() {
  $('dropzonePreviewImg').src = '';
  $('dropzoneContent').hidden = false;
  $('dropzonePreview').hidden = true;
  $('imageReference').value = '';
}

function addToHistory(prompt) {
  if (!prompt) return;
  imageHistory = imageHistory.filter(p => p !== prompt);
  imageHistory.unshift(prompt);
  if (imageHistory.length > 20) imageHistory = imageHistory.slice(0, 20);
  localStorage.setItem('goatai_image_history', JSON.stringify(imageHistory));
}

function renderPromptHistory() {
  const list = $('promptHistoryList');
  if (!imageHistory.length) {
    list.innerHTML = '<div class="history-item" style="color:var(--ink-whisper);cursor:default;"><i class="fa-regular fa-clock"></i> No history yet</div>';
    return;
  }
  list.innerHTML = imageHistory.map(p => `
    <div class="history-item" data-prompt="${escapeHtml(p)}">
      <i class="fa-solid fa-wand-magic-sparkles"></i>
      <span>${escapeHtml(p.slice(0, 60))}${p.length > 60 ? '…' : ''}</span>
    </div>
  `).join('');
  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      $('imagePrompt').value = item.dataset.prompt;
      $('promptHistoryDropdown').hidden = true;
    });
  });
}

async function enhanceImagePrompt() {
  const p = $('imagePrompt').value.trim();
  if (!p) return;
  $('imageEnhanceBtn').disabled = true;
  try {
    const r = await fetchJson('/api/enhance-prompt', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ prompt: p, config: _apiConfig() }),
    });
    if (r.ok) { $('imagePrompt').value = r.data.prompt; toast('Prompt enhanced', 'success'); }
    else toast(describeError(r.error), 'error');
  } finally {
    $('imageEnhanceBtn').disabled = false;
  }
}

async function generateImages() {
  const provider = $('imageProvider').value;
  const model = $('imageModel').value;
  let prompt = $('imagePrompt').value.trim();
  const style = $('imageStyle').value;
  if (style) prompt = `${prompt}, ${style}`;
  if (!prompt) return toast('Prompt required', 'error');

  addToHistory($('imagePrompt').value.trim());

  const body = {
    provider, model, prompt,
    size: $('imageSize').value,
    n: parseInt($('imageCount').value) || 1,
    negative: $('imageNegative').value,
    seed: $('imageSeed').value ? parseInt($('imageSeed').value) : null,
    cfg: $('imageCfg').value ? parseFloat($('imageCfg').value) : null,
    steps: $('imageSteps').value ? parseInt($('imageSteps').value) : null,
  };

  // Include reference image if present
  const refImg = $('dropzonePreviewImg').src;
  if (refImg && refImg.startsWith('data:image')) {
    body.reference_image = refImg;
  }

  const btn = $('imageGenBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…';
  $('imageHint').textContent = 'Generating…';
  try {
    body.config = _apiConfig();
    const r = await fetchJson('/api/image', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      $('imageHint').textContent = describeError(r.error);
      toast(describeError(r.error), 'error');
      return;
    }
    $('imageHint').textContent = `${r.data.images.length} image(s) via ${r.data.provider}/${r.data.model}`;
    renderImageResults(r.data.images, prompt);
    // Save to localStorage gallery
    (r.data.images || []).forEach((url, i) => {
      LS.addGalleryItem({
        name: `img_${Date.now()}_${i}.png`,
        url,
        kind: 'image',
        prompt: $('imagePrompt').value.trim(),
        ts: Date.now(),
      });
    });
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-sparkles"></i> Generate';
  }
}

function renderImageResults(urls, prompt) {
  const root = $('imageResults');
  if (!urls?.length) return;
  currentImageUrls = urls;
  root.innerHTML = urls.map((u, i) => `
    <div class="result-image" data-index="${i}">
      <div class="result-overlay">
        <button class="icon-btn" title="View" onclick="openLightbox(${i})"><i class="fa-solid fa-expand"></i></button>
        <a class="icon-btn" title="Download" href="${u}" download><i class="fa-solid fa-download"></i></a>
      </div>
      <img src="${u}" alt="" onclick="openLightbox(${i})"/>
      <div class="result-image-meta">
        <span>${escapeHtml(prompt.slice(0, 40))}…</span>
        <span>#${i + 1}</span>
      </div>
    </div>`).join('');
}

function openLightbox(index) {
  lightboxIndex = index;
  $('lightboxImg').src = currentImageUrls[index];
  $('lightboxMeta').textContent = `Image ${index + 1} of ${currentImageUrls.length}`;
  $('imageLightbox').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  $('imageLightbox').hidden = true;
  document.body.style.overflow = '';
}

function navigateLightbox(delta) {
  if (!currentImageUrls.length) return;
  lightboxIndex = (lightboxIndex + delta + currentImageUrls.length) % currentImageUrls.length;
  $('lightboxImg').src = currentImageUrls[lightboxIndex];
  $('lightboxMeta').textContent = `Image ${lightboxIndex + 1} of ${currentImageUrls.length}`;
}
// ============================================================
//  AUDIO
// ============================================================
function bindAudio() {
  $('ttsBtn').addEventListener('click', generateTTS);
  const drop = $('sttDrop');
  const fileInp = $('sttFile');
  drop.addEventListener('click', () => fileInp.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('dragover');
    if (e.dataTransfer.files[0]) {
      state.sttFile = e.dataTransfer.files[0];
      $('sttBtn').disabled = false;
      drop.querySelector('p').textContent = state.sttFile.name;
    }
  });
  fileInp.addEventListener('change', (e) => {
    if (e.target.files[0]) {
      state.sttFile = e.target.files[0];
      $('sttBtn').disabled = false;
      drop.querySelector('p').textContent = state.sttFile.name;
    }
  });
  $('sttBtn').addEventListener('click', transcribeSTT);
  $('sttRecordBtn').addEventListener('click', toggleRecord);
}

async function generateTTS() {
  const text = $('ttsText').value.trim();
  if (!text) return toast('Text required', 'error');
  const btn = $('ttsBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…';
  try {
    const r = await fetchJson('/api/tts', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        provider: $('ttsProvider').value,
        model: $('ttsModel').value,
        voice: $('ttsVoice').value,
        text,
        config: _apiConfig(),
      }),
    });
    if (!r.ok) { toast(describeError(r.error), 'error'); $('ttsResult').innerHTML = ''; return; }
    $('ttsResult').innerHTML = `<div class="audio-result"><audio controls src="${r.data.url}"></audio></div>`;
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> Generate';
  }
}

let recState = { recorder: null, chunks: [] };
async function toggleRecord() {
  const btn = $('sttRecordBtn');
  if (recState.recorder) {
    recState.recorder.stop();
    btn.innerHTML = '<i class="fa-solid fa-microphone"></i> Record';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    recState = { recorder: rec, chunks: [] };
    rec.ondataavailable = (e) => recState.chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(recState.chunks, { type: 'audio/webm' });
      state.sttFile = new File([blob], 'recording.webm', { type: 'audio/webm' });
      $('sttBtn').disabled = false;
      $('sttDrop').querySelector('p').textContent = 'recording.webm';
      stream.getTracks().forEach(t => t.stop());
      recState = { recorder: null, chunks: [] };
    };
    rec.start();
    btn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
  } catch (e) {
    toast(`Mic error: ${e.message}`, 'error');
  }
}

async function transcribeSTT() {
  if (!state.sttFile) return;
  const btn = $('sttBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Transcribing…';
  try {
    const fd = new FormData();
    fd.append('audio', state.sttFile);
    fd.append('provider', $('sttProvider').value);
    fd.append('model', $('sttModel').value);
    fd.append('config', JSON.stringify(_apiConfig()));
    const r = await fetch('/api/stt', { method:'POST', body: fd });
    const data = await r.json();
    if (!r.ok) {
      toast(describeError(data.error), 'error'); return;
    }
    $('sttResult').innerHTML = `<div class="audio-result">${escapeHtml(data.text)}</div>`;
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-language"></i> Transcribe';
  }
}

// ============================================================
//  AGENT
// ============================================================
function bindAgent() {
  $('agentRunBtn').addEventListener('click', runAgent);
  $('agentStopBtn').addEventListener('click', stopAgent);
  $$('.chip[data-example]').forEach(c => {
    c.addEventListener('click', () => { $('agentTask').value = c.dataset.example; });
  });
  if ($('agentWsSwitchBtn')) {
    $('agentWsSwitchBtn').addEventListener('click', () => {
      toast('Workspace switching is not available in serverless mode.', 'info');
    });
  }
  if ($('agentWsInput')) {
    $('agentWsInput').placeholder = 'N/A (serverless)';
    $('agentWsInput').disabled = true;
  }
}

function refreshSidebarWorkspace() {
  // Workspace N/A in serverless mode
  if ($('sidebarWorkspacePath')) $('sidebarWorkspacePath').textContent = '(serverless)';
  if ($('agentWsPath')) $('agentWsPath').textContent = '(serverless)';
}

async function runAgent() {
  const task = $('agentTask').value.trim();
  if (!task) return;
  if (state.agentRunId) return;
  const provider = $('agentProvider').value;
  const model = $('agentModel').value;
  const max_steps = parseInt($('agentMaxSteps').value);

  $('agentLog').innerHTML = '';
  $('agentRunBtn').disabled = true;
  $('agentStopBtn').disabled = false;
  $('agentTurnStrip').removeAttribute('hidden');
  state.agentStats = { turn: 0, turn_max: max_steps, tool_calls: 0, tok_in: 0, tok_out: 0 };
  $('agentTurnNow').textContent = '0';
  $('agentTurnMax').textContent = max_steps === 0 ? '∞' : max_steps;
  $('agentToolCalls').textContent = '0';
  $('agentTokIn').textContent = '0';
  $('agentTokOut').textContent = '0';
  state.agentStartedAt = Date.now();
  state.agentTurnTimer = setInterval(() => {
    $('agentElapsed').textContent = Math.floor((Date.now() - state.agentStartedAt) / 1000) + 's';
  }, 500);

  const run_id = `run_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  state.agentRunId = run_id;
  const ctrl = new AbortController();
  state.agentAbort = ctrl;

  try {
    const r = await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        run_id, task, provider, model,
        max_steps, steering: $('agentSteering').value,
        config: _apiConfig(),
      }),
      signal: ctrl.signal,
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const chunk = line.slice(6).trim();
        if (chunk === '[DONE]') break;
        try { handleAgentEvent(JSON.parse(chunk)); } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') addAgentEvent('error', '', `<strong>Run crashed:</strong> ${escapeHtml(e.message)}`);
  } finally {
    state.agentRunId = null;
    state.agentAbort = null;
    $('agentRunBtn').disabled = false;
    $('agentStopBtn').disabled = true;
    if (state.agentTurnTimer) { clearInterval(state.agentTurnTimer); state.agentTurnTimer = null; }
  }
}

function stopAgent() {
  if (state.agentRunId) API.agentCancel(state.agentRunId);
  if (state.agentAbort) state.agentAbort.abort();
}

function addAgentEvent(kind, head, body) {
  const el = document.createElement('div');
  el.className = `agent-event ${kind}`;
  el.innerHTML = `<div class="agent-event-head">${head}</div><div class="agent-event-body">${body}</div>`;
  $('agentLog').appendChild(el);
  $('agentLog').scrollTop = $('agentLog').scrollHeight;
  return el;
}

function handleAgentEvent(ev) {
  if (ev.event === 'start') {
    addAgentEvent('start', `<i class="fa-solid fa-flag"></i> Started`, `Workspace: <code>${escapeHtml(ev.workspace)}</code> · ${ev.provider}/${ev.model} · native tools: ${ev.native_tools ? 'yes' : 'no (JSON fallback)'}`);
  }
  else if (ev.event === 'llm_call') {
    state.agentStats.turn = ev.turn;
    $('agentTurnNow').textContent = ev.turn;
  }
  else if (ev.event === 'usage') {
    if (ev.usage?.prompt_tokens != null) {
      state.agentStats.tok_in += ev.usage.prompt_tokens;
      $('agentTokIn').textContent = state.agentStats.tok_in;
    }
    if (ev.usage?.completion_tokens != null) {
      state.agentStats.tok_out += ev.usage.completion_tokens;
      $('agentTokOut').textContent = state.agentStats.tok_out;
    }
  }
  else if (ev.event === 'thought') {
    addAgentEvent('thought', `<i class="fa-solid fa-brain"></i> Thought · step ${ev.step}`, escapeHtml(ev.text));
  }
  else if (ev.event === 'tool_call') {
    state.agentStats.tool_calls++;
    $('agentToolCalls').textContent = state.agentStats.tool_calls;
    addAgentEvent('tool-call',
      `<i class="fa-solid fa-wrench"></i> Tool · <strong>${escapeHtml(ev.tool)}</strong>`,
      `<pre>${escapeHtml(JSON.stringify(ev.args, null, 2))}</pre>`);
  }
  else if (ev.event === 'tool_stdout') {
    const last = $('agentLog').lastElementChild;
    if (last && last.classList.contains('tool-stdout')) {
      last.querySelector('.agent-event-body').textContent += ev.text;
    } else {
      addAgentEvent('tool-stdout', `<i class="fa-solid fa-terminal"></i> stdout`, escapeHtml(ev.text));
    }
  }
  else if (ev.event === 'tool_result') {
    addAgentEvent('tool-result', `<i class="fa-solid fa-check"></i> Result · ${escapeHtml(ev.tool)}`, `<pre>${escapeHtml(ev.result)}</pre>`);
  }
  else if (ev.event === 'final') {
    addAgentEvent('final', `<i class="fa-solid fa-flag-checkered"></i> Done`, escapeHtml(ev.message));
  }
  else if (ev.event === 'error') {
    addAgentEvent('error', `<i class="fa-solid fa-triangle-exclamation"></i> ${errTitle(ev.error)}`, escapeHtml(describeError(ev.error)));
  }
  else if (ev.event === 'cancelled') {
    addAgentEvent('error', `<i class="fa-solid fa-ban"></i> Cancelled`, '');
  }
}

// ============================================================
//  WEBGPU (transformers.js, in browser)
// ============================================================
async function bindWebGPU() {
  $('wgpuLoadBtn').addEventListener('click', loadWebGPUModel);
  $('wgpuUnloadBtn').addEventListener('click', unloadWebGPUModel);
  $('wgpuSendBtn').addEventListener('click', wgpuSend);
  $('wgpuStopBtn').addEventListener('click', () => { state.wgpu.stopFlag = true; });
  $('wgpuInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); wgpuSend(); }
  });
  // Image generation (if available)
  if ($('wgpuImageGenBtn')) {
    $('wgpuImageGenBtn').addEventListener('click', wgpuGenerateImage);
  }
}

async function ensureWebGPUInit() {
  if (state.wgpu.available !== null) return;
  const has = !!navigator.gpu;
  state.wgpu.available = has;
  $('wgpuStatusText').textContent = has
    ? 'WebGPU available — ready to load a model'
    : 'WebGPU not detected — fallback to WASM (CPU, slower)';
  if (!has) $('wgpuDevice').value = 'wasm';
}

async function loadWebGPUModel() {
  if (state.wgpu.loading) return;
  const modelId = $('wgpuModel').value;
  const device  = $('wgpuDevice').value;
  state.wgpu.loading = true;
  $('wgpuLoadBtn').disabled = true;
  $('wgpuStatusText').textContent = 'Importing transformers.js…';
  $('wgpuStatusModel').textContent = modelId;
  $('wgpuProgressBar').style.width = '0%';
  $('wgpuProgressText').textContent = '0%';
  try {
    const tx = await import(/* @vite-ignore */ WEBGPU_TRANSFORMERS_URL);
    const { pipeline, env } = tx;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    $('wgpuStatusText').textContent = 'Downloading weights (cached after first run)…';

    const pipe = await pipeline('text-generation', modelId, {
      device,
      dtype: 'q4f16',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          const pct = Math.round((p.loaded / p.total) * 100);
          $('wgpuProgressBar').style.width = pct + '%';
          $('wgpuProgressText').textContent = pct + '%';
          $('wgpuStatusText').textContent = `Downloading ${p.file || ''} (${(p.loaded/1e6).toFixed(1)} / ${(p.total/1e6).toFixed(1)} MB)`;
        }
        if (p.status === 'done')  $('wgpuStatusText').textContent = `Loaded · ${p.file || ''}`;
        if (p.status === 'ready') $('wgpuStatusText').textContent = 'Ready';
      },
    });
    state.wgpu.pipe = pipe;
    state.wgpu.model = modelId;
    state.wgpu.device = device;
    $('wgpuStatusText').textContent = `Ready · ${modelId} on ${device.toUpperCase()}`;
    $('wgpuProgressBar').style.width = '100%';
    $('wgpuProgressText').textContent = '100%';
    $('wgpuInput').disabled = false;
    $('wgpuSendBtn').disabled = false;
    $('wgpuUnloadBtn').disabled = false;
    $('wgpuLoadBtn').disabled = false;
    $('wgpuInput').placeholder = 'Type your message…';
    $('wgpuMessages').innerHTML = '';
    state.wgpu.messages = [];
    toast('Model loaded', 'success');
  } catch (e) {
    console.error(e);
    $('wgpuStatusText').textContent = `Load failed: ${e.message || e}`;
    toast(`WebGPU load failed: ${e.message || e}`, 'error');
    $('wgpuLoadBtn').disabled = false;
  } finally {
    state.wgpu.loading = false;
  }
}

function unloadWebGPUModel() {
  state.wgpu.pipe = null;
  state.wgpu.model = null;
  $('wgpuStatusText').textContent = 'Unloaded';
  $('wgpuStatusModel').textContent = 'none';
  $('wgpuProgressBar').style.width = '0%';
  $('wgpuProgressText').textContent = '—';
  $('wgpuInput').disabled = true; $('wgpuInput').placeholder = 'Load a model first…';
  $('wgpuSendBtn').disabled = true; $('wgpuUnloadBtn').disabled = true;
  $('wgpuMessages').innerHTML = '';
  state.wgpu.messages = [];
}

async function wgpuSend() {
  if (!state.wgpu.pipe || state.wgpu.generating) return;
  const text = $('wgpuInput').value.trim();
  if (!text) return;
  state.wgpu.messages.push({ role: 'user', content: text });
  $('wgpuInput').value = '';
  renderWebGPUMessages();
  state.wgpu.generating = true;
  state.wgpu.stopFlag = false;
  $('wgpuStopBtn').disabled = false;
  $('wgpuSendBtn').disabled = true;

  // Append empty assistant
  state.wgpu.messages.push({ role: 'assistant', content: '' });
  renderWebGPUMessages();
  const lastEl = $('wgpuMessages').lastElementChild;

  try {
    const messages = state.wgpu.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    // Simple streaming via TextStreamer if available
    const tx = await import(/* @vite-ignore */ WEBGPU_TRANSFORMERS_URL);
    const streamer = new tx.TextStreamer(state.wgpu.pipe.tokenizer, {
      skip_prompt: true,
      callback_function: (text) => {
        const last = state.wgpu.messages[state.wgpu.messages.length - 1];
        last.content += text;
        if (lastEl) lastEl.querySelector('.webgpu-msg-body').innerHTML = safeMarkdown(last.content);
        $('wgpuMessages').scrollTop = $('wgpuMessages').scrollHeight;
        if (state.wgpu.stopFlag) throw new Error('STOPPED');
      },
    });
    await state.wgpu.pipe(messages, {
      max_new_tokens: 768,
      do_sample: true,
      temperature: 0.7,
      top_p: 0.9,
      streamer,
    });
  } catch (e) {
    if (e.message !== 'STOPPED') {
      const last = state.wgpu.messages[state.wgpu.messages.length - 1];
      last.content = `Error: ${e.message || e}`;
      renderWebGPUMessages();
    }
  } finally {
    state.wgpu.generating = false;
    $('wgpuStopBtn').disabled = true;
    $('wgpuSendBtn').disabled = false;
  }
}

async function wgpuGenerateImage() {
  if (!state.wgpu.pipe) return toast('Load a model first', 'error');
  if (state.wgpu.generating) return;
  
  const prompt = $('wgpuImagePrompt')?.value.trim();
  if (!prompt) return toast('Prompt required', 'error');
  
  const btn = $('wgpuImageGenBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…';
  
  try {
    const tx = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1');
    const { pipeline, env } = tx;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    
    $('wgpuImageStatus').textContent = 'Loading diffusion model…';
    const pipe = await pipeline('text-to-image', 'runwayml/stable-diffusion-v1-5', { device: state.wgpu.device });
    
    $('wgpuImageStatus').textContent = 'Generating image…';
    const result = await pipe(prompt, { guidance_scale: 7.5, num_inference_steps: 50 });
    
    const canvas = result.images[0];
    const imageUrl = canvas.toDataURL ? canvas.toDataURL('image/png') : canvas;
    
    let imgHtml = `<div class="audio-result"><img src="${imageUrl}" alt="Generated" style="max-width: 100%; border-radius: 4px;"></div>`;
    $('wgpuImageResult').innerHTML = imgHtml;
    $('wgpuImageStatus').textContent = 'Generated via local Stable Diffusion';
  } catch (e) {
    toast(`Image gen error: ${e.message}`, 'error');
    $('wgpuImageStatus').textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate';
  }
}

function renderWebGPUMessages() {
  const root = $('wgpuMessages');
  root.innerHTML = state.wgpu.messages.map(m => `
    <div class="webgpu-message ${m.role}">
      <div class="webgpu-message-role">${m.role}</div>
      <div class="webgpu-msg-body">${m.role === 'user' ? escapeHtml(m.content) : safeMarkdown(m.content)}</div>
    </div>`).join('');
  root.scrollTop = root.scrollHeight;
}

// ============================================================
//  TRANSLATE
// ============================================================
function bindTranslate() {
  $('translateBtn').addEventListener('click', doTranslate);
}

async function doTranslate() {
  const text = $('translateInput').value;
  if (!text.trim()) return;
  const btn = $('translateBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Translating…';
  try {
    const r = await API.translate({
      text,
      target_lang: $('translateTarget').value,
      source_lang: $('translateSource').value,
    });
    if (!r.ok) { toast(describeError(r.error), 'error'); return; }
    $('translateOutput').value = r.data.text;
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-language"></i> Translate';
  }
}

// ============================================================
//  PROMPTS LIBRARY
// ============================================================
async function loadPrompts() {
  const r = await API.prompts();
  state.userPrompts = r.ok ? (r.data.prompts || {}) : {};
  renderPromptsView();
}

function renderPromptsView() {
  // Built-in
  const builtin = $('builtinPromptGrid');
  builtin.innerHTML = '';
  for (const k of Object.keys(state.systemPrompts || {})) {
    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.innerHTML = `
      <div class="prompt-card-title">${escapeHtml(k)}</div>
      <div class="prompt-card-body">${escapeHtml(state.systemPrompts[k])}</div>`;
    card.addEventListener('click', () => {
      $('sysModalText').value = state.systemPrompts[k];
      switchView('chat');
      openSystemPromptModal();
    });
    builtin.appendChild(card);
  }
  // User
  const userRoot = $('userPromptGrid');
  userRoot.innerHTML = '';
  const ids = Object.keys(state.userPrompts || {});
  if (!ids.length) {
    userRoot.innerHTML = '<div class="empty"><p class="empty-text">No prompts yet. Click <strong>New prompt</strong> to add one.</p></div>';
    return;
  }
  for (const id of ids) {
    const p = state.userPrompts[id];
    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.innerHTML = `
      <div class="prompt-card-title">${escapeHtml(p.name)}</div>
      <div class="prompt-card-body">${escapeHtml(p.body)}</div>`;
    card.addEventListener('click', () => editPrompt(p));
    userRoot.appendChild(card);
  }
}

function bindPromptsView() {
  $('newPromptBtn').addEventListener('click', () => editPrompt(null));
  $('promptModalSave').addEventListener('click', async () => {
    const id = $('promptModal').dataset.id;
    const name = $('promptModalName').value.trim();
    const body = $('promptModalBody').value.trim();
    if (!name || !body) return toast('Name and body required', 'error');
    const r = await API.savePrompt({ id, name, body });
    if (r.ok) { closeModal('promptModal'); loadPrompts(); toast('Saved', 'success'); }
  });
  $('promptModalDelete').addEventListener('click', async () => {
    const id = $('promptModal').dataset.id;
    if (!id) return;
    if (!await confirmModal('Delete this prompt?', { okText: 'Delete', danger: true })) return;
    await API.deletePrompt(id);
    closeModal('promptModal');
    loadPrompts();
  });
}

function editPrompt(p) {
  const m = $('promptModal');
  if (p) {
    m.dataset.id = p.id;
    $('promptModalTitle').textContent = 'Edit prompt';
    $('promptModalName').value = p.name;
    $('promptModalBody').value = p.body;
    $('promptModalDelete').removeAttribute('hidden');
  } else {
    delete m.dataset.id;
    $('promptModalTitle').textContent = 'New prompt';
    $('promptModalName').value = '';
    $('promptModalBody').value = '';
    $('promptModalDelete').setAttribute('hidden', '');
  }
  openModal('promptModal');
}

// ============================================================
//  FILES (textarea editor — Monaco was overkill)
// ============================================================
function bindFiles() {
  $('fsRefreshBtn').addEventListener('click', refreshFileTree);
  $('fsNewFileBtn').addEventListener('click', async () => {
    const name = await promptModal('New file name (relative to current folder):');
    if (!name) return;
    const path = state.fsCurrentPath ? `${state.fsCurrentPath}/${name}` : name;
    const r = await API.fsWrite(path, '');
    if (r.ok) refreshFileTree();
  });
  $('fsNewFolderBtn').addEventListener('click', async () => {
    const name = await promptModal('New folder name:');
    if (!name) return;
    const path = state.fsCurrentPath ? `${state.fsCurrentPath}/${name}` : name;
    const r = await API.fsMkdir(path);
    if (r.ok) refreshFileTree();
  });
  $('fsSaveBtn').addEventListener('click', saveActiveFile);
  $('editorTextarea').addEventListener('input', () => {
    if (!state.activeFile) return;
    state.openFiles[state.activeFile].dirty = true;
    state.openFiles[state.activeFile].content = $('editorTextarea').value;
    $('fsSaveBtn').disabled = false;
    renderEditorTabs();
  });
}

async function refreshFileTree() {
  const r = await API.fsList(state.fsCurrentPath || '');
  if (!r.ok) { toast(describeError(r.error), 'error'); return; }
  $('fileTreePath').textContent = '/' + (r.data.path || '');
  const root = $('fileTreeItems');
  root.innerHTML = '';
  if (state.fsCurrentPath) {
    const up = document.createElement('div');
    up.className = 'file-tree-item dir';
    up.innerHTML = `<i class="fa-solid fa-arrow-up"></i><span>..</span>`;
    up.addEventListener('click', () => {
      const parts = state.fsCurrentPath.split('/'); parts.pop();
      state.fsCurrentPath = parts.join('/');
      refreshFileTree();
    });
    root.appendChild(up);
  }
  for (const it of r.data.items) {
    const el = document.createElement('div');
    el.className = `file-tree-item ${it.is_dir ? 'dir' : 'file'}`;
    el.innerHTML = `<i class="fa-${it.is_dir ? 'solid fa-folder' : 'regular fa-file'}"></i><span>${escapeHtml(it.name)}</span>`;
    el.addEventListener('click', () => {
      if (it.is_dir) { state.fsCurrentPath = it.path; refreshFileTree(); }
      else openFile(it.path);
    });
    root.appendChild(el);
  }
}

async function openFile(path) {
  if (state.openFiles[path]) {
    setActiveFile(path); return;
  }
  const r = await API.fsRead(path);
  if (!r.ok) { toast(describeError(r.error), 'error'); return; }
  state.openFiles[path] = { content: r.data.content, original: r.data.content, dirty: false };
  setActiveFile(path);
}

function setActiveFile(path) {
  state.activeFile = path;
  $('editorTextarea').value = state.openFiles[path].content;
  $('editorTextarea').placeholder = path;
  $('fsSaveBtn').disabled = !state.openFiles[path].dirty;
  renderEditorTabs();
}

function renderEditorTabs() {
  const root = $('editorTabs');
  const paths = Object.keys(state.openFiles);
  if (!paths.length) {
    root.innerHTML = '<div class="editor-empty">No file open.</div>';
    return;
  }
  root.innerHTML = paths.map(p => `
    <div class="editor-tab ${p === state.activeFile ? 'active' : ''} ${state.openFiles[p].dirty ? 'dirty' : ''}" data-path="${escapeHtml(p)}">
      <span>${escapeHtml(p.split('/').pop())}</span>
      <button class="close-tab" data-close="${escapeHtml(p)}">×</button>
    </div>`).join('');
  root.querySelectorAll('.editor-tab').forEach(t => {
    t.addEventListener('click', (e) => {
      if (e.target.classList.contains('close-tab')) return;
      setActiveFile(t.dataset.path);
    });
  });
  root.querySelectorAll('[data-close]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = b.dataset.close;
      delete state.openFiles[p];
      if (state.activeFile === p) {
        const remaining = Object.keys(state.openFiles);
        state.activeFile = remaining[0] || null;
        if (state.activeFile) setActiveFile(state.activeFile);
        else { $('editorTextarea').value=''; $('editorTextarea').placeholder='Pick a file from the tree…'; $('fsSaveBtn').disabled = true; }
      }
      renderEditorTabs();
    });
  });
}

async function saveActiveFile() {
  if (!state.activeFile) return;
  const f = state.openFiles[state.activeFile];
  const r = await API.fsWrite(state.activeFile, f.content);
  if (r.ok) { f.dirty = false; f.original = f.content; $('fsSaveBtn').disabled = true; renderEditorTabs(); toast('Saved', 'success', 1200); }
  else toast(describeError(r.error), 'error');
}

// ============================================================
//  TERMINAL
// ============================================================
function bindTerminal() {
  $('termClearBtn').addEventListener('click', () => { $('termOutput').innerHTML = ''; });
  $('termRunBtn').addEventListener('click', termRun);
  $('termInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') termRun();
    if (e.key === 'ArrowUp') {
      if (state.termHistory.length === 0) return;
      state.termHistoryIndex = Math.max(0, state.termHistoryIndex - 1);
      $('termInput').value = state.termHistory[state.termHistoryIndex] || '';
    }
    if (e.key === 'ArrowDown') {
      state.termHistoryIndex = Math.min(state.termHistory.length, state.termHistoryIndex + 1);
      $('termInput').value = state.termHistory[state.termHistoryIndex] || '';
    }
  });
}

async function termRun() {
  const cmd = $('termInput').value.trim();
  if (!cmd) return;
  state.termHistory.push(cmd);
  state.termHistoryIndex = state.termHistory.length;
  $('termInput').value = '';
  appendTerm(`> ${cmd}`, 'cmd');
  const r = await API.shellExec(cmd);
  if (!r.ok) { appendTerm(describeError(r.error), 'stderr'); return; }
  if (r.data.stdout) appendTerm(r.data.stdout, 'stdout');
  if (r.data.stderr) appendTerm(r.data.stderr, 'stderr');
  appendTerm(`(exit ${r.data.rc})`, 'exit');
}

function appendTerm(text, cls) {
  const div = document.createElement('div');
  div.className = `terminal-line ${cls}`;
  div.textContent = text;
  $('termOutput').appendChild(div);
  $('termOutput').scrollTop = $('termOutput').scrollHeight;
}

// ============================================================
//  GALLERY
// ============================================================
function bindGallery() {
  $('galleryRefreshBtn').addEventListener('click', refreshGallery);
  $('galleryClearBtn').addEventListener('click', async () => {
    if (!await confirmModal('Delete every item in the gallery?', { okText: 'Clear', danger: true })) return;
    await API.galleryClear();
    refreshGallery();
  });
}

async function refreshGallery() {
  const r = await API.gallery();
  const root = $('galleryGrid');
  if (!r.ok) { toast(describeError(r.error), 'error'); return; }
  if (!r.data.items.length) {
    root.innerHTML = '<div class="empty"><h2 class="empty-title">Empty gallery</h2><p class="empty-text">Generated images and audio will appear here.</p></div>';
    return;
  }
  root.innerHTML = r.data.items.map(it => {
    const inner = it.kind === 'audio'
      ? `<audio controls src="${it.url}"></audio>`
      : `<img src="${it.url}" alt=""/>`;
    return `<div class="gallery-tile">
      ${inner}
      <div class="gallery-tile-meta">
        <span>${escapeHtml(it.name.slice(0, 22))}…</span>
        <a class="btn btn-icon" href="${it.url}" download><i class="fa-solid fa-download"></i></a>
        <button class="btn btn-icon btn-danger" data-del="${escapeHtml(it.name)}"><i class="fa-regular fa-trash-can"></i></button>
      </div>
    </div>`;
  }).join('');
  root.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', async () => {
      await API.galleryDelete(b.dataset.del);
      refreshGallery();
    });
  });
}

// ============================================================
//  SETTINGS
// ============================================================
function bindSettings() {
  $('streamEnabledSetting').addEventListener('change', () => {
    state.config.stream = $('streamEnabledSetting').checked;
    API.saveConfig({ stream: state.config.stream });
  });
  $('webSearchEnabledSetting').addEventListener('change', () => {
    state.config.web_search_enabled = $('webSearchEnabledSetting').checked;
    state.webSearchOn = state.config.web_search_enabled;
    applyToolbarBadges();
    API.saveConfig({ web_search_enabled: state.config.web_search_enabled });
  });
  $('webSearchResultsSetting').addEventListener('change', () => {
    const v = parseInt($('webSearchResultsSetting').value);
    state.config.web_search_results = v;
    API.saveConfig({ web_search_results: v });
  });
  $('defaultTempSetting').addEventListener('input', () => {
    const v = parseFloat($('defaultTempSetting').value);
    $('defaultTempVal').textContent = v.toFixed(1);
    state.config.default_temperature = v;
    API.saveConfig({ default_temperature: v });
  });
  $('uncensoredDefaultSetting').addEventListener('change', () => {
    // purely client-side preference
    state.uncensoredOn = $('uncensoredDefaultSetting').checked;
    if (state.uncensoredOn) pickUncensoredModel();
    applyToolbarBadges();
  });

  if ($('saveWorkspaceBtn')) {
    $('saveWorkspaceBtn').addEventListener('click', () => {
      toast('Workspace is not available in serverless mode.', 'info');
    });
  }
  if ($('workspaceFavoriteBtn')) {
    $('workspaceFavoriteBtn').addEventListener('click', () => {
      toast('Workspace favorites are not available in serverless mode.', 'info');
    });
  }

  $$('.theme-opt').forEach(b => {
    b.addEventListener('click', () => applyTheme(b.dataset.theme));
  });
}

function renderWorkspaceLists() {
  // Workspace is not available in serverless/Vercel mode
  const fav = $('workspaceFavorites');
  if (fav) fav.innerHTML = '<span class="help">Not available in serverless mode.</span>';
  const hist = $('workspaceHistory');
  if (hist) hist.innerHTML = '<span class="help">Not available in serverless mode.</span>';
}

function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  const lite = $('hljs-light'); const dark = $('hljs-dark');
  if (lite && dark) {
    if (theme === 'paper') { lite.disabled = false; dark.disabled = true; }
    else { lite.disabled = true; dark.disabled = false; }
  }
  if (state.config) state.config.theme = theme;
  API.saveConfig({ theme });
}

function renderKeysGrid() {
  const root = $('keysGrid');
  if (!root) return;
  root.innerHTML = '';
  // Order: free → free-tier → paid → local
  const ids = Object.keys(state.providers);
  ids.sort((a, b) => {
    const A = state.providers[a], B = state.providers[b];
    const order = (m) => m.local ? 3 : (m.free ? 0 : (m.free_tier ? 1 : 2));
    return order(A) - order(B);
  });
  for (const pid of ids) {
    const meta = state.providers[pid];
    const tag = meta.local ? '<span class="key-card-tag local">local</span>'
              : meta.free ? '<span class="key-card-tag free">free</span>'
              : meta.free_tier ? '<span class="key-card-tag free-tier">free tier</span>'
              : '';
    const hasUnc = (state.uncensoredModels[pid] || []).length > 0;
    const uncTag = hasUnc ? '<span class="key-card-tag uncensored"><i class="fa-solid fa-fire"></i></span>' : '';
    const card = document.createElement('div');
    card.className = 'key-card';
    let body = `
      <div class="key-card-head">
        <span class="key-card-name" style="color:${meta.color || ''}">${escapeHtml(meta.name)}</span>
        ${tag} ${uncTag}
      </div>
      <div class="key-card-desc">${escapeHtml(meta.description || '')}<br/>
        <a href="${escapeHtml(meta.docs || '#')}" target="_blank" rel="noopener">Get key →</a>
      </div>`;
    if (!meta.free && !meta.local) {
      const storedKey = (state.config.api_keys || {})[pid] || '';
      const hasKey = storedKey.length > 0;
      body += `
        <div class="key-card-input">
          <input type="password" placeholder="${escapeHtml(meta.key_hint || '')}" data-key="${pid}" value=""/>
          <button class="btn btn-primary" data-save-key="${pid}">${hasKey ? 'Update' : 'Save'}</button>
          ${hasKey ? `<button class="btn btn-danger" data-clear-key="${pid}"><i class="fa-regular fa-trash-can"></i></button>` : ''}
        </div>`;
      if (hasKey) {
        // Show masked indicator that key is saved
        body += `<div class="key-card-saved"><i class="fa-solid fa-check-circle" style="color:var(--accent)"></i> Key saved</div>`;
      }
    }
    if (pid === 'cloudflare') {
      const acct = (state.config.provider_config?.cloudflare?.account_id) || '';
      body += `<div class="key-card-extra">Account ID:<input type="text" data-cf-account placeholder="32-char hex id" value="${escapeHtml(acct)}"/></div>`;
    }
    if (pid === 'openrouter') {
      const ref = (state.config.provider_config?.openrouter?.referer) || '';
      const tit = (state.config.provider_config?.openrouter?.title) || '';
      body += `<div class="key-card-extra">Referer:<input type="text" data-or-referer placeholder="https://your.app" value="${escapeHtml(ref)}"/></div>
               <div class="key-card-extra">Title:<input type="text" data-or-title placeholder="GoatAI" value="${escapeHtml(tit)}"/></div>`;
    }
    if (pid === 'deepl') {
      const plan = (state.config.provider_config?.deepl?.plan) || 'free';
      body += `<div class="key-card-extra">Plan: <select data-deepl-plan>
        <option value="free" ${plan==='free'?'selected':''}>Free (api-free.deepl.com)</option>
        <option value="pro"  ${plan==='pro'?'selected':''}>Pro (api.deepl.com)</option>
      </select></div>`;
    }
    card.innerHTML = body;
    root.appendChild(card);
  }
  // Wire save / clear
  root.querySelectorAll('[data-save-key]').forEach(b => {
    b.addEventListener('click', async () => {
      const pid = b.dataset.saveKey;
      const inp = root.querySelector(`[data-key="${pid}"]`);
      const v = (inp.value || '').trim();
      if (!v) { toast('Enter a key first', 'error'); return; }
      await API.saveConfig({ api_keys: { [pid]: v } });
      inp.value = '';
      toast('Key saved', 'success');
      // Refresh model list for this provider now that it has a key
      delete state.modelFetches[pid];
      await fetchModelsForProvider(pid);
      populateProviderSelectors();
      renderKeysGrid();
    });
  });
  root.querySelectorAll('[data-clear-key]').forEach(b => {
    b.addEventListener('click', async () => {
      const pid = b.dataset.clearKey;
      if (!await confirmModal(`Remove saved key for ${state.providers[pid]?.name || pid}?`, { okText: 'Remove', danger: true })) return;
      await API.saveConfig({ api_keys: { [pid]: '' } });
      delete state.modelFetches[pid];
      toast('Key removed', 'success');
      renderKeysGrid();
    });
  });
  root.querySelectorAll('[data-cf-account]').forEach(inp => {
    inp.addEventListener('change', async () => {
      await API.saveConfig({ provider_config: { cloudflare: { account_id: inp.value } } });
      toast('Cloudflare account updated', 'success');
      await loadConfig();
    });
  });
  root.querySelectorAll('[data-or-referer]').forEach(inp => {
    inp.addEventListener('change', async () => {
      await API.saveConfig({ provider_config: { openrouter: { referer: inp.value } } });
    });
  });
  root.querySelectorAll('[data-or-title]').forEach(inp => {
    inp.addEventListener('change', async () => {
      await API.saveConfig({ provider_config: { openrouter: { title: inp.value } } });
    });
  });
  root.querySelectorAll('[data-deepl-plan]').forEach(sel => {
    sel.addEventListener('change', async () => {
      await API.saveConfig({ provider_config: { deepl: { plan: sel.value } } });
    });
  });
}

// ============================================================
//  Boot
// ============================================================
init().catch((e) => {
  console.error(e);
  toast(`Init failed: ${e.message || e}`, 'error');
});

// background.js (MV3) — yt-dlp-web-ui v4, runtime origin permission
//
// v4 API (same paths as v3):
//   POST /auth/login           {username, password} -> JSON string token (text/plain), 400 on bad login
//   POST /api/v1/exec          {url, params?, path?, rename?} with X-Authentication: <token>
//   POST /api/v1/execPlaylist  same body, expands a playlist into single downloads
// A missing/expired token answers 400 "token is malformed" / "token expired".
// The token is valid for 30 days, so it is kept in session storage instead of
// logging in on every click.

const MENU_ID = 'ytdownloader';
const BASE_PATTERNS = [
  'https://www.youtube.com/*',
  'https://m.youtube.com/*',
  'https://youtu.be/*',
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Send to YTdownloader',
    targetUrlPatterns: BASE_PATTERNS,
    contexts: ['link'],
  });
});

async function readBody(resp) {
  const ctype = resp.headers.get('content-type') || '';
  const text = await resp.text();
  if (ctype.includes('application/json')) {
    try { return { kind: 'json', value: JSON.parse(text) }; } catch {}
  }
  return { kind: 'text', value: text };
}
function bodyText(body) {
  return (typeof body.value === 'string' ? body.value : JSON.stringify(body.value)).trim();
}
function tokenFromJson(obj) {
  if (typeof obj === 'string') return obj;
  if (!obj || typeof obj !== 'object') return null;
  const paths = ['token','access_token','accessToken','jwt','id_token','idToken','data.token','data.access_token','result.token','auth.token'];
  for (const p of paths) {
    const v = p.split('.').reduce((o,k)=> (o && o[k]!==undefined ? o[k] : undefined), obj);
    if (typeof v === 'string' && v) return v;
  }
  return null;
}
function unquoteToken(str) {
  if (typeof str !== 'string') return null;
  let t = str.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { t = JSON.parse(t); } catch { t = t.slice(1,-1); }
  }
  return t || null;
}
async function ensureOriginPermission(baseUrl) {
  const origin = new URL(baseUrl).origin + '/*';
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`Permission denied for ${origin}`);
  return true;
}
async function openOrActivateTab(rawUrl, currentTab) {
  const u = new URL(rawUrl);
  // Without permission to read tab URLs the query returns nothing: then open a new tab.
  const candidates = await chrome.tabs.query({ url: `${u.origin}/*` }).catch(() => []);
  const exact = candidates?.find?.(t => t.url === rawUrl);
  const existing = exact || (candidates && candidates[0]) || null;
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
    return existing.id;
  }
  const createOptions = { url: rawUrl };
  if (currentTab && Number.isInteger(currentTab.index)) {
    createOptions.index = currentTab.index + 1;
    createOptions.openerTabId = currentTab.id;
  }
  const created = await chrome.tabs.create(createOptions);
  return created?.id ?? null;
}

// Result on the toolbar icon: errors used to go to the service worker console
// only, so a wrong password looked like "the extension does nothing".
async function showResult(ok, message) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: ok ? '#2e7d32' : '#c62828' });
    await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
    // The error text stays in the icon tooltip until the next send.
    await chrome.action.setTitle({ title: ok ? 'Sent to YTdownloader' : `YT Sender error: ${message}` });
  } catch {}
  setTimeout(() => { chrome.action.setBadgeText({ text: '' }).catch(() => {}); }, ok ? 3000 : 10000);
}

function tokenKey(baseUrl, authentication) {
  return `${baseUrl}|${authentication?.auth_username || ''}`;
}
async function login(baseUrl, authentication) {
  const resp = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: authentication.auth_username || '',
      password: authentication.auth_password || '',
    }),
  });
  const body = await readBody(resp);
  if (!resp.ok) {
    const text = bodyText(body);
    if (/invalid username or password/i.test(text)) {
      throw new Error('login failed: wrong username or password (check the extension options)');
    }
    throw new Error(`login failed (${resp.status}): ${text}`);
  }
  const token = body.kind === 'json' ? tokenFromJson(body.value) : unquoteToken(body.value);
  if (!token) throw new Error('login answered without a token');
  await chrome.storage.session.set({ yt_token: { key: tokenKey(baseUrl, authentication), token } });
  return token;
}
async function getToken(baseUrl, authentication, forceLogin) {
  if (!forceLogin) {
    const { yt_token } = await chrome.storage.session.get(['yt_token']);
    if (yt_token?.key === tokenKey(baseUrl, authentication) && yt_token.token) return yt_token.token;
  }
  return login(baseUrl, authentication);
}
function isTokenError(status, text) {
  return (status === 400 || status === 401) && /token/i.test(text);
}

// youtube.com/playlist?list=... has no single video: v4 expands it server-side.
function isPlaylistUrl(videoUrl) {
  try {
    const u = new URL(videoUrl);
    return /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === '/playlist' && u.searchParams.has('list');
  } catch { return false; }
}

async function sendVideoUrlToYTdownloader(videoUrl, baseUrl, authentication) {
  await ensureOriginPermission(baseUrl);
  const endpoint = isPlaylistUrl(videoUrl) ? 'execPlaylist' : 'exec';

  const post = (token) => fetch(`${baseUrl}/api/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { 'X-Authentication': token } : {}),
    },
    body: JSON.stringify({ url: videoUrl, params: [] }),
  });

  const auth = !!authentication?.auth_enabled;
  let resp = await post(auth ? await getToken(baseUrl, authentication, false) : null);
  let body = await readBody(resp);

  if (!resp.ok && isTokenError(resp.status, bodyText(body))) {
    if (!auth) throw new Error('the server requires a login: enable Authentication in the extension options');
    // Cached token expired or the server's JWT secret changed: log in once more.
    resp = await post(await getToken(baseUrl, authentication, true));
    body = await readBody(resp);
  }
  if (!resp.ok) throw new Error(`send failed (${resp.status}): ${bodyText(body)}`);
  return true;
}

async function sendAndReport(videoUrl, data, switchTo, tab) {
  try {
    await sendVideoUrlToYTdownloader(videoUrl, data.ytdownloader, data.authentication);
    await showResult(true);
    if (switchTo) await openOrActivateTab(data.ytdownloader, tab);
  } catch (e) {
    console.error('[YT Sender]', e);
    await showResult(false, e?.message || String(e));
  }
}

// Context menu
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const data = await chrome.storage.sync.get(['ytdownloader','contextMenuClickBehavior','authentication']);
  if (!data?.ytdownloader) {
    await openOrActivateTab(chrome.runtime.getURL('options.html'), tab);
    return;
  }
  const needToSwitch = data.contextMenuClickBehavior === 'context-menu-send-current-url-and-switch';
  await sendAndReport(info.linkUrl, data, needToSwitch, tab);
});

// Toolbar click
chrome.action.onClicked.addListener(async (clickedTab) => {
  const data = await chrome.storage.sync.get(['ytdownloader','clickBehavior','authentication']);
  if (!data?.ytdownloader) {
    await openOrActivateTab(chrome.runtime.getURL('options.html'), clickedTab);
    return;
  }
  if (data.clickBehavior === 'go-to-ytdownloader') {
    await openOrActivateTab(data.ytdownloader, clickedTab);
    return;
  }
  const needToSwitch = data.clickBehavior === 'send-current-url-and-switch';
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.url) {
    await showResult(false, 'no active tab URL');
    return;
  }
  await sendAndReport(active.url, data, needToSwitch, clickedTab);
});

// A changed server or login invalidates the cached token.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.ytdownloader || changes.authentication)) {
    chrome.storage.session.remove('yt_token').catch(() => {});
  }
});

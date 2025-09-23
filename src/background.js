// background.js (MV3) — production with runtime origin-permission

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ytdownloader',
    title: 'Send to YTdownloader',
    targetUrlPatterns: [
      'https://www.youtube.com/*',
      'https://m.youtube.com/*',
      'https://youtu.be/*',
    ],
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
function tokenFromJson(obj) {
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
  return t;
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
  // próbálunk keresni, ha nincs engedély a tab URL olvasására, ez üres listát ad — fallback-ként nyitunk
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
async function sendVideoUrlToYTdownloader(videoUrl, baseUrl, authentication) {
  // biztosítsd, hogy van engedélyünk a fetch-hez
  await ensureOriginPermission(baseUrl);

  const jsonHeaders = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
  let headers = { ...jsonHeaders };

  if (authentication?.auth_enabled) {
    const loginResp = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: jsonHeaders,
      credentials: 'include',
      body: JSON.stringify({
        username: authentication.auth_username || '',
        password: authentication.auth_password || '',
      }),
    });
    const body = await readBody(loginResp);
    if (!loginResp.ok) throw new Error(`Login failed (${loginResp.status})`);
    let token = null;
    if (body.kind === 'text') token = unquoteToken(body.value);
    else if (body.kind === 'json') token = tokenFromJson(body.value);
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['x-authentication'] = token;
    }
  }

  const execResp = await fetch(`${baseUrl}/api/v1/exec`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ url: videoUrl }),
  });
  if (!execResp.ok) {
    const errBody = await readBody(execResp);
    throw new Error(`Exec failed (${execResp.status}): ${typeof errBody.value === 'string' ? errBody.value : JSON.stringify(errBody.value)}`);
  }
  return true;
}

// Context menu
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ytdownloader') return;
  const data = await chrome.storage.sync.get(['ytdownloader','contextMenuClickBehavior','authentication']);
  if (!data?.ytdownloader) {
    await openOrActivateTab(chrome.runtime.getURL('options.html'), tab);
    return;
  }
  const needToSwitch = data.contextMenuClickBehavior === 'context-menu-send-current-url-and-switch';
  try {
    await sendVideoUrlToYTdownloader(info.linkUrl, data.ytdownloader, data.authentication);
    if (needToSwitch) await openOrActivateTab(data.ytdownloader, tab);
  } catch (e) { console.error(e); }
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
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const videoUrl = active?.url;
    if (!videoUrl) throw new Error('No active tab URL');
    await sendVideoUrlToYTdownloader(videoUrl, data.ytdownloader, data.authentication);
    if (needToSwitch) await openOrActivateTab(data.ytdownloader, clickedTab);
  } catch (e) { console.error(e); }
});

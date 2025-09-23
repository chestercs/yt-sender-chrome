// options.js — permission aware save

async function saveOptions() {
  let url = (document.getElementById('ytdownloader').value || '').trim();
  url = normalizeBaseUrl(url); // http(s) + no trailing slash

  const sitesRaw = document.getElementById('additional').value || '';
  const clickBehavior = document.querySelector('input[name="click-behavior"]:checked')?.value || '';
  const contextMenuClickBehavior = document.querySelector('input[name="context-menu-click-behavior"]:checked')?.value || '';

  const authentication = {
    auth_enabled: !!document.getElementById('auth_enabled').checked,
    auth_username: document.getElementById('auth_username').value || '',
    auth_password: document.getElementById('auth_password').value || '',
  };

  // Eredeti beállítások betöltése, hogy tudjuk a régi engedélyt törölni ha kell
  const prev = await chrome.storage.sync.get(['ytdownloader_granted_origin']);

  // Mentés
  await chrome.storage.sync.set({
    ytdownloader: url,
    sites: sitesRaw,
    clickBehavior,
    contextMenuClickBehavior,
    authentication,
  });

  // UX feedback
  const savedEl = document.getElementById('saved');
  if (savedEl) {
    savedEl.classList.remove('hidden');
    setTimeout(() => savedEl.classList.add('hidden'), 10_000);
  }

  // Context menu minták frissítése (ahogy korábban)
  const basePatterns = [
    'https://www.youtube.com/*',
    'https://m.youtube.com/*',
    'https://youtu.be/*',
  ];
  const extraPatterns = splitLines(sitesRaw)
    .map(s => s.trim())
    .filter(Boolean)
    .map(toMatchPattern)
    .filter(Boolean)
    .filter(onlyUnique);
  chrome.contextMenus.update('ytdownloader', { targetUrlPatterns: [...basePatterns, ...extraPatterns] }, () => {
    if (chrome.runtime.lastError) console.error('[options] contextMenus.update:', chrome.runtime.lastError.message);
  });

  // === ÚJ: kérj eredethozzáférést az új YTdownloader hostra ===
  if (url) {
    try {
      const origin = new URL(url).origin + '/*';
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (!has) {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (granted) {
          await chrome.storage.sync.set({ ytdownloader_granted_origin: origin });
        } else {
          console.warn('[options] user denied host permission for', origin);
        }
      } else {
        // már megvan – frissítsük a nyilvántartást
        await chrome.storage.sync.set({ ytdownloader_granted_origin: origin });
      }

      // Ha megváltozott a host, a régit eltávolítjuk
      const prevOrigin = prev?.ytdownloader_granted_origin;
      if (prevOrigin && prevOrigin !== origin) {
        await chrome.permissions.remove({ origins: [prevOrigin] });
      }
    } catch (e) {
      console.error('[options] permission handling error', e);
    }
  }
}

async function restoreOptions() {
  const data = await chrome.storage.sync.get(['ytdownloader','sites','clickBehavior','contextMenuClickBehavior','authentication']);
  if (data.ytdownloader !== undefined) {
    document.getElementById('ytdownloader').value = data.ytdownloader;
  }
  if (data.sites !== undefined) {
    document.getElementById('additional').value = data.sites;
  }
  if (data.clickBehavior) {
    const el = document.getElementById(data.clickBehavior);
    if (el) el.checked = true;
  }
  if (data.contextMenuClickBehavior) {
    const el = document.getElementById(data.contextMenuClickBehavior);
    if (el) el.checked = true;
  }
  if (data.authentication) {
    const auth = data.authentication;
    const chk = document.getElementById('auth_enabled');
    if (chk) chk.checked = !!auth.auth_enabled;
    const user = document.getElementById('auth_username');
    if (user) user.value = auth.auth_username ?? '';
    const pass = document.getElementById('auth_password');
    if (pass) pass.value = auth.auth_password ?? '';
  }
}

// --- helpers (ugyanazok, mint előbb) ---
function splitLines(t) { return (t || '').split(/\r\n|\r|\n/); }
function onlyUnique(v,i,a){ return a.indexOf(v)===i; }
function normalizeBaseUrl(input){
  let s = (input || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    let out = `${u.protocol}//${u.host}${u.pathname}`;
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch { return s.replace(/\/+$/, ''); }
}
function toMatchPattern(s){
  if (looksLikeMatchPattern(s)) return isValidMatchPattern(s) ? s : null;
  let candidate = s;
  if (!/^[a-z*]+:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  try {
    const u = new URL(candidate);
    const host = u.host;
    const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '';
    const scheme = (u.protocol === 'http:' || u.protocol === 'https:') ? u.protocol.replace(':','') : '*';
    const pattern = `${scheme}://${host}${path}/*`;
    return isValidMatchPattern(pattern) ? pattern : null;
  } catch { return null; }
}
function looksLikeMatchPattern(p){ return /^(\*|https?):\/\/[^/]+\/.*$/i.test(p); }
function isValidMatchPattern(p){
  if (/^chrome(-extension)?:\/\//i.test(p)) return true;
  const m = p.match(/^(\*|https?):\/\/([^/]+)\/(.*)$/i);
  if (!m) return false;
  const scheme = m[1], host = m[2], path = '/' + m[3];
  if (!(scheme==='*' || scheme==='http' || scheme==='https')) return false;
  if (!host || host.includes('..')) return false;
  if (host.includes('*')) {
    if (host !== '*' && !host.startsWith('*.')) return false;
    if ((host.match(/\*/g)||[]).length>1) return false;
  }
  if (!path.startsWith('/')) return false;
  return true;
}

window.addEventListener('DOMContentLoaded', restoreOptions, { passive: true });
document.querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveOptions();
}, { passive: false });

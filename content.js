/**
 * BeeSpy — content script
 * Runs in MAIN world (see manifest.json)
 *
 * ── What this does ────────────────────────────────────────────────────────
 *  1. Wraps XMLHttpRequest to intercept incoming encounters data and outgoing votes.
 *  2. Renders a floating panel showing the full profile queue.
 *  3. Persists theme, font-size, panel position and size in localStorage.
 *
 * ── Transport layer ───────────────────────────────────────────────────────
 *  All mwebapi.phtml traffic uses XHR, NOT fetch.
 *  Outgoing vote body format (message_type 80):
 *    { "$gpb": "badoo.bma.BadooMessage", "body": [{
 *        "message_type": 80,
 *        "server_encounters_vote": { "person_id", "vote", "vote_source", "game_mode" }
 *    }]}
 *  vote values: 2 = YES · 3 = NO · 7 = SUPERSWIPE
 */

(function () {
  'use strict';

  // Only activate on bumble.com domains (with or without subdomain)
  if (!/(?:^|\.)bumble\.com$/.test(window.location.hostname)) return;

  // ── Config ────────────────────────────────────────────────────────────────
  const PANEL_ID         = 'bi-panel';
  const STORAGE_THEME    = 'bi-theme';
  const STORAGE_FONT     = 'bi-fontsize';
  const STORAGE_WIDTH    = 'bi-width';
  const STORAGE_HEIGHT   = 'bi-height';
  const STORAGE_POS_LEFT = 'bi-pos-left';
  const STORAGE_POS_TOP  = 'bi-pos-top';

  const FONT_MIN     = 9;
  const FONT_MAX     = 18;
  const FONT_DEFAULT = 12;

  const PANEL_MIN_WIDTH  = 220;
  const PANEL_MAX_WIDTH  = 560;
  const PANEL_MIN_HEIGHT = 160;

  // ── Logging helpers ───────────────────────────────────────────────────────
  const _log  = (...a) => console.log('[BeeSpy]', ...a);
  const _warn = (...a) => console.warn('[BeeSpy]', ...a);

  // ── State ─────────────────────────────────────────────────────────────────
  const store = new Map();
  const order = [];
  let theme          = localStorage.getItem(STORAGE_THEME) || 'light';
  let fontSize       = Math.min(FONT_MAX, Math.max(FONT_MIN,
                         Number(localStorage.getItem(STORAGE_FONT)) || FONT_DEFAULT));
  let quotaRemaining = null;   // real server-side likes remaining
  let quotaMax       = null;   // highest quota seen = daily total

  // ── JSON.parse patch — modify responses before the app reads them ─────────
  const _origParse = JSON.parse;
  JSON.parse = function (text, ...args) {
    const r = _origParse.call(this, text, ...args);
    const body0 = r?.body?.[0];
    // Capture real quota before spoofing, then spoof so the blocker never fires
    const quota = r?.body?.[0]?.client_encounters?.quota;
    if (quota && typeof quota.yes_votes_quota === 'number') {
      quotaRemaining = quota.yes_votes_quota;
      if (quotaMax === null || quotaRemaining > quotaMax) quotaMax = quotaRemaining;
      if (quota.yes_votes_quota < 500) quota.yes_votes_quota = 500;
    }
    // Enable backtrack (100) and premium (295) in every feature array across all body elements.
    // Startup response stores features in client_startup.app_feature[] and
    // client_common_settings.application_features[], both using the key `feature` (not `id`).
    const TARGET_FEATURES = new Set([100, 295]);
    if (Array.isArray(r?.body)) {
      r.body.forEach(b => {
        [
          b?.client_startup?.app_feature,
          b?.client_common_settings?.application_features,
          b?.features,
        ].forEach(arr => {
          if (!Array.isArray(arr)) return;
          arr.forEach(f => {
            if (TARGET_FEATURES.has(f?.feature) || TARGET_FEATURES.has(f?.id)) {
              f.enabled = true;
              f.required_action = 0;
            }
          });
        });
      });
    }
    return r;
  };

  // ── XHR intercept ─────────────────────────────────────────────────────────
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._bi_mwebapi = typeof url === 'string' && url.includes('mwebapi.phtml');
    return _xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._bi_mwebapi) {
      _interceptOutgoing(body);
      this.addEventListener('load', () => {
        if (this.status === 200) {
          try { _interceptIncoming(JSON.parse(this.responseText)); } catch (_) {}
        }
      });
    }
    return _xhrSend.call(this, body);
  };

  function _interceptOutgoing(body) {
    try {
      if (typeof body !== 'string') return;
      const req = JSON.parse(body);
      if (req?.body?.[0]?.message_type !== 80) return;
      const v = req.body[0]?.server_encounters_vote;
      if (!v?.person_id) return;
      const p = store.get(v.person_id);
      if (p) p.myVote = v.vote;
      if (v.vote === 2 && quotaRemaining !== null && quotaRemaining > 0) quotaRemaining--;
      const idx = order.indexOf(v.person_id);
      if (idx !== -1) order.splice(idx, 1);
      renderPanel();
    } catch (_) {}
  }

  function _interceptIncoming(res) {
    const results = res?.body?.[0]?.client_encounters?.results;
    if (!Array.isArray(results)) return;
    // Do NOT clear — only add profiles not already in queue.
    // Clearing would wipe profiles the user hasn't swiped yet.
    // _parseResult deduplicates via order.includes() check.
    results.forEach(_parseResult);
    if (order.length > 0) renderPanel();
  }

  // ── Profile parsing ───────────────────────────────────────────────────────
  const KNOWN_FIELDS = new Set([
    'aboutme_text', 'lifestyle_dating_intentions', 'lifestyle_height',
    'lifestyle_drinking', 'lifestyle_smoking', 'lifestyle_family_plans',
    'lifestyle_exercise', 'lifestyle_star_sign', 'lifestyle_politics',
    'lifestyle_education_level',
  ]);

  function _parseResult(result) {
    const u = result?.user;
    if (!u?.user_id) return;

    const prev         = store.get(u.user_id);
    const hasUserVoted = result.has_user_voted === true;
    const myVote       = prev?.myVote || u.my_vote || 0;

    const f = {};
    const extras = [];
    (u.profile_fields || []).forEach(pf => {
      f[pf.id] = pf.display_value || '';
      if (!KNOWN_FIELDS.has(pf.id) && pf.display_value) {
        extras.push({ q: pf.name, a: pf.display_value });
      }
    });

    store.set(u.user_id, {
      userId:      u.user_id,
      name:        u.name || '?',
      age:         u.age  || '',
      verified:    u.verification_status === 1,
      hasUserVoted, myVote,
      photoCount:  (u.albums || []).reduce((s, a) => s + (a.count_of_photos || 0), 0),
      firstPhoto:  u.albums?.[0]?.photos?.[0]?.preview_url || null,
      about:       f['aboutme_text']                || '',
      lookingFor:  f['lifestyle_dating_intentions'] || '',
      height:      f['lifestyle_height']            || '',
      drinking:    f['lifestyle_drinking']          || '',
      smoking:     f['lifestyle_smoking']           || '',
      kids:        f['lifestyle_family_plans']      || '',
      exercise:    f['lifestyle_exercise']          || '',
      starSign:    f['lifestyle_star_sign']         || '',
      politics:    f['lifestyle_politics']          || '',
      education:   f['lifestyle_education_level']   || '',
      distance:    u.distance_long                  || '',
      extras,
    });

    if (!order.includes(u.user_id)) order.push(u.user_id);
  }

  function orderedProfiles() {
    return order.map(id => store.get(id)).filter(Boolean);
  }

  // ── HTML helpers ──────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function row(icon, label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="bi-row">
      <span class="bi-row-icon">${icon}</span>
      <span class="bi-row-label">${label}</span>
      <span class="bi-row-value">${esc(value)}</span>
    </div>`;
  }

  function myVoteBadge(v) {
    if (v === 2) return ['bi-badge--yes',   '👍 Liked'];
    if (v === 3) return ['bi-badge--no',    '👎 Passed'];
    if (v === 7) return ['bi-badge--super', '⚡ Super'];
    return              ['bi-badge--none',  '· pending'];
  }

  // ── Card builders ─────────────────────────────────────────────────────────
  function _buildCardHeader(p, i) {
    const imgUrl      = p.firstPhoto ? 'https:' + p.firstPhoto.replace('__size__', '120x120') : null;
    const [mvCls, mvTxt]  = myVoteBadge(p.myVote);
    const hasVotedCls = p.hasUserVoted ? 'bi-badge--voted'   : 'bi-badge--not-voted';
    const hasVotedTxt = p.hasUserVoted ? '✓ Voted'           : '○ Not voted';

    return `<div class="bi-card-header" role="button" tabindex="0" aria-expanded="false">
      <div class="bi-avatar-wrap">
        ${imgUrl
          ? `<img class="bi-avatar" src="${imgUrl}" alt="${esc(p.name)}" loading="lazy">`
          : `<div class="bi-avatar bi-avatar--placeholder">${i + 1}</div>`}
        ${i === 0 ? '<span class="bi-dot"></span>' : ''}
      </div>
      <div class="bi-card-info">
        <div class="bi-card-name">
          ${esc(p.name)}<span class="bi-age">, ${p.age}</span>
          ${p.verified ? '<span class="bi-verified">✓</span>' : ''}
        </div>
        <div class="bi-badges">
          <span class="bi-badge ${mvCls}">${mvTxt}</span>
          <span class="bi-badge ${hasVotedCls}">${hasVotedTxt}</span>
        </div>
      </div>
      <svg class="bi-chevron" viewBox="0 0 10 6" fill="none">
        <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>`;
  }

  function _buildCardBody(p) {
    return `<div class="bi-card-body" hidden>
      <div class="bi-rows">
        ${row('📸', 'Photos',      p.photoCount)}
        ${row('🎯', 'Looking for', p.lookingFor)}
        ${row('📏', 'Height',      p.height)}
        ${row('🍷', 'Drinking',    p.drinking)}
        ${row('🚬', 'Smoking',     p.smoking)}
        ${row('👶', 'Kids',        p.kids)}
        ${row('🏃', 'Exercise',    p.exercise)}
        ${row('⭐', 'Star sign',   p.starSign)}
        ${row('🗳️', 'Politics',   p.politics)}
        ${row('🎓', 'Education',   p.education)}
        ${row('📍', 'Distance',    p.distance)}
        ${p.extras.map(e => row('💬', e.q, e.a)).join('')}
      </div>
      ${p.about ? `<p class="bi-about">${esc(p.about)}</p>` : ''}
    </div>`;
  }

  function buildCard(p, i) {
    return `<div class="bi-card ${i === 0 ? 'bi-card--active' : ''}" data-uid="${esc(p.userId)}">
      ${_buildCardHeader(p, i)}
      ${_buildCardBody(p)}
    </div>`;
  }

  function buildPanelHTML(profiles) {
    if (!profiles.length) {
      return `<div class="bi-empty">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"
                stroke="currentColor" stroke-width="1.5"/>
          <path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <span>Navigate to the swipe page</span>
      </div>`;
    }
    return profiles.map(buildCard).join('');
  }

  // ── Card open / close helpers ─────────────────────────────────────────────
  function _openCard(card) {
    card.classList.add('bi-card--open');
    card.querySelector('.bi-card-body').hidden = false;
    card.querySelector('.bi-card-header').setAttribute('aria-expanded', 'true');
  }

  function _closeCard(card) {
    card.classList.remove('bi-card--open');
    card.querySelector('.bi-card-body').hidden = true;
    card.querySelector('.bi-card-header').setAttribute('aria-expanded', 'false');
  }

  // ── Panel template ────────────────────────────────────────────────────────
  function _panelTemplate() {
    return `
      <header class="bi-header">
        <span class="bi-logo">
          <svg id="bi-logo-icon" class="bi-logo-svg" viewBox="0 0 18 18" fill="none"
               xmlns="http://www.w3.org/2000/svg">
            <circle cx="9" cy="9" r="8" stroke="currentColor" stroke-width="1.4"/>
            <path d="M6 9.5l2 2 4-4" stroke="currentColor" stroke-width="1.4"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          BeeSpy
        </span>
        <div class="bi-header-actions">
          <a class="bi-update-badge" id="bi-update-badge" hidden
             href="https://github.com/seadox/beespy/releases" target="_blank"
             rel="noopener" title="Update available" aria-label="Update available">↑ Update</a>
          <button class="bi-btn-icon bi-btn-font" id="bi-font-dec"
                  title="Decrease font size" aria-label="Decrease font size">A−</button>
          <button class="bi-btn-icon bi-btn-font" id="bi-font-inc"
                  title="Increase font size" aria-label="Increase font size">A+</button>
          <button class="bi-btn-icon" id="bi-theme-toggle"
                  title="Toggle dark mode" aria-label="Toggle theme">
            <svg class="bi-icon-sun" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="4" stroke="currentColor" stroke-width="1.5"/>
              <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42"
                    stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <svg class="bi-icon-moon" viewBox="0 0 20 20" fill="none">
              <path d="M17.39 11.73A7 7 0 0 1 8.27 2.61 7.002 7.002 0 1 0 17.39 11.73z"
                    stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="bi-btn-icon" id="bi-collapse"
                  title="Collapse" aria-label="Collapse panel">
            <svg viewBox="0 0 20 20" fill="none">
              <path d="M5 10h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </header>
      <div class="bi-quota-bar" id="bi-quota-bar" hidden></div>
      <div class="bi-body" id="bi-body"></div>
      <footer class="bi-footer" id="bi-footer">
        <span class="bi-credit">Created by Seadox</span>
      </footer>
      <div class="bi-resize-grip" aria-hidden="true"></div>`;
  }

  // ── Font size ─────────────────────────────────────────────────────────────
  function _applyFontSize(panel) {
    panel.style.setProperty('--bi-font-size', fontSize + 'px');
  }

  // ── Panel DOM ─────────────────────────────────────────────────────────────
  function getOrCreatePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.setAttribute('data-theme', theme);
      panel.innerHTML = _panelTemplate();
      document.body.appendChild(panel);
      _applyFontSize(panel);
      _restoreSize(panel);
      _restorePosition(panel);
      _syncBodyHeight(panel);
      _attachPanelEvents(panel);
      _makeDraggable(panel, panel.querySelector('.bi-header'));
      _makeResizable(panel, panel.querySelector('.bi-resize-grip'));
    }
    return panel;
  }

  // ── Panel events ──────────────────────────────────────────────────────────
  function _attachPanelEvents(panel) {
    panel.querySelector('#bi-collapse').addEventListener('click', e => {
      e.stopPropagation();
      const collapsed = panel.classList.toggle('bi--collapsed');
      panel.querySelector('#bi-collapse').setAttribute('aria-label',
        collapsed ? 'Expand panel' : 'Collapse panel');
      panel.querySelector('#bi-collapse svg path').setAttribute('d',
        collapsed ? 'M5 10h10M10 5v10' : 'M5 10h10');
    });

    const adjustFont = delta => {
      fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize + delta));
      _applyFontSize(panel);
      localStorage.setItem(STORAGE_FONT, fontSize);
    };
    panel.querySelector('#bi-font-dec').addEventListener('click', e => { e.stopPropagation(); adjustFont(-1); });
    panel.querySelector('#bi-font-inc').addEventListener('click', e => { e.stopPropagation(); adjustFont(+1); });

    panel.querySelector('#bi-theme-toggle').addEventListener('click', e => {
      e.stopPropagation();
      theme = theme === 'light' ? 'dark' : 'light';
      panel.setAttribute('data-theme', theme);
      localStorage.setItem(STORAGE_THEME, theme);
    });

    _attachCardEvents(panel);
  }

  function _attachCardEvents(panel) {
    panel.querySelector('#bi-body').addEventListener('click', e => {
      const header = e.target.closest('.bi-card-header');
      if (!header) return;
      const card   = header.closest('.bi-card');
      const isOpen = card.classList.contains('bi-card--open');
      panel.querySelectorAll('.bi-card--open').forEach(other => {
        if (other !== card) _closeCard(other);
      });
      isOpen ? _closeCard(card) : _openCard(card);
    });

    panel.querySelector('#bi-body').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        const header = e.target.closest('.bi-card-header');
        if (header) { e.preventDefault(); header.click(); }
      }
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function renderPanel() {
    const panel    = getOrCreatePanel();
    const body     = panel.querySelector('#bi-body');
    const profiles = orderedProfiles();
    const openUid  = body.querySelector('.bi-card--open')?.dataset.uid ?? null;

    body.innerHTML = buildPanelHTML(profiles);

    const toOpen = openUid
      ? (body.querySelector(`.bi-card[data-uid="${openUid}"]`) ?? body.querySelector('.bi-card'))
      : body.querySelector('.bi-card');
    if (toOpen) _openCard(toOpen);

    // Update quota bar
    const quotaBar = panel.querySelector('#bi-quota-bar');
    if (quotaBar) {
      if (quotaRemaining !== null && quotaMax !== null) {
        quotaBar.textContent = `${quotaRemaining} / ${quotaMax} likes`;
        quotaBar.hidden = false;
      } else {
        quotaBar.hidden = true;
      }
    }
  }

  // ── Position persistence ──────────────────────────────────────────────────
  function _savePosition(el) {
    if (el.style.left) localStorage.setItem(STORAGE_POS_LEFT, el.style.left);
    if (el.style.top)  localStorage.setItem(STORAGE_POS_TOP,  el.style.top);
  }

  function _restorePosition(el) {
    const left = localStorage.getItem(STORAGE_POS_LEFT);
    const top  = localStorage.getItem(STORAGE_POS_TOP);
    if (left && top) {
      el.style.left  = left;
      el.style.top   = top;
      el.style.right = 'auto';
    }
  }

  // ── Size persistence ──────────────────────────────────────────────────────
  function _saveSize(el) {
    localStorage.setItem(STORAGE_WIDTH,  el.style.width);
    localStorage.setItem(STORAGE_HEIGHT, el.style.height);
  }

  function _restoreSize(el) {
    const w = localStorage.getItem(STORAGE_WIDTH);
    const h = localStorage.getItem(STORAGE_HEIGHT);
    if (w) el.style.width  = w;
    if (h) el.style.height = h;
  }

  // ── Body height sync ──────────────────────────────────────────────────────
  function _syncBodyHeight(el) {
    const header = el.querySelector('.bi-header');
    const footer = el.querySelector('.bi-footer');
    const body   = el.querySelector('#bi-body');
    if (!header || !footer || !body) return;
    const available = el.clientHeight - header.offsetHeight - footer.offsetHeight;
    body.style.maxHeight = Math.max(60, available) + 'px';
  }

  // ── Resize ────────────────────────────────────────────────────────────────
  function _makeResizable(el, grip) {
    grip.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const startW = el.offsetWidth, startH = el.offsetHeight;

      const onMove = ev => {
        el.style.width  = Math.min(PANEL_MAX_WIDTH,  Math.max(PANEL_MIN_WIDTH,  startW + ev.clientX - startX)) + 'px';
        el.style.height = Math.min(window.innerHeight - 20, Math.max(PANEL_MIN_HEIGHT, startH + ev.clientY - startY)) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        _saveSize(el);
        _syncBodyHeight(el);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
    });
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  function _makeDraggable(el, handle) {
    let ox = 0, oy = 0;
    handle.style.cursor = 'grab';
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('.bi-btn-icon')) return;
      e.preventDefault();
      handle.style.cursor = 'grabbing';
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      const onMove = ev => {
        el.style.left  = Math.max(0, ev.clientX - ox) + 'px';
        el.style.top   = Math.max(0, ev.clientY - oy) + 'px';
        el.style.right = 'auto';
      };
      const onUp = () => {
        handle.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        _savePosition(el);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
    });
  }

  // ── MutationObserver ──────────────────────────────────────────────────────
  const _observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (
          node.matches('[data-qa-role="encounters-user"]') ||
          node.querySelector('[data-qa-role="encounters-user"]')
        ) {
          requestAnimationFrame(renderPanel);
          return;
        }
      }
    }
  });

  // ── Version / icon update ─────────────────────────────────────────────────
  // version-check.js runs in ISOLATED world (has chrome.runtime + bypasses CSP)
  // and posts { type, local, remote, iconUrl } once the fetch resolves.
  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.type !== '__beespy_version__') return;
    const { local, remote, iconUrl } = e.data;
    _log('version received: local =', local, 'remote =', remote);

    if (iconUrl) {
      const placeholder = document.getElementById('bi-logo-icon');
      if (placeholder) {
        const img = Object.assign(document.createElement('img'), {
          className: 'bi-ext-icon', src: iconUrl, width: 18, height: 18, alt: '',
        });
        placeholder.replaceWith(img);
      }
    }

    if (remote && _isNewerVersion(remote, local)) {
      _log('update available:', local, '→', remote);
      const badge = document.getElementById('bi-update-badge');
      if (badge) {
        badge.hidden      = false;
        badge.title       = `Update available: v${local} → v${remote}`;
        badge.textContent = `↑ v${remote}`;
      } else {
        _warn('#bi-update-badge not found in DOM');
      }
    } else if (remote) {
      _log('up to date');
    }
  });

  function _isNewerVersion(remote, local) {
    const parse = v => v.split('.').map(Number);
    const [rMaj, rMin, rPat] = parse(remote);
    const [lMaj, lMin, lPat] = parse(local);
    if (rMaj !== lMaj) return rMaj > lMaj;
    if (rMin !== lMin) return rMin > lMin;
    return rPat > lPat;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _start() {
    if (document.body) {
      _observer.observe(document.body, { childList: true, subtree: true });
      window.__beeSpy = { store, order, orderedProfiles };
      getOrCreatePanel();
      _log('Ready ✓');
    } else {
      document.addEventListener('DOMContentLoaded', _start, { once: true });
    }
  }

  _start();

})();

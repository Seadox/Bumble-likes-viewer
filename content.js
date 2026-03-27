/**
 * BeeSpy — content script
 * Runs in MAIN world (see manifest.json)
 *
 * ── What this does ────────────────────────────────────────────────────────
 *  1. Wraps XMLHttpRequest (the actual Bumble RPC transport) to intercept
 *     both incoming encounters data and outgoing votes.
 *  2. Renders a floating panel showing the full profile queue with all
 *     available lifestyle data. has_user_voted is shown for each profile.
 *  3. Persists dark/light mode and font-size preference in localStorage.
 *
 * ── Transport layer ───────────────────────────────────────────────────────
 *  All mwebapi.phtml traffic uses XHR (vendor module 7053797886), NOT fetch.
 *  Outgoing body format (message_type 80 = vote):
 *    { "$gpb": "badoo.bma.BadooMessage", "body": [{
 *        "message_type": 80,
 *        "server_encounters_vote": { "person_id", "vote", "vote_source", "game_mode" }
 *    }]}
 *  vote values: 2 = YES · 3 = NO · 7 = SUPERSWIPE
 *
 */

(function () {
  'use strict';

  // Only activate on regional subdomains e.g. fr1.bumble.com, not www.bumble.com
  if (!/^[^.]+\.bumble\.com$/.test(window.location.hostname)) return;

  // ── Config ────────────────────────────────────────────────────────────────
  const PANEL_ID       = 'bi-panel';
  const STORAGE_THEME  = 'bi-theme';    // 'light' | 'dark'
  const STORAGE_FONT   = 'bi-fontsize'; // number, default 12

  const FONT_MIN = 9;
  const FONT_MAX = 18;
  const FONT_DEFAULT = 12;

  // ── State ─────────────────────────────────────────────────────────────────
  const store = new Map();   // userId → profile object
  const order = [];          // userId[] preserving server queue order
  let theme    = localStorage.getItem(STORAGE_THEME) || 'light';
  let fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN,
                   Number(localStorage.getItem(STORAGE_FONT)) || FONT_DEFAULT));

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
      // Track myVote only — hasUserVoted is server-driven, not set from outgoing vote
      if (p) { p.myVote = v.vote; }
      // Remove from visible queue immediately after any vote (like / pass / super)
      const idx = order.indexOf(v.person_id);
      if (idx !== -1) order.splice(idx, 1);
      renderPanel();
    } catch (_) {}
  }

  function _interceptIncoming(res) {
    const results = res?.body?.[0]?.client_encounters?.results;
    if (!Array.isArray(results)) return;
    // Clear queue on every fresh server response, then repopulate
    store.clear();
    order.length = 0;
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
    (u.profile_fields || []).forEach(pf => { f[pf.id] = pf.display_value || ''; });

    const profile = {
      userId:      u.user_id,
      name:        u.name || '?',
      age:         u.age  || '',
      verified:    u.verification_status === 1,
      hasUserVoted,
      myVote,
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
      extras:      (u.profile_fields || [])
                     .filter(pf => !KNOWN_FIELDS.has(pf.id) && pf.display_value)
                     .map(pf => ({ q: pf.name, a: pf.display_value })),
    };

    store.set(u.user_id, profile);
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
    if (!value) return '';
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

  // ── Card builder ──────────────────────────────────────────────────────────
  function buildCard(p, i) {
    const isFirst = i === 0;
    const imgUrl  = p.firstPhoto
      ? 'https:' + p.firstPhoto.replace('__size__', '120x120')
      : null;

    const [mvCls, mvTxt] = myVoteBadge(p.myVote);
    const hasVotedCls    = p.hasUserVoted ? 'bi-badge--voted'     : 'bi-badge--not-voted';
    const hasVotedTxt    = p.hasUserVoted ? '✓ Voted'             : '○ Not voted';
    const hasVotedBadge  = `<span class="bi-badge ${hasVotedCls}">${hasVotedTxt}</span>`;

    return `<div class="bi-card ${isFirst ? 'bi-card--active' : ''}" data-uid="${esc(p.userId)}">

      <div class="bi-card-header" role="button" tabindex="0" aria-expanded="false">
        <div class="bi-avatar-wrap">
          ${imgUrl
            ? `<img class="bi-avatar" src="${imgUrl}" alt="${esc(p.name)}" loading="lazy">`
            : `<div class="bi-avatar bi-avatar--placeholder">${i + 1}</div>`}
          ${isFirst ? '<span class="bi-dot"></span>' : ''}
        </div>

        <div class="bi-card-info">
          <div class="bi-card-name">
            ${esc(p.name)}<span class="bi-age">, ${p.age}</span>
            ${p.verified ? '<span class="bi-verified">✓</span>' : ''}
          </div>
          <div class="bi-badges">
            <span class="bi-badge ${mvCls}">${mvTxt}</span>
            ${hasVotedBadge}
          </div>
        </div>

        <svg class="bi-chevron" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>

      <div class="bi-card-body" hidden>
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
          ${p.extras.map(e => row('💬', e.q, e.a)).join('')}
        </div>
        ${p.about ? `<p class="bi-about">${esc(p.about)}</p>` : ''}
      </div>

    </div>`;
  }

  // ── Panel HTML ────────────────────────────────────────────────────────────
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

  // ── Font size helper ──────────────────────────────────────────────────────
  // Sets font-size as a CSS custom property on the panel so all em-based
  // children scale with it automatically.
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
      panel.innerHTML = `
        <header class="bi-header">
          <span class="bi-logo">
            <svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="9" cy="9" r="8" stroke="currentColor" stroke-width="1.4"/>
              <path d="M6 9.5l2 2 4-4" stroke="currentColor" stroke-width="1.4"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            BeeSpy
          </span>
          <div class="bi-header-actions">
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
        <div class="bi-body" id="bi-body"></div>
        <footer class="bi-footer" id="bi-footer">
          <span class="bi-credit">Created by Seadox</span>
        </footer>`;

      document.body.appendChild(panel);
      _applyFontSize(panel);
      _attachPanelEvents(panel);
      _makeDraggable(panel, panel.querySelector('.bi-header'));
    }
    return panel;
  }

  function _attachPanelEvents(panel) {
    // Collapse / expand
    panel.querySelector('#bi-collapse').addEventListener('click', e => {
      e.stopPropagation();
      const collapsed = panel.classList.toggle('bi--collapsed');
      panel.querySelector('#bi-collapse').setAttribute('aria-label',
        collapsed ? 'Expand panel' : 'Collapse panel');
      panel.querySelector('#bi-collapse svg path').setAttribute('d',
        collapsed ? 'M5 10h10M10 5v10' : 'M5 10h10');
    });

    // Font size — decrease
    panel.querySelector('#bi-font-dec').addEventListener('click', e => {
      e.stopPropagation();
      if (fontSize <= FONT_MIN) return;
      fontSize -= 1;
      _applyFontSize(panel);
      localStorage.setItem(STORAGE_FONT, fontSize);
    });

    // Font size — increase
    panel.querySelector('#bi-font-inc').addEventListener('click', e => {
      e.stopPropagation();
      if (fontSize >= FONT_MAX) return;
      fontSize += 1;
      _applyFontSize(panel);
      localStorage.setItem(STORAGE_FONT, fontSize);
    });

    // Theme toggle
    panel.querySelector('#bi-theme-toggle').addEventListener('click', e => {
      e.stopPropagation();
      theme = theme === 'light' ? 'dark' : 'light';
      panel.setAttribute('data-theme', theme);
      localStorage.setItem(STORAGE_THEME, theme);
    });

    // Card expand/collapse — only one open at a time, event delegation
    panel.querySelector('#bi-body').addEventListener('click', e => {
      const header = e.target.closest('.bi-card-header');
      if (!header) return;
      const card   = header.closest('.bi-card');
      const body   = card.querySelector('.bi-card-body');
      const isOpen = !body.hidden;

      // Close all other open cards
      panel.querySelectorAll('.bi-card--open').forEach(other => {
        if (other === card) return;
        other.classList.remove('bi-card--open');
        other.querySelector('.bi-card-body').hidden = true;
        other.querySelector('.bi-card-header').setAttribute('aria-expanded', 'false');
      });

      // Toggle clicked card
      body.hidden = isOpen;
      header.setAttribute('aria-expanded', String(!isOpen));
      card.classList.toggle('bi-card--open', !isOpen);
    });

    // Keyboard support
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

    // Remember the single currently open card
    const openUid = body.querySelector('.bi-card--open')?.dataset.uid ?? null;

    body.innerHTML = buildPanelHTML(profiles);

    // Re-open at most one card: the previously open one, or the first card
    const toOpen = openUid
      ? (body.querySelector(`.bi-card[data-uid="${openUid}"]`) ?? body.querySelector('.bi-card'))
      : body.querySelector('.bi-card');

    if (toOpen) {
      toOpen.classList.add('bi-card--open');
      const cardBody = toOpen.querySelector('.bi-card-body');
      const hdr      = toOpen.querySelector('.bi-card-header');
      if (cardBody) cardBody.hidden = false;
      if (hdr)      hdr.setAttribute('aria-expanded', 'true');
    }
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

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _start() {
    if (document.body) {
      _observer.observe(document.body, { childList: true, subtree: true });
      window.__beeSpy = { store, order, orderedProfiles };
      console.debug('[BeeSpy] Ready ✓');
    } else {
      document.addEventListener('DOMContentLoaded', _start, { once: true });
    }
  }

  _start();

})();
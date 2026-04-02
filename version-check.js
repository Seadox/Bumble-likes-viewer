/**
 * BeeSpy — version checker (ISOLATED world)
 *
 * Runs in isolated world so it has access to chrome.runtime and can fetch
 * from GitHub without being blocked by Bumble's CSP. Posts the result to
 * the MAIN world via postMessage so content.js can show the update badge.
 */
(function () {
  const _log  = (...a) => console.log('[BeeSpy]', ...a);
  const _warn = (...a) => console.warn('[BeeSpy]', ...a);

  const local   = chrome.runtime.getManifest().version;
  const iconUrl = chrome.runtime.getURL('icons/icon16.png');
  _log('version-check: local =', local);

  fetch('https://raw.githubusercontent.com/seadox/beespy/main/manifest.json', { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      const remote = data?.version;
      _log('version-check: remote =', remote);
      window.postMessage({ type: '__beespy_version__', local, remote, iconUrl }, '*');
    })
    .catch(err => {
      _warn('version-check: fetch failed —', err.message);
    });
})();

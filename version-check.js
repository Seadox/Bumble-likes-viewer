/**
 * BeeSpy — version checker (ISOLATED world)
 *
 * Runs in isolated world so it has access to chrome.runtime and can fetch
 * from GitHub without being blocked by Bumble's CSP. Posts the result to
 * the MAIN world via postMessage so content.js can show the update badge.
 */
(function () {
  const local = chrome.runtime.getManifest().version;
  console.log('[BeeSpy] version-check: local =', local);

  fetch('https://raw.githubusercontent.com/seadox/beespy/main/manifest.json', { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      const remote = data?.version;
      console.log('[BeeSpy] version-check: remote =', remote);
      window.postMessage({ type: '__beespy_version__', local, remote }, '*');
    })
    .catch(err => {
      console.warn('[BeeSpy] version-check: fetch failed —', err.message);
    });
})();

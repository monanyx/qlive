/*
 * Runs synchronously in <head> before first paint (classic script, not a
 * module): applies the saved/OS theme to avoid a flash of the wrong theme,
 * and explains why nothing works when the site is opened from file://
 * (browsers refuse to load ES modules from file URLs).
 */
(function () {
  var root = document.documentElement;
  var theme = null;
  try {
    theme = localStorage.getItem('qlive.theme');
  } catch (e) {
    /* storage unavailable */
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  root.setAttribute('data-theme', theme);

  if (location.protocol === 'file:') {
    document.addEventListener('DOMContentLoaded', function () {
      var banner = document.createElement('div');
      banner.className = 'proto-banner';
      banner.setAttribute('role', 'alert');
      var strong = document.createElement('strong');
      strong.textContent = 'Open QuantumLive through a web server. ';
      banner.appendChild(strong);
      banner.appendChild(
        document.createTextNode('Browsers block JavaScript modules on file:// URLs. From the project folder run '),
      );
      var code = document.createElement('code');
      code.textContent = 'npm start';
      banner.appendChild(code);
      banner.appendChild(document.createTextNode(' (or python3 -m http.server) and visit http://localhost:8080.'));
      document.body.appendChild(banner);
    });
  }
})();

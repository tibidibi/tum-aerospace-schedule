// Your colour seed and theme, before first paint (app.js changes it from Settings). A file, not inline, so the CSP can forbid inline scripts
try { var seed = localStorage.getItem('fd_md_seed'); if (seed) document.documentElement.style.setProperty('--seed', seed); } catch (e) {}

var THEME_KEY = 'fd_theme';
var systemDark = matchMedia('(prefers-color-scheme: dark)');
var themeOverride = null;
try { themeOverride = localStorage.getItem(THEME_KEY); } catch (e) {}
function applyTheme() {
  var theme = themeOverride || (systemDark.matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#1D2024' : '#EDEDF4';
}
applyTheme();

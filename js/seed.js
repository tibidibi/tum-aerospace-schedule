// Your colour seed, before first paint (app.js changes it from Settings). A file, not inline, so the CSP can forbid inline scripts
try { var seed = localStorage.getItem('fd_md_seed'); if (seed) document.documentElement.style.setProperty('--seed', seed); } catch (e) {}

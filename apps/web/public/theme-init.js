// Applies the saved theme, or the system's, before React starts (same rule as src/theme.tsx).
// Storage can be blocked inside Whop's iframe: then the system theme applies.
(function () {
  var preference = 'system';
  try {
    preference = localStorage.getItem('stayput.theme') || 'system';
  } catch {
    // Keep the system theme.
  }
  var dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();

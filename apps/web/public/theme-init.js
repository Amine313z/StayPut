// Applies the saved theme, else dark (StayPut's own), before React starts (same rule as
// src/theme.tsx). Storage can be blocked inside Whop's iframe: then dark applies.
(function () {
  var preference = 'dark';
  try {
    preference = localStorage.getItem('stayput.theme') || 'dark';
  } catch {
    // Keep the dark theme.
  }
  var dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();

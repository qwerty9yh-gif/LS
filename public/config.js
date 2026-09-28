// Backend API base URL used by app.js.
// - Empty string ('') = same origin (the backend serves the frontend itself).
// - A full URL = the PWA is hosted elsewhere (e.g. GitHub Pages) and calls the
//   backend cross-origin; the backend must whitelist that origin via the
//   ALLOWED_ORIGINS environment variable.
window.LAUNDRY_API_BASE = 'https://ls-4tj4.onrender.com';
window.LAUNDRY_SUPABASE_URL = '';
window.LAUNDRY_SUPABASE_ANON_KEY = '';

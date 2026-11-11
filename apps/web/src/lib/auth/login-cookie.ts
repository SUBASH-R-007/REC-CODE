/**
 * Carries the roll number / email a student typed across a failed sign-in
 * (POST /api/auth/login → 303 → /login), so the form comes back filled in
 * without putting it in the URL. httpOnly, /login only, 60 seconds, and
 * cleared by the page as soon as it is read — lab machines are shared.
 */
export const LOGIN_IDENTIFIER_COOKIE = "recx_login_id";

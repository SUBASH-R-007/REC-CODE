import "server-only";
/** ?rev=N → a positive revision number, or null (absent or malformed). */
export function parseRev(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/** Route ids are cuids; anything else is a 404 without a query. */
export const ROUTE_ID = /^[A-Za-z0-9_-]{1,64}$/;

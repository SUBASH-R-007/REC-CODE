/** Unread counts above this show as "99+". */
export const MAX_UNREAD_SHOWN = 99;

/** The bell's accessible name: the count is spoken, never just a dot. */
export function unreadLabel(count: number): string {
  if (count <= 0) return "Notifications";
  return `Notifications, ${count > MAX_UNREAD_SHOWN ? `more than ${MAX_UNREAD_SHOWN}` : count} unread`;
}

/** The badge text: "7", "99+". */
export function unreadBadge(count: number): string {
  return count > MAX_UNREAD_SHOWN ? `${MAX_UNREAD_SHOWN}+` : String(count);
}

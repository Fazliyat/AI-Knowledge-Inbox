const SQLITE_UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

export function parseUtcTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(SQLITE_UTC_TIMESTAMP, "$1T$2Z");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value) {
  const date = parseUtcTimestamp(value);
  if (!date) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

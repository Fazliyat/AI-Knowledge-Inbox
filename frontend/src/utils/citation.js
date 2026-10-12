/**
 * Safely inspects whether bracket inner content is a citation marker.
 * Strictly checks that the marker starts with source/note keyword (word-bounded)
 * and has valid citation attributes (like id=...), preventing greedy or accidental matches.
 *
 * @param {string} bracketContent
 * @returns {boolean}
 */
export function isCitationMarker(bracketContent) {
  if (typeof bracketContent !== "string") return false;
  const trimmed = bracketContent.trim();
  if (/^\/(?:source|note)$/i.test(trimmed)) {
    return true;
  }
  const match = trimmed.match(/^(?:source|note)(?::|\b)\s*(.*)$/i);
  if (!match) {
    return false;
  }
  const remainder = match[1].replace(/\/$/, "").trim();
  if (remainder.length === 0) {
    return true;
  }
  if (/^:?\s*#?\d+$/i.test(remainder)) {
    return true;
  }
  if (/\bid\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,\]]+)/i.test(remainder)) {
    return true;
  }
  return /\b(?:title|type|url)\s*[:=]/i.test(remainder);
}

/**
 * Extracts metadata (id, title, type, url) from a citation marker's inner content.
 *
 * @param {string} inner
 * @returns {{ id: number|string|null, title: string|null, type: string|null, url: string|null }}
 */
export function extractCitationMetadata(inner) {
  const idMatch = inner.match(/\bid\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,\]]+))/i)
    || inner.match(/^(?:source|note)(?::|\b)\s*:?\s*#?(\d+)/i);
  const titleMatch = inner.match(/\btitle\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,\]]+))/i);
  const typeMatch = inner.match(/\btype\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,\]]+))/i);
  const urlMatch = inner.match(/\burl\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,\]]+))/i);

  const idRaw = idMatch ? (idMatch[1] ?? idMatch[2] ?? idMatch[3]) : null;
  const idNum = idRaw !== null ? Number(idRaw) : null;
  const id = idNum !== null && !Number.isNaN(idNum) ? idNum : idRaw;

  return {
    id,
    title: titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? titleMatch[3]) : null,
    type: typeMatch ? (typeMatch[1] ?? typeMatch[2] ?? typeMatch[3]) : null,
    url: urlMatch ? (urlMatch[1] ?? urlMatch[2] ?? urlMatch[3]) : null,
  };
}

/**
 * Strips raw citation markers (e.g. [SOURCE id=98 title="Note"]) from displayed text
 * without removing legitimate bracketed content or corrupting surrounding punctuation.
 *
 * @param {string} text
 * @returns {string} Cleaned text
 */
export function cleanCitationMarkers(text) {
  if (!text || typeof text !== "string") return text || "";

  let cleaned = text;

  // Clean explicit parenthetical references e.g. "(Source #98)", "(Source 98)", "(Note #98)"
  cleaned = cleaned.replace(/\(\s*(?:see\s+)?(?:source|note|citation)s?\s*#?\d+\s*\)/gi, "");

  const bracketRegex = /\[([^\]]+)\]/g;
  let match;
  const markerRanges = [];

  while ((match = bracketRegex.exec(cleaned)) !== null) {
    if (isCitationMarker(match[1])) {
      markerRanges.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  if (markerRanges.length > 0) {
    for (let i = markerRanges.length - 1; i >= 0; i--) {
      const { start, end } = markerRanges[i];
      cleaned = cleaned.slice(0, start) + cleaned.slice(end);
    }
  }

  if (cleaned === text) {
    return text;
  }

  // 1. Remove dangling connector words before punctuation (e.g. "storage and ." -> "storage.")
  cleaned = cleaned.replace(/\s+(?:and|&|or)\s*([.,;:!?])/gi, "$1");

  // 2. Clean up empty parentheses left after removing parenthetical citations
  cleaned = cleaned.replace(/\(\s*(?:see|source|citation)?\s*\)/gi, "");

  // 3. Clean up dangling commas or multiple punctuation marks left by removed markers
  cleaned = cleaned.replace(/,\s*(,)+/g, ",");
  cleaned = cleaned.replace(/,\s*\./g, ".");
  cleaned = cleaned.replace(/,\s*;/g, ";");
  cleaned = cleaned.replace(/,\s*:/g, ":");

  // 4. Remove space before punctuation: "word ." -> "word."
  cleaned = cleaned.replace(/\s+([.,;:!?])/g, "$1");

  // 5. Collapse multiple horizontal whitespace sequences (preserving newlines)
  cleaned = cleaned.replace(/[^\S\r\n]{2,}/g, " ");

  // 6. Clean up line boundaries
  cleaned = cleaned
    .split("\n")
    .map((line) => {
      let l = line.trimEnd();
      l = l.replace(/^\s*,\s*/, "");
      return l;
    })
    .filter((line, index, arr) => {
      if (index === arr.length - 1 && /^(?:sources|citations|references):?\s*$/i.test(line.trim())) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();

  return cleaned;
}

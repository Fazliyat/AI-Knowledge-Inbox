/**
 * Service for chunking text content from notes, documents, and extracted web content.
 */

export const DEFAULT_CHUNK_SIZE = 800; // target chunk character length
export const DEFAULT_CHUNK_OVERLAP = 120; // chunk overlap character length

/**
 * Splits text into meaningful chunks respecting sentence and paragraph boundaries
 * with an appropriate chunk size and small overlap.
 *
 * @param {string} text - The input text to chunk
 * @param {object} [options]
 * @param {number} [options.chunkSize=800] - Target characters per chunk
 * @param {number} [options.chunkOverlap=120] - Overlap characters between consecutive chunks
 * @returns {string[]} Array of chunk text strings
 */
export function splitTextIntoChunks(text, options = {}) {
    if (!text || typeof text !== "string") return [];

    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];

    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

    if (normalized.length <= chunkSize) {
        return [normalized];
    }

    // Split on paragraph boundaries first
    const paragraphs = normalized.split(/\n{2,}/);
    const chunks = [];
    let currentChunk = "";

    for (const paragraph of paragraphs) {
        const trimmedPara = paragraph.trim();
        if (!trimmedPara) continue;

        if (trimmedPara.length > chunkSize) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
            }
            const subChunks = splitLongParagraph(trimmedPara, chunkSize, chunkOverlap);
            for (const subChunk of subChunks) {
                if (subChunk.trim()) {
                    chunks.push(subChunk.trim());
                }
            }
        } else if (!currentChunk) {
            currentChunk = trimmedPara;
        } else if (currentChunk.length + 2 + trimmedPara.length <= chunkSize) {
            currentChunk += `\n\n${trimmedPara}`;
        } else {
            chunks.push(currentChunk.trim());
            const overlapText = getOverlapText(currentChunk, chunkOverlap);
            currentChunk = overlapText ? `${overlapText}\n\n${trimmedPara}` : trimmedPara;
        }
    }

    if (currentChunk && currentChunk.trim()) {
        const trimmed = currentChunk.trim();
        if (chunks.length === 0 || chunks[chunks.length - 1] !== trimmed) {
            chunks.push(trimmed);
        }
    }

    return chunks.filter((c) => c.length > 0);
}

function getOverlapText(text, overlapSize) {
    if (!overlapSize || text.length <= overlapSize) return "";
    const slice = text.slice(-overlapSize);
    // Find first whitespace to avoid breaking words
    const spaceIndex = slice.indexOf(" ");
    return spaceIndex !== -1 ? slice.slice(spaceIndex + 1).trim() : slice.trim();
}

function splitLongParagraph(paragraph, chunkSize, chunkOverlap) {
    // Split by sentence endings (. ! ? \n)
    const sentences = paragraph.match(/[^.!?\n]+(?:[.!?\n]+|$)/g) || [paragraph];
    const chunks = [];
    let current = "";

    for (const sentence of sentences) {
        const trimmedSentence = sentence.trim();
        if (!trimmedSentence) continue;

        if (!current) {
            current = trimmedSentence;
        } else if (current.length + 1 + trimmedSentence.length <= chunkSize) {
            current += ` ${trimmedSentence}`;
        } else {
            chunks.push(current.trim());
            const overlap = getOverlapText(current, chunkOverlap);
            current = overlap ? `${overlap} ${trimmedSentence}` : trimmedSentence;
        }
    }

    if (current && current.trim()) {
        chunks.push(current.trim());
    }

    // Fallback: if sentences are still longer than chunkSize, split on hard boundary
    const result = [];
    for (const chunk of chunks) {
        if (chunk.length <= chunkSize) {
            result.push(chunk);
        } else {
            let start = 0;
            while (start < chunk.length) {
                const end = Math.min(start + chunkSize, chunk.length);
                result.push(chunk.slice(start, end).trim());
                start += chunkSize - chunkOverlap;
            }
        }
    }

    return result;
}

/**
 * Creates chunk objects with source item identity and metadata preserved.
 *
 * @param {object} item - Knowledge item { id, title, content, source_type, source_url }
 * @param {object} [options] - Chunking options
 * @returns {Array<{ itemId: number, chunkIndex: number, content: string, metadata: object }>}
 */
export function chunkKnowledgeItem(item, options = {}) {
    if (!item || !item.id) return [];

    const rawContent = String(item.content || item.extracted_text || item.source_url || "").trim();
    if (!rawContent) return [];

    const chunks = splitTextIntoChunks(rawContent, options);

    return chunks.map((chunkText, index) => ({
        itemId: Number(item.id),
        chunkIndex: index,
        content: chunkText,
        metadata: {
            itemId: Number(item.id),
            title: String(item.title || ""),
            sourceType: item.source_type || item.sourceType || "note",
            sourceUrl: item.source_url || item.sourceUrl || null,
        },
    }));
}

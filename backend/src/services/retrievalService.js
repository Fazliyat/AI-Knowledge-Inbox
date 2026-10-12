import { getAllActiveChunks, getItemsNeedingChunking, saveItemChunks } from "../repositories/chunkRepository.js";
import { findRagCandidates } from "../repositories/itemRepository.js";
import { chunkKnowledgeItem } from "./chunkingService.js";
import {
    LOCAL_EMBEDDING_DIMENSIONS,
    cosineSimilarity,
    generateEmbedding,
    generateEmbeddings,
    generateLocalEmbedding,
} from "./embeddingService.js";

export const DEFAULT_SIMILARITY_THRESHOLD = 0.55;
export const DEFAULT_RETRIEVAL_LIMIT = 5;

/**
 * Indexes a single knowledge item into chunks with embeddings.
 *
 * @param {object} item - Knowledge item
 * @returns {Promise<number>} Number of chunks indexed
 */
export async function indexKnowledgeItem(item) {
    if (!item || !item.id) return 0;

    const chunks = chunkKnowledgeItem(item);
    if (chunks.length === 0) return 0;

    const chunkTexts = chunks.map((c) => `${item.title ? `${item.title}\n` : ""}${c.content}`);
    const embeddings = await generateEmbeddings(chunkTexts);

    const chunksWithEmbeddings = chunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddings[index] || null,
    }));

    return saveItemChunks(item.id, chunksWithEmbeddings);
}

/**
 * Indexes all active items that currently do not have chunks.
 * Safe to call at server startup to ensure existing data is indexed.
 *
 * @returns {Promise<number>} Total items indexed
 */
export async function indexAllUnindexedItems() {
    const items = getItemsNeedingChunking();
    if (items.length === 0) return 0;

    let indexedCount = 0;
    for (const item of items) {
        try {
            await indexKnowledgeItem(item);
            indexedCount += 1;
        } catch (err) {
            console.error(`Failed to index item #${item.id}:`, err?.message || err);
        }
    }
    return indexedCount;
}

/**
 * Extracts normalized query terms for keyword boosting/fallback.
 *
 * @param {string} query
 * @returns {string[]}
 */
function extractQueryTerms(query) {
    const STOP_WORDS = new Set([
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
        "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "please",
        "show", "summarize", "tell", "that", "the", "this", "to", "was", "what",
        "when", "where", "which", "who", "why", "with", "you", "your",
    ]);

    return [...new Set(
        String(query || "").toLowerCase()
            .match(/[\p{L}\p{N}]{2,}/gu)
            ?.filter((term) => !STOP_WORDS.has(term)) ?? []
    )];
}

/**
 * Normalizes content for duplicate detection by trimming and collapsing whitespace sequences.
 *
 * @param {string} content
 * @returns {string}
 */
export function normalizeContentFingerprint(content) {
    if (typeof content !== "string") return "";
    return content.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Retrieves the most relevant chunks using semantic vector similarity,
 * with hybrid keyword boosting and graceful fallback.
 *
 * @param {string} query - The user's question or search query
 * @param {object} [options]
 * @param {number} [options.limit=5] - Maximum number of chunks to return
 * @param {number} [options.minSimilarity=0.25] - Minimum cosine similarity score
 * @returns {Promise<Array<{ id: number, chunkId: number, title: string, type: string, url: string|null, content: string, score: number }>>}
 */
export async function retrieveRelevantChunks(query, options = {}) {
    const trimmedQuery = typeof query === "string" ? query.trim() : "";
    if (!trimmedQuery) return [];

    const limit = options.limit ?? DEFAULT_RETRIEVAL_LIMIT;
    const minSimilarity = options.minSimilarity ?? DEFAULT_SIMILARITY_THRESHOLD;

    const activeChunks = getAllActiveChunks();
    if (activeChunks.length === 0) {
        // Fallback to keyword search against items directly if chunks are not yet indexed
        return fallbackKeywordRetrieval(trimmedQuery, limit);
    }

    let queryEmbedding;
    try {
        queryEmbedding = await generateEmbedding(trimmedQuery);
    } catch {
        queryEmbedding = null;
    }

    const queryTerms = extractQueryTerms(trimmedQuery);

    let localQueryEmbedding = null;
    const scoredChunks = [];
    for (const chunk of activeChunks) {
        let similarity = 0;
        if (queryEmbedding && Array.isArray(chunk.embedding)) {
            if (chunk.embedding.length === queryEmbedding.length) {
                similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
            } else if (chunk.embedding.length === LOCAL_EMBEDDING_DIMENSIONS) {
                if (!localQueryEmbedding) localQueryEmbedding = generateLocalEmbedding(trimmedQuery);
                similarity = cosineSimilarity(localQueryEmbedding, chunk.embedding);
            }
        }

        // Keyword boost
        let termMatches = 0;
        if (queryTerms.length > 0) {
            const chunkText = `${chunk.metadata?.title || ""} ${chunk.content || ""}`.toLowerCase();
            for (const term of queryTerms) {
                if (chunkText.includes(term)) termMatches += 1;
            }
        }
        const keywordBoost = queryTerms.length > 0 ? (termMatches / queryTerms.length) * 0.2 : 0;
        const finalScore = similarity + keywordBoost;

        // When query embedding is present, enforce the semantic similarity threshold.
        // Keyword matches provide a ranking bonus for semantically relevant chunks.
        const meetsThreshold = queryEmbedding
            ? similarity >= minSimilarity
            : (similarity >= minSimilarity || termMatches > 0);

        if (meetsThreshold) {
            scoredChunks.push({
                id: chunk.itemId,
                chunkId: chunk.id,
                title: chunk.metadata?.title || "",
                type: chunk.metadata?.sourceType || "note",
                url: chunk.metadata?.sourceUrl || null,
                content: chunk.content,
                score: Number(finalScore.toFixed(4)),
            });
        }
    }

    if (scoredChunks.length === 0) {
        // Only fall back to keyword matching if query embedding was unavailable
        if (!queryEmbedding) {
            return fallbackKeywordRetrieval(trimmedQuery, limit);
        }
        return [];
    }

    // Sort descending by score, tie-breaking by higher ID (most recent item)
    scoredChunks.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        return b.id - a.id;
    });

    // Pick top unique knowledge items by score, deduplicating both identical item IDs
    // and duplicate content (normalized for whitespace and casing) across distinct items.
    const seenItemIds = new Set();
    const seenContentFingerprints = new Set();
    const uniqueChunks = [];

    for (const chunk of scoredChunks) {
        const fingerprint = normalizeContentFingerprint(chunk.content);
        if (fingerprint && seenContentFingerprints.has(fingerprint)) {
            continue;
        }

        if (!seenItemIds.has(chunk.id)) {
            seenItemIds.add(chunk.id);
            if (fingerprint) {
                seenContentFingerprints.add(fingerprint);
            }
            uniqueChunks.push(chunk);
            if (uniqueChunks.length >= limit) break;
        }
    }
    return uniqueChunks;
}

/**
 * Fallback keyword retrieval if semantic vector chunks are empty or below threshold.
 */
function fallbackKeywordRetrieval(query, limit = 5) {
    const terms = extractQueryTerms(query);
    if (terms.length === 0) return [];

    const candidates = findRagCandidates(terms);
    const scoredCandidates = candidates
        .map((item) => {
            const title = String(item.title || "");
            const content = String(item.content || item.source_url || "");
            const titleLower = title.toLowerCase();
            const contentLower = content.toLowerCase();

            let matches = 0;
            for (const term of terms) {
                if (titleLower.includes(term)) matches += 3;
                if (contentLower.includes(term)) matches += 1;
            }
            return {
                id: item.id,
                chunkId: null,
                title,
                type: item.source_type,
                url: item.source_url || null,
                content: content.slice(0, 2000),
                score: matches > 0 ? Number((matches / (terms.length * 4)).toFixed(4)) : 0,
            };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.id - a.id;
        });

    const seenItemIds = new Set();
    const seenContentFingerprints = new Set();
    const uniqueCandidates = [];

    for (const item of scoredCandidates) {
        const fingerprint = normalizeContentFingerprint(item.content);
        if (fingerprint && seenContentFingerprints.has(fingerprint)) {
            continue;
        }
        if (!seenItemIds.has(item.id)) {
            seenItemIds.add(item.id);
            if (fingerprint) seenContentFingerprints.add(fingerprint);
            uniqueCandidates.push(item);
            if (uniqueCandidates.length >= limit) break;
        }
    }
    return uniqueCandidates;
}

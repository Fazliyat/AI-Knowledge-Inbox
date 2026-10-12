import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Ensure environment is loaded if imported directly in tests or scripts
if (!process.env.GEMINI_API_KEY) {
    try {
        dotenv.config({
            path: fileURLToPath(new URL("../../.env", import.meta.url)),
            override: false,
        });
    } catch {}
}

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

/**
 * Checks whether the Gemini embedding provider is properly configured.
 *
 * @returns {{ configured: boolean, model: string, provider: string }}
 */
export function getEmbeddingConfig() {
    const apiKey = process.env.GEMINI_API_KEY?.trim() || "";
    const model = process.env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
    return {
        configured: Boolean(apiKey),
        model,
        provider: apiKey ? "gemini" : "local-fallback",
    };
}

/**
 * Computes cosine similarity between two numeric vectors.
 *
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} Cosine similarity in range [-1, 1], or 0 if dimensions mismatch/zero-vector
 */
export function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0;
    if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        const a = vecA[i];
        const b = vecB[i];
        dot += a * b;
        normA += a * a;
        normB += b * b;
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generates a deterministic unit-normalized pseudo-semantic embedding vector
 * from text. Used as an offline/test fallback when GEMINI_API_KEY is not configured.
 *
 * @param {string} text
 * @param {number} [dimensions=384]
 * @returns {number[]}
 */
export function generateLocalEmbedding(text, dimensions = LOCAL_EMBEDDING_DIMENSIONS) {
    const vector = new Array(dimensions).fill(0);
    if (!text || typeof text !== "string") return vector;

    const normalized = text.toLowerCase().trim();
    if (!normalized) return vector;

    // Word tokens
    const words = normalized.match(/[\p{L}\p{N}]{2,}/gu) || [];
    for (const word of words) {
        let hash = 5381;
        for (let i = 0; i < word.length; i++) {
            hash = ((hash << 5) + hash) + word.charCodeAt(i);
            hash = hash & hash;
        }
        const index = Math.abs(hash) % dimensions;
        vector[index] += 1.0;
    }

    // Character 3-grams for subword matching
    for (let i = 0; i <= normalized.length - 3; i++) {
        const trigram = normalized.slice(i, i + 3);
        let hash = 2166136261;
        for (let j = 0; j < 3; j++) {
            hash ^= trigram.charCodeAt(j);
            hash = Math.imul(hash, 16777619);
        }
        const index = Math.abs(hash) % dimensions;
        vector[index] += 0.5;
    }

    // Normalize to unit length
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
        norm += vector[i] * vector[i];
    }
    if (norm > 0) {
        const sqrtNorm = Math.sqrt(norm);
        for (let i = 0; i < dimensions; i++) {
            vector[i] = vector[i] / sqrtNorm;
        }
    }

    return vector;
}

/**
 * Generates an embedding for a single text using the configured Gemini provider,
 * or falls back to local deterministic embedding if API key is not present or API fails.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.requireGemini=false] - If true, throws error on Gemini failure instead of local fallback
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text, options = {}) {
    const results = await generateEmbeddings([text], options);
    return results[0] || [];
}

/**
 * Generates embeddings for an array of texts.
 * Uses batching when supported by Gemini API.
 *
 * @param {string[]} texts
 * @param {object} [options]
 * @param {boolean} [options.requireGemini=false]
 * @returns {Promise<number[][]>}
 */
export async function generateEmbeddings(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
        if (options.requireGemini) {
            const error = new Error("GEMINI_API_KEY is not configured in backend/.env.");
            error.statusCode = 503;
            throw error;
        }
        return texts.map((t) => generateLocalEmbedding(t));
    }

    const model = process.env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
    const ai = new GoogleGenAI({ apiKey });

    // Process in batches of 16 to stay well within request payload limits
    const BATCH_SIZE = 16;
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE).map((t) => (t && t.trim() ? t.trim() : "empty"));
        try {
            const response = await ai.models.embedContent({
                model,
                contents: batch.length === 1 ? batch[0] : batch,
            });

            const returnedList = response.embeddings || (response.embedding ? [response.embedding] : []);
            for (let j = 0; j < batch.length; j++) {
                const vector = returnedList[j]?.values || (batch.length === 1 ? returnedList[0]?.values : null);
                if (Array.isArray(vector) && vector.length > 0) {
                    allEmbeddings.push(vector);
                } else {
                    allEmbeddings.push(generateLocalEmbedding(batch[j]));
                }
            }
        } catch (error) {
            if (options.requireGemini) {
                throw error;
            }
            // Fall back to local embeddings for this batch if remote API call fails
            for (const text of batch) {
                allEmbeddings.push(generateLocalEmbedding(text));
            }
        }
    }

    return allEmbeddings;
}

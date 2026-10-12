import { GoogleGenAI, Type } from "@google/genai";
import { load } from "cheerio";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { findRagCandidates, getFilteredItems } from "../repositories/itemRepository.js";
import { retrieveRelevantChunks } from "./retrievalService.js";

if (!process.env.GEMINI_API_KEY) {
    try {
        dotenv.config({
            path: fileURLToPath(new URL("../../.env", import.meta.url)),
            override: false,
        });
    } catch {}
}

const MAX_CONTEXT_CHARS = 18_000;
const MAX_SOURCE_CHARS = 4_000;
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const FALLBACK_MODELS = [
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-flash-latest",
];
const STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
    "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "please",
    "show", "summarize", "tell", "that", "the", "this", "to", "was", "what",
    "when", "where", "which", "who", "why", "with", "you", "your",
]);

export function getQueryTerms(query) {
    return [...new Set(
        query.toLowerCase()
            .match(/[\p{L}\p{N}]{2,}/gu)
            ?.filter((term) => !STOP_WORDS.has(term)) ?? []
    )];
}

export function retrieveRelevantKnowledge(items, query, limit = 5) {
    const terms = getQueryTerms(query);
    if (terms.length === 0) return [];

    return items
        .filter((item) => ["note", "document", "url"].includes(item.source_type))
        .map((item) => {
            const title = String(item.title || "");
            const content = String(item.content || item.source_url || "").slice(0, MAX_SOURCE_CHARS);
            const sourceUrl = String(item.source_url || "");
            const titleText = title.toLowerCase();
            const contentText = content.toLowerCase();
            const urlText = sourceUrl.toLowerCase();
            const score = terms.reduce((sum, term) => {
                const titleMatches = titleText.includes(term) ? 3 : 0;
                const contentMatches = contentText.includes(term) ? 1 : 0;
                const urlMatches = urlText.includes(term) ? 1 : 0;
                return sum + titleMatches + contentMatches + urlMatches;
            }, 0);
            return { item, score, title, content };
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(({ item, title, content }) => ({
            id: item.id,
            title,
            type: item.source_type,
            url: item.source_url || null,
            content,
        }));
}

export function retrieveDatabaseKnowledge(query, limit = 5) {
    return retrieveRelevantKnowledge(findRagCandidates(getQueryTerms(query)), query, limit);
}

function createGeminiError(cause) {
    if (cause.statusCode) return cause;
    const classified = classifyGeminiError(cause);
    const error = new Error(classified.message);
    error.statusCode = classified.statusCode;
    return error;
}

async function generateContent(contents, config = {}) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
        const error = new Error("AI is not configured. Add GEMINI_API_KEY to backend/.env and restart the backend.");
        error.statusCode = 503;
        throw error;
    }

    const preferredModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    const candidateModels = [...new Set([preferredModel, ...FALLBACK_MODELS])];
    const ai = new GoogleGenAI({ apiKey });

    let lastError = null;
    for (const model of candidateModels) {
        try {
            const response = await ai.models.generateContent({
                model,
                contents,
                config,
            });
            return { response, model };
        } catch (cause) {
            lastError = cause;
            const status = Number(cause?.status ?? cause?.statusCode ?? cause?.response?.status);
            // If model is overloaded, unavailable, or not found, try next candidate
            if (status === 503 || status === 404 || status === 429) {
                continue;
            }
            throw createGeminiError(cause);
        }
    }
    throw createGeminiError(lastError);
}

function extractJson(text) {
    const cleaned = text.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    return JSON.parse(cleaned);
}

function normalizeHttpUrl(value) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
        url.hash = "";
        return url.href;
    } catch {
        return null;
    }
}

export function extractGroundedWebLinks(response, topic) {
    const groundedWeb = (response.candidates || [])
        .flatMap((candidate) => candidate.groundingMetadata?.groundingChunks || [])
        .map((chunk) => chunk.web)
        .filter((web) => web && typeof web.uri === "string");
    const groundedByUrl = new Map();
    for (const result of groundedWeb) {
        const url = normalizeHttpUrl(result.uri);
        if (url && !groundedByUrl.has(url)) {
            groundedByUrl.set(url, {
                url,
                title: typeof result.title === "string" && result.title.trim()
                    ? result.title.trim()
                    : new URL(url).hostname,
                domain: new URL(url).hostname,
            });
        }
    }

    let descriptions = [];
    try {
        const parsed = extractJson(response.text || "");
        descriptions = Array.isArray(parsed.results) ? parsed.results : [];
    } catch {
        descriptions = [];
    }
    const descriptionsByUrl = new Map(descriptions
        .filter((entry) => entry && typeof entry.url === "string" && typeof entry.description === "string")
        .map((entry) => [normalizeHttpUrl(entry.url), entry.description.trim()])
        .filter(([url, description]) => url && description));

    return [...groundedByUrl.values()].map((source) => ({
        ...source,
        kind: "web-link",
        description: descriptionsByUrl.get(source.url) ||
            `Google Search verified this page as a result for "${topic}".`,
    }));
}

export function retrieveSavedLinks(topic, limit = 10) {
    return retrieveDatabaseKnowledge(topic, 50)
        .filter((source) => source.type === "url" && normalizeHttpUrl(source.url))
        .slice(0, limit)
        .map((source) => ({
            id: source.id,
            kind: "saved-link",
            source: "Saved in Knowledge Inbox",
            relevance: "Saved Link Match",
            title: source.title,
            url: normalizeHttpUrl(source.url),
            domain: new URL(source.url).hostname,
            description: source.content.trim() && source.content.trim() !== source.url
                ? source.content.trim().slice(0, MAX_SOURCE_CHARS)
                : `Saved in your Knowledge Inbox and matched this topic.`,
        }));
}

export async function summarizeAssistantContent({ assistantAnswers, notes, topic }) {
    let remainingContextChars = MAX_CONTEXT_CHARS;
    const includedAnswers = [];
    for (const answer of assistantAnswers.slice(-8)) {
        const content = String(answer).slice(0, Math.min(MAX_SOURCE_CHARS, remainingContextChars));
        if (!content) break;
        includedAnswers.push(content);
        remainingContextChars -= content.length;
    }
    const includedNotes = [];
    for (const note of notes) {
        if (remainingContextChars <= 0) break;
        const content = String(note.content || "").slice(0, Math.min(MAX_SOURCE_CHARS, remainingContextChars));
        if (!content) continue;
        includedNotes.push({ ...note, content });
        remainingContextChars -= content.length;
    }
    const answerContext = includedAnswers.length
        ? `Assistant answers from this conversation:\n${includedAnswers.map((answer, index) =>
            `[ANSWER ${index + 1}]\n${answer}`).join("\n\n")}`
        : "";
    const noteContext = includedNotes.length
        ? `Saved note contents:\n${includedNotes.map((note) =>
            `[NOTE id=${note.id} title="${String(note.title).replaceAll('"', "'")}"]\n${note.content}`
        ).join("\n\n")}`
        : "";
    const { response } = await generateContent(
        `Summarize only the source material below. Include its key concepts, important details, and actionable points when present. Do not add facts that are not in the sources. ${topic ? `The user's topic is: "${topic}".` : ""}\n\n${answerContext}\n\n${noteContext}`,
        {
            systemInstruction: "You are a precise summarization assistant. Summarize only the supplied conversation answers and saved note contents. If the sources differ, keep them clearly distinguished. Do not invent missing details.",
        }
    );
    const rawAnswer = response.text?.trim();
    if (!rawAnswer) {
        const error = new Error("Gemini returned an empty summary.");
        error.statusCode = 502;
        throw error;
    }
    const { answer } = cleanAssistantAnswer(rawAnswer);
    return { answer: answer || rawAnswer, sources: includedNotes.map((note) => ({
        id: note.id,
        type: "note",
        title: note.title,
        url: null,
    })) };
}

export async function fetchLiveWebSearchLinks(topic, limit = 8) {
    try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic)}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return [];
        const html = await res.text();
        const $ = load(html);
        const results = [];
        $(".result").each((_, el) => {
            const titleEl = $(el).find(".result__title .result__a");
            const snippetEl = $(el).find(".result__snippet");
            const rawHref = titleEl.attr("href");
            if (!rawHref) return;
            let url = rawHref;
            try {
                if (rawHref.includes("uddg=")) {
                    const parsed = new URL(rawHref, "https://duckduckgo.com");
                    const uddg = parsed.searchParams.get("uddg");
                    if (uddg) url = decodeURIComponent(uddg);
                }
            } catch {}
            const normalized = normalizeHttpUrl(url);
            if (normalized && !results.some((r) => r.url === normalized)) {
                results.push({
                    url: normalized,
                    title: titleEl.text().trim() || new URL(normalized).hostname,
                    domain: new URL(normalized).hostname,
                    kind: "web-link",
                    source: "DuckDuckGo Web Search",
                    relevance: "Verified External Web Resource",
                    description: snippetEl.text().trim() || `Verified external resource for "${topic}".`,
                });
            }
        });
        return results.slice(0, limit);
    } catch {
        return [];
    }
}

export async function searchExternalWebLinks(topic) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
        const error = new Error("AI is not configured. Add GEMINI_API_KEY to backend/.env and restart the backend.");
        error.statusCode = 503;
        throw error;
    }

    try {
        const { response } = await generateContent(
            `Search the web for authoritative, trustworthy resources relevant to this topic: "${topic}". Prefer official documentation and primary sources. Return JSON with a "results" array. Each result must contain "url" copied exactly from a page actually returned by Google Search and a concise "description" of why that page is relevant. Do not include URLs that were not returned by Google Search.`,
            {
                tools: [{ googleSearch: {} }],
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        results: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    url: { type: Type.STRING },
                                    description: { type: Type.STRING },
                                },
                                required: ["url", "description"],
                            },
                        },
                    },
                    required: ["results"],
                },
            }
        );
        const links = extractGroundedWebLinks(response, topic);
        if (links && links.length > 0) return links;
    } catch {
        // Fallback to verified live web search when Google Search grounding encounters quota limits (429) or is unavailable
    }

    const liveLinks = await fetchLiveWebSearchLinks(topic);
    if (liveLinks.length > 0) return liveLinks;

    const error = new Error("Web search could not retrieve external results at this time.");
    error.statusCode = 502;
    throw error;
}

export function classifyGeminiError(cause) {
    const status = Number(cause?.status ?? cause?.statusCode ?? cause?.response?.status);
    const message = String(cause?.message || "").toLowerCase();
    const code = String(cause?.code || "").toLowerCase();

    if (status === 401 || status === 403 || (status === 400 && /api.?key|key not valid|invalid key/.test(message))) {
        return {
            statusCode: 401,
            message: "Gemini rejected the configured API key. Check backend/.env and confirm that the key has Gemini API access.",
        };
    }
    if (status === 429 || /quota|resource exhausted|rate limit/.test(message)) {
        return {
            statusCode: 429,
            message: "Gemini quota or rate limit reached. Check the API project's quota and try again later.",
        };
    }
    if (
        status === 404 ||
        (status === 400 && /model.*(not found|not supported|unsupported|unavailable)|not found.*model/.test(message))
    ) {
        return {
            statusCode: 400,
            message: "The configured Gemini model is unavailable to this API key. Check GEMINI_MODEL in backend/.env.",
        };
    }
    if (
        status === 503 ||
        /currently experiencing high demand|temporarily unavailable|status.{0,10}unavailable/.test(message)
    ) {
        return {
            statusCode: 503,
            message: "Gemini is temporarily under high demand or unavailable. Please try again shortly.",
        };
    }
    if (
        status >= 500 ||
        /fetch failed|network|timed out|timeout|econn|enotfound|eai_again/.test(`${message} ${code}`)
    ) {
        return {
            statusCode: 503,
            message: "Could not reach the Gemini service. Check backend network connectivity and try again.",
        };
    }
    return {
        statusCode: 502,
        message: "Gemini could not complete the request. Check the configured model and backend connectivity.",
    };
}

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
 * Strips raw citation markers (e.g. [SOURCE id=98 title="Note"]) from text
 * while safely preserving legitimate brackets, spacing, and punctuation.
 *
 * @param {string} text
 * @returns {string} Cleaned text
 */
export function stripCitationMarkers(text) {
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

/**
 * Parses and cleans an assistant answer, supporting both structured JSON format
 * and inline text citation markers.
 *
 * @param {string} rawAnswer
 * @returns {{ answer: string, citations: Array<object>, isStructured: boolean }}
 */
export function cleanAssistantAnswer(rawAnswer) {
    if (!rawAnswer || typeof rawAnswer !== "string") {
        return { answer: rawAnswer || "", citations: [], isStructured: false };
    }

    // 1. Check if the model returned structured JSON with answer and sources
    const trimmed = rawAnswer.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || trimmed.startsWith("```")) {
        try {
            const parsed = extractJson(trimmed);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                if (typeof parsed.answer === "string" || typeof parsed.content === "string") {
                    const ansText = parsed.answer ?? parsed.content;
                    const cleaned = stripCitationMarkers(ansText);
                    const structuredSources = Array.isArray(parsed.sources) ? parsed.sources : [];
                    return {
                        answer: cleaned || ansText,
                        citations: structuredSources,
                        isStructured: true,
                    };
                }
            }
        } catch {
            // Not valid JSON, fall through to inline marker parsing
        }
    }

    // 2. Extract citations and clean inline text
    const bracketRegex = /\[([^\]]+)\]/g;
    let match;
    const citations = [];

    while ((match = bracketRegex.exec(rawAnswer)) !== null) {
        if (isCitationMarker(match[1])) {
            const meta = extractCitationMetadata(match[1]);
            if (meta.id !== null && meta.id !== undefined) {
                citations.push(meta);
            }
        }
    }

    const cleaned = stripCitationMarkers(rawAnswer);

    return {
        answer: cleaned || rawAnswer,
        citations,
        isStructured: false,
    };
}

export async function generateAssistantReply({ message, conversationHistory = [] }) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
        const error = new Error("AI is not configured. Add GEMINI_API_KEY to backend/.env and restart the backend.");
        error.statusCode = 503;
        throw error;
    }

    // 1. Semantic Retrieval with vector similarity
    let sources = [];
    try {
        sources = await retrieveRelevantChunks(message, { limit: 5 });
    } catch {
        // Fall back to keyword retrieval only if semantic retrieval threw an unexpected error
        sources = retrieveDatabaseKnowledge(message, 5);
    }

    const contextParts = [];
    const includedSources = [];
    let contextSize = 0;

    for (const source of sources) {
        const entry = `[SOURCE id=${source.id} type=${source.type} title="${String(source.title || "").replaceAll('"', "'")}"]\n${source.content}\n[/SOURCE]`;
        if (contextSize + entry.length > MAX_CONTEXT_CHARS) break;
        contextParts.push(entry);
        includedSources.push(source);
        contextSize += entry.length;
    }

    const historySection = Array.isArray(conversationHistory) && conversationHistory.length > 0
        ? `Conversation history:\n${conversationHistory
            .slice(-6)
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
            .join("\n\n")}\n\n`
        : "";

    const systemInstruction = process.env.GEMINI_SYSTEM_INSTRUCTION?.trim() ||
        "You are Knowledge Inbox AI, a helpful assistant. Use retrieved saved knowledge for questions about the user's materials, distinguish source-supported facts from general knowledge, and cite only exact [SOURCE id] and title references provided in context. Never invent or alter source identifiers. Do not include raw citation markers, internal source IDs, or numeric record identifiers (such as 'Note #98', 'Source #98', or [SOURCE id=...]) inside the conversational prose of your answer; the user interface automatically presents separate clickable citation cards. If no matching saved knowledge context is provided, explicitly say that no matching saved knowledge was found before giving a general answer where appropriate. If relevant context does not answer the question, say so before giving general guidance.";

    const prompt = `${historySection}Question:\n${message}\n\nSaved knowledge context (retrieved by semantic similarity from active, non-trashed items):\n${contextParts.length ? contextParts.join("\n\n") : "(No saved knowledge matched this query.)"}`;

    const { response, model } = await generateContent(prompt, { systemInstruction });
    let rawText = response.text?.trim();
    if (!rawText && response.candidates?.[0]?.content?.parts) {
        rawText = response.candidates[0].content.parts.map((p) => p.text).join("").trim();
    }
    if (!rawText) {
        const error = new Error("The configured Gemini model returned an empty response.");
        error.statusCode = 502;
        throw error;
    }

    const { answer, citations } = cleanAssistantAnswer(rawText);

    // Preserve the structured sources array with complete metadata, removing any duplicate sources
    let finalSources = includedSources;
    if (citations && citations.length > 0) {
        const citedIds = new Set(citations.map((c) => String(c.id ?? c)));
        const matchedSources = includedSources.filter((s) => citedIds.has(String(s.id)));
        if (matchedSources.length > 0) {
            finalSources = matchedSources;
        }
    }

    const seenSourceIds = new Set();
    finalSources = finalSources.filter((source) => {
        if (!source || !source.id) return false;
        if (seenSourceIds.has(source.id)) return false;
        seenSourceIds.add(source.id);
        return true;
    });

    return { answer: answer || rawText, sources: finalSources, model };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createItem,
    deleteItemById,
    getItemById,
    permanentlyDeleteItemById,
    updateItemById,
} from "../repositories/itemRepository.js";
import { getItemChunks } from "../repositories/chunkRepository.js";
import db from "../database/database.js";
import { indexKnowledgeItem, retrieveRelevantChunks } from "./retrievalService.js";
import { generateAssistantReply, searchExternalWebLinks, summarizeAssistantContent } from "./aiService.js";

test("RAG generates grounded answers with accurate source citations", async () => {
    const item = createItem({
        title: "Database Indexing Principles",
        content: "B-Tree indexes are balanced trees that keep data sorted and allow searches, sequential access, insertions, and deletions in logarithmic time. Inverted indexes are used for full-text search.",
        sourceType: "note",
    });

    try {
        await indexKnowledgeItem(item);

        const reply = await generateAssistantReply({
            message: "Explain what B-Tree indexes are and their time complexity based on my notes.",
        });

        assert.ok(reply.answer, "Should return an answer");
        assert.match(reply.answer, /B-Tree/i);
        assert.ok(reply.sources.length > 0, "Should include sources");
        assert.equal(reply.sources[0].id, item.id);
        assert.equal(reply.sources[0].title, "Database Indexing Principles");
    } finally {
        deleteItemById(item.id, "note");
        permanentlyDeleteItemById(item.id);
    }
});

test("RAG states clearly when no saved knowledge matches an arbitrary query", async () => {
    const reply = await generateAssistantReply({
        message: "What is the secret recipe for Martian blue cheese fondue?",
    });

    assert.ok(reply.answer, "Should return an answer");
    assert.match(reply.answer, /no (matching )?saved knowledge|does not contain|no saved knowledge context/i);
});

test("Summarize notes produces grounded summary of actual saved notes", async () => {
    const notes = [
        {
            id: 101,
            title: "Microservices Deployment",
            content: "We deployed 3 microservices using Docker containers and Kubernetes on Monday.",
        },
    ];

    const result = await summarizeAssistantContent({
        assistantAnswers: [],
        notes,
        topic: "deployment",
    });

    assert.ok(result.answer, "Should produce summary");
    assert.match(result.answer, /microservices|docker|kubernetes/i);
    assert.equal(result.sources[0].id, 101);
});

test("External web search returns real links with URLs, titles, and descriptions", async () => {
    let results;
    try {
        results = await searchExternalWebLinks("React documentation");
    } catch {
        await new Promise((r) => setTimeout(r, 1000));
        results = await searchExternalWebLinks("React documentation");
    }

    assert.ok(Array.isArray(results), "Should return array of results");
    assert.ok(results.length > 0, "Should return at least one result");

    for (const link of results) {
        assert.ok(link.url.startsWith("http://") || link.url.startsWith("https://"));
        assert.ok(link.title && link.title.trim().length > 0);
        assert.ok(link.description && link.description.trim().length > 0);
        assert.ok(link.domain && link.domain.trim().length > 0);
    }
});

test("CRUD operations maintain chunk consistency", async () => {
    // 1. Create
    const item = createItem({
        title: "CRUD Consistency Test Note",
        content: "Testing automatic chunking and indexing across item lifecycle.",
        sourceType: "note",
    });
    await indexKnowledgeItem(item);

    let chunks = getItemChunks(item.id);
    assert.ok(chunks.length > 0, "Chunks should exist after indexing");

    // 2. Update
    const updated = updateItemById(item.id, {
        title: "CRUD Consistency Test Note Updated",
        content: "Updated note content with new insights on vector databases.",
        sourceType: "note",
    });
    await indexKnowledgeItem(updated);

    chunks = getItemChunks(item.id);
    assert.ok(chunks.length > 0, "Chunks should be updated");
    assert.ok(chunks[0].content.includes("new insights on vector databases"));

    // 3. Delete to trash
    deleteItemById(item.id, "note");
    // Verify item is in trash
    const trashedItem = getItemById(item.id);
    assert.equal(trashedItem, undefined); // getItemById only returns non-trashed

    // 4. Permanent delete
    permanentlyDeleteItemById(item.id);
    chunks = getItemChunks(item.id);
    assert.equal(chunks.length, 0, "Chunks should be removed after permanent deletion");
});

test("interactive citations can retrieve full item details or handle deleted items gracefully", () => {
    const item = createItem({
        title: "Citation Detail Inspection Test",
        content: "Testing that interactive citation lookup resolves complete item metadata.",
        sourceType: "note",
    });

    try {
        const fullItem = getItemById(item.id);
        assert.ok(fullItem, "Item should exist");
        assert.equal(fullItem.id, item.id);
        assert.equal(fullItem.title, "Citation Detail Inspection Test");
        assert.equal(fullItem.content, "Testing that interactive citation lookup resolves complete item metadata.");
        assert.ok(fullItem.created_at, "Should contain creation timestamp");
    } finally {
        deleteItemById(item.id, "note");
        permanentlyDeleteItemById(item.id);
    }

    const missingItem = getItemById(item.id);
    assert.equal(missingItem, undefined, "Deleted item should return undefined/inaccessible");
});

test("content-based deduplication returns only one representative chunk for identical notes", async () => {
    const noteA = createItem({
        title: "Redis In-Memory Store A",
        content: "Redis is an in-memory data structure store used as a database, cache, message broker, and streaming engine.",
        sourceType: "note",
    });
    const noteB = createItem({
        title: "Redis In-Memory Store B",
        content: "Redis is an in-memory data structure store used as a database, cache, message broker, and streaming engine.",
        sourceType: "note",
    });

    try {
        await indexKnowledgeItem(noteA);
        await indexKnowledgeItem(noteB);

        const retrieved = await retrieveRelevantChunks("What is Redis and what is it used for?");
        const redisMatches = retrieved.filter((r) => r.content.includes("in-memory data structure store"));
        assert.equal(redisMatches.length, 1, "Should deduplicate identical content to a single representative chunk");
        assert.ok([noteA.id, noteB.id].includes(redisMatches[0].id), "Representative chunk should refer to an actual saved note ID");
        assert.ok(redisMatches[0].title.startsWith("Redis"), "Representative chunk should have valid title");

        const reply = await generateAssistantReply({ message: "What is Redis and what is it used for?" });
        const redisSources = reply.sources.filter((s) => s.title.startsWith("Redis"));
        assert.equal(redisSources.length, 1, "RAG assistant should cite only one representative source for duplicate content");
        assert.match(reply.answer, /Redis/i);
    } finally {
        deleteItemById(noteA.id, "note");
        permanentlyDeleteItemById(noteA.id);
        deleteItemById(noteB.id, "note");
        permanentlyDeleteItemById(noteB.id);
    }
});

test("content-based deduplication handles content differing only in whitespace", async () => {
    const noteA = createItem({
        title: "GraphQL Standard Note",
        content: "GraphQL provides a complete and understandable description of the data in your API and gives clients the power to ask for exactly what they need.",
        sourceType: "note",
    });
    const noteB = createItem({
        title: "GraphQL Whitespace Note",
        content: "   GraphQL  provides   a complete and\nunderstandable description of the data in your API\n\tand gives clients the power to ask for exactly what they need.  ",
        sourceType: "note",
    });

    try {
        await indexKnowledgeItem(noteA);
        await indexKnowledgeItem(noteB);

        const retrieved = await retrieveRelevantChunks("How does GraphQL provide API data description?");
        const gqlMatches = retrieved.filter((r) => r.content.toLowerCase().includes("understandable description of the data"));
        assert.equal(gqlMatches.length, 1, "Should deduplicate notes that differ only in whitespace");
    } finally {
        deleteItemById(noteA.id, "note");
        permanentlyDeleteItemById(noteA.id);
        deleteItemById(noteB.id, "note");
        permanentlyDeleteItemById(noteB.id);
    }
});

test("content-based deduplication preserves notes with genuinely different information", async () => {
    const noteA = createItem({
        title: "Docker Containerization",
        content: "Docker packages code and its dependencies together into standardized units called containers for rapid deployment.",
        sourceType: "note",
    });
    const noteB = createItem({
        title: "Kubernetes Container Orchestration",
        content: "Kubernetes coordinates automated deployment, scaling, and operational management of containerized application clusters.",
        sourceType: "note",
    });

    try {
        await indexKnowledgeItem(noteA);
        await indexKnowledgeItem(noteB);

        const retrieved = await retrieveRelevantChunks("Explain containerization and cluster orchestration workflows");
        const hasDocker = retrieved.some((r) => r.id === noteA.id);
        const hasK8s = retrieved.some((r) => r.id === noteB.id);
        assert.ok(hasDocker, "Should retain Docker note with distinct information");
        assert.ok(hasK8s, "Should retain Kubernetes note with distinct information");
    } finally {
        deleteItemById(noteA.id, "note");
        permanentlyDeleteItemById(noteA.id);
        deleteItemById(noteB.id, "note");
        permanentlyDeleteItemById(noteB.id);
    }
});

test("retrieval deduplicates existing identical database notes #82 and #98 without deleting either record", async () => {
    let item82 = getItemById(82);
    let item98 = getItemById(98);
    const noteContent = "Our Knowledge Inbox AI application uses Node.js 24.15.0 for its JavaScript runtime and SQLite for persistent database storage. The backend exposes REST APIs, and the frontend uses React with Vite.";
    if (!item82) {
        db.prepare(`
            INSERT OR REPLACE INTO items (id, title, content, source_type, created_at, updated_at, last_accessed_at)
            VALUES (82, 'App Architecture Note', ?, 'note', '2026-10-12T07:18:00.000Z', '2026-10-12T07:18:00.000Z', '2026-10-12T07:18:00.000Z')
        `).run(noteContent);
        item82 = getItemById(82);
        await indexKnowledgeItem(item82);
    }
    if (!item98) {
        db.prepare(`
            INSERT OR REPLACE INTO items (id, title, content, source_type, created_at, updated_at, last_accessed_at)
            VALUES (98, 'App Architecture Note', ?, 'note', '2026-10-12T07:42:00.000Z', '2026-10-12T07:42:00.000Z', '2026-10-12T07:42:00.000Z')
        `).run(noteContent);
        item98 = getItemById(98);
        await indexKnowledgeItem(item98);
    }
    assert.ok(item82, "Item #82 must exist in database");
    assert.ok(item98, "Item #98 must exist in database");
    assert.equal(item82.content, item98.content, "Item #82 and #98 content should be identical");

    const retrieved = await retrieveRelevantChunks("Which database does my application use?");
    const appMatches = retrieved.filter((r) => r.content.includes("Node.js 24.15.0") && r.content.includes("SQLite"));
    assert.equal(appMatches.length, 1, "Should retrieve exactly one representative chunk for Notes #82 and #98");
    assert.ok([82, 98].includes(appMatches[0].id), "Selected source ID must be one of the real saved records (82 or 98)");

    const reply = await generateAssistantReply({ message: "Which database does my application use?" });
    const appSources = reply.sources.filter((s) => [82, 98].includes(s.id));
    assert.equal(appSources.length, 1, "RAG assistant must cite exactly one source for identical content rather than duplicating citations");
    assert.match(reply.answer, /SQLite/i);
    assert.doesNotMatch(reply.answer, /\[SOURCE\b/i, "Displayed answer text must not contain raw [SOURCE] citation markers");
    assert.ok(appSources[0].title, "Source in sources array must preserve its title metadata");
    assert.ok(appSources[0].type, "Source in sources array must preserve its type metadata");
});

test("RAG answer removes raw citation markers while preserving the structured sources array", async () => {
    const item = createItem({
        title: "Architecture Specification",
        content: "Knowledge Inbox AI architecture consists of an Express API backend, SQLite persistence, and a React Vite frontend.",
        sourceType: "document",
    });

    try {
        await indexKnowledgeItem(item);

        const reply = await generateAssistantReply({
            message: "What are the three components of the Knowledge Inbox AI architecture according to my specification?",
        });

        assert.ok(reply.answer, "Should return an answer");
        assert.match(reply.answer, /Express|SQLite|React/i);
        // Verify raw markers are completely removed from the displayed answer text
        assert.doesNotMatch(
            reply.answer,
            /\[(?:SOURCE|NOTE)\b/i,
            "Answer text must not display raw [SOURCE id=... title=...] markers"
        );
        // Verify structured sources array remains fully populated and intact
        assert.ok(reply.sources.length > 0, "Structured sources array must be preserved");
        const found = reply.sources.find((s) => s.id === item.id);
        assert.ok(found, "Structured sources array must contain the cited document item");
        assert.equal(found.id, item.id);
        assert.equal(found.title, "Architecture Specification");
        assert.equal(found.type, "document");
    } finally {
        deleteItemById(item.id, "document");
        permanentlyDeleteItemById(item.id);
    }
});

test("questions requiring multiple sources return all relevant sources without unnecessary citations", async () => {
    const noteFrontend = createItem({
        title: "Frontend Framework Choice",
        content: "Knowledge Inbox AI frontend is built with React 19 using Vite and pure CSS modules for responsive layout.",
        sourceType: "note",
    });
    const noteBackend = createItem({
        title: "Backend Persistence Design",
        content: "Knowledge Inbox AI backend uses an Express REST API with SQLite WAL-mode database persistence.",
        sourceType: "note",
    });

    try {
        await indexKnowledgeItem(noteFrontend);
        await indexKnowledgeItem(noteBackend);

        const reply = await generateAssistantReply({
            message: "Which build tool and UI library does the frontend use, and which API framework and database does the backend use?",
        });

        assert.ok(reply.answer, "Should return an answer covering both components");
        assert.match(reply.answer, /React|Vite/i);
        assert.match(reply.answer, /Express|SQLite/i);

        // Ensure raw markers are not in the answer text
        assert.doesNotMatch(reply.answer, /\[(?:SOURCE|NOTE)\b/i);
        assert.doesNotMatch(reply.answer, /\b(?:Note|Source)\s*#\d+/i);

        // Ensure both relevant sources are present in the structured sources array
        const hasFrontendSource = reply.sources.some((s) => s.id === noteFrontend.id);
        const hasBackendSource = reply.sources.some((s) => s.id === noteBackend.id);
        assert.ok(hasFrontendSource, "Sources must include the frontend framework note");
        assert.ok(hasBackendSource, "Sources must include the backend persistence note");

        // Ensure no duplicate entries exist in the sources array
        const uniqueIds = new Set(reply.sources.map((s) => s.id));
        assert.equal(uniqueIds.size, reply.sources.length, "Sources array must not contain duplicate entries");
    } finally {
        deleteItemById(noteFrontend.id, "note");
        permanentlyDeleteItemById(noteFrontend.id);
        deleteItemById(noteBackend.id, "note");
        permanentlyDeleteItemById(noteBackend.id);
    }
});

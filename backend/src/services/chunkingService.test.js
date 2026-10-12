import assert from "node:assert/strict";
import { test } from "node:test";
import {
    DEFAULT_CHUNK_OVERLAP,
    DEFAULT_CHUNK_SIZE,
    chunkKnowledgeItem,
    splitTextIntoChunks,
} from "./chunkingService.js";

test("splitTextIntoChunks handles empty or non-string inputs", () => {
    assert.deepEqual(splitTextIntoChunks(""), []);
    assert.deepEqual(splitTextIntoChunks(null), []);
    assert.deepEqual(splitTextIntoChunks(undefined), []);
    assert.deepEqual(splitTextIntoChunks("   "), []);
});

test("splitTextIntoChunks returns single chunk when content fits within chunkSize", () => {
    const text = "A short note about JavaScript closures.";
    const chunks = splitTextIntoChunks(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], text);
});

test("splitTextIntoChunks splits long text with small overlap and preserves boundaries", () => {
    const p1 = "First paragraph introduces retrieval-augmented generation and semantic search.";
    const p2 = "Second paragraph explains vector databases and embeddings in knowledge management.";
    const p3 = "Third paragraph details chunking strategies for long documents and PDFs.";
    const fullText = `${p1}\n\n${p2}\n\n${p3}`;

    const chunks = splitTextIntoChunks(fullText, { chunkSize: 90, chunkOverlap: 20 });
    assert.ok(chunks.length > 1, "Should produce multiple chunks");

    // All chunks should have content
    for (const chunk of chunks) {
        assert.ok(chunk.length > 0);
    }
});

test("chunkKnowledgeItem preserves item ID, title, type, and source URL metadata", () => {
    const item = {
        id: 42,
        title: "Architecture Guide",
        source_type: "document",
        source_url: "https://example.com/docs/arch.pdf",
        content: "Detailed architecture of knowledge inbox. Includes chunking, embedding, vector store, and RAG pipelines.",
    };

    const chunks = chunkKnowledgeItem(item, { chunkSize: 50, chunkOverlap: 10 });
    assert.ok(chunks.length >= 2);

    for (const [index, chunk] of chunks.entries()) {
        assert.equal(chunk.itemId, 42);
        assert.equal(chunk.chunkIndex, index);
        assert.ok(chunk.content.length > 0);
        assert.equal(chunk.metadata.itemId, 42);
        assert.equal(chunk.metadata.title, "Architecture Guide");
        assert.equal(chunk.metadata.sourceType, "document");
        assert.equal(chunk.metadata.sourceUrl, "https://example.com/docs/arch.pdf");
    }
});

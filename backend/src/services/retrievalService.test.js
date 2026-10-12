import assert from "node:assert/strict";
import { test } from "node:test";
import { createItem, deleteItemById, permanentlyDeleteItemById } from "../repositories/itemRepository.js";
import { deleteItemChunks } from "../repositories/chunkRepository.js";
import { indexKnowledgeItem, retrieveRelevantChunks } from "./retrievalService.js";

test("retrieveRelevantChunks handles empty queries gracefully", async () => {
    assert.deepEqual(await retrieveRelevantChunks(""), []);
    assert.deepEqual(await retrieveRelevantChunks(null), []);
    assert.deepEqual(await retrieveRelevantChunks("   "), []);
});

test("retrieveRelevantChunks retrieves indexed item chunks with accurate metadata", async () => {
    const item = createItem({
        title: "Kubernetes Pod Management Notes",
        content: "A Kubernetes pod represents a single instance of a running process in your cluster. Pods contain one or more containers sharing network and storage.",
        sourceType: "note",
        sourceUrl: null,
    });

    try {
        await indexKnowledgeItem(item);

        const results = await retrieveRelevantChunks("What is a Kubernetes pod in a cluster?", { limit: 3 });
        assert.ok(results.length > 0, "Should retrieve at least one chunk");
        assert.equal(results[0].id, item.id);
        assert.equal(results[0].title, "Kubernetes Pod Management Notes");
        assert.equal(results[0].type, "note");
        assert.ok(results[0].score > 0);
        assert.ok(results[0].content.includes("Kubernetes pod"));
    } finally {
        deleteItemChunks(item.id);
        deleteItemById(item.id, "note");
        permanentlyDeleteItemById(item.id);
    }
});

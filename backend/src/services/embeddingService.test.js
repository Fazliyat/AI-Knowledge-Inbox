import assert from "node:assert/strict";
import { test } from "node:test";
import {
    LOCAL_EMBEDDING_DIMENSIONS,
    cosineSimilarity,
    generateEmbedding,
    generateEmbeddings,
    generateLocalEmbedding,
    getEmbeddingConfig,
} from "./embeddingService.js";

test("cosineSimilarity computes accurate vector similarity", () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
    assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
    assert.equal(cosineSimilarity([1, 2, 3], [2, 4, 6]), 1);
    assert.equal(cosineSimilarity([], [1, 2]), 0);
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
    assert.equal(cosineSimilarity(null, [1]), 0);
});

test("generateLocalEmbedding creates unit-normalized vectors", () => {
    const vec = generateLocalEmbedding("Semantic search and retrieval-augmented generation");
    assert.equal(vec.length, LOCAL_EMBEDDING_DIMENSIONS);

    let norm = 0;
    for (const val of vec) norm += val * val;
    assert.ok(Math.abs(norm - 1.0) < 0.001, "Vector should have Euclidean norm ~ 1");
});

test("generateLocalEmbedding reflects semantic overlap", () => {
    const vecA = generateLocalEmbedding("Machine learning neural networks deep learning");
    const vecB = generateLocalEmbedding("Deep neural networks machine learning models");
    const vecC = generateLocalEmbedding("Chocolate chip cookies baking flour butter sugar");

    const simAB = cosineSimilarity(vecA, vecB);
    const simAC = cosineSimilarity(vecA, vecC);

    assert.ok(simAB > simAC, `Related texts (${simAB}) should have higher similarity than unrelated (${simAC})`);
});

test("generateEmbeddings returns embeddings for an array of texts", async () => {
    const texts = ["First knowledge snippet", "Second knowledge snippet"];
    const vectors = await generateEmbeddings(texts);

    assert.equal(vectors.length, 2);
    assert.ok(vectors[0].length > 0);
    assert.ok(vectors[1].length > 0);
});

test("getEmbeddingConfig reports configuration status", () => {
    const config = getEmbeddingConfig();
    assert.ok(typeof config.configured === "boolean");
    assert.ok(typeof config.model === "string");
    assert.ok(typeof config.provider === "string");
});

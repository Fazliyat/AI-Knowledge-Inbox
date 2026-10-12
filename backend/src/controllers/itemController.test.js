import assert from "node:assert/strict";
import { test } from "node:test";
import { createItem, deleteItemById, permanentlyDeleteItemById } from "../repositories/itemRepository.js";
import { getItem } from "./itemController.js";

function mockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

test("getItem returns full item metadata for valid existing items", () => {
    const item = createItem({
        title: "Item Fetch Test Note",
        content: "Testing full item fetch for interactive citations.",
        sourceType: "note",
    });

    const res = mockResponse();
    try {
        getItem({ params: { id: String(item.id) } }, res, (err) => { throw err; });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.data.id, item.id);
        assert.equal(res.body.data.title, "Item Fetch Test Note");
        assert.equal(res.body.data.content, "Testing full item fetch for interactive citations.");
    } finally {
        deleteItemById(item.id, "note");
        permanentlyDeleteItemById(item.id);
    }
});

test("getItem returns 404 for deleted or non-existent items", () => {
    const res = mockResponse();
    getItem({ params: { id: "9999999" } }, res, (err) => { throw err; });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /not found/i);
});

test("getItem returns 400 for invalid item ID formats", () => {
    const res = mockResponse();
    getItem({ params: { id: "invalid-id" } }, res, (err) => { throw err; });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
});

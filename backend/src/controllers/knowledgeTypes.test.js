import assert from "node:assert/strict";
import { test } from "node:test";
import db from "../database/database.js";
import { addItem, updateItem, listItems, getItem } from "./itemController.js";
import { createUploadedDocument, removeStoredDocumentFile } from "../repositories/documentRepository.js";
import { getItemById, deleteItemById, permanentlyDeleteItemById, getFilteredItems } from "../repositories/itemRepository.js";
import { chunkKnowledgeItem } from "../services/chunkingService.js";
import { indexKnowledgeItem, retrieveRelevantChunks } from "../services/retrievalService.js";

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

test("saving a note creates exactly 1 note record and no document or link", async () => {
    const res = mockResponse();
    const req = {
        body: {
            title: "Autonomous Agents Design",
            content: "Architecture notes on agentic coding and planning workflows.",
            sourceType: "note",
        },
    };

    let createdId;
    try {
        addItem(req, res, (err) => { throw err; });
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.success, true);
        assert.equal(res.body.data.source_type, "note");
        assert.equal(res.body.data.title, "Autonomous Agents Design");
        assert.equal(res.body.data.content, "Architecture notes on agentic coding and planning workflows.");
        assert.equal(res.body.data.source_url, null);

        createdId = res.body.data.id;

        // Check database: exactly 1 item record, 0 document records
        const itemRecord = db.prepare("SELECT * FROM items WHERE id = ?").get(createdId);
        assert.ok(itemRecord);
        assert.equal(itemRecord.source_type, "note");

        const docRecord = db.prepare("SELECT * FROM documents WHERE item_id = ?").get(createdId);
        assert.equal(docRecord, undefined, "Note must not create a document record");
    } finally {
        if (createdId) {
            deleteItemById(createdId, "note");
            permanentlyDeleteItemById(createdId);
        }
    }
});

test("saving a link creates exactly 1 link record with optional description and no separate note", async () => {
    const res = mockResponse();
    const req = {
        body: {
            title: "MDN Web Docs",
            content: "Comprehensive documentation for web standards and JavaScript APIs.",
            sourceType: "url",
            sourceUrl: "https://developer.mozilla.org",
        },
    };

    let createdId;
    try {
        addItem(req, res, (err) => { throw err; });
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.success, true);
        assert.equal(res.body.data.source_type, "url");
        assert.equal(res.body.data.title, "MDN Web Docs");
        assert.equal(res.body.data.source_url, "https://developer.mozilla.org");
        assert.equal(res.body.data.content, "Comprehensive documentation for web standards and JavaScript APIs.");

        createdId = res.body.data.id;

        // Verify only 1 item record exists and no document record exists
        const itemsWithTitle = db.prepare("SELECT * FROM items WHERE title = ? AND trashed_at IS NULL").all("MDN Web Docs");
        assert.equal(itemsWithTitle.length, 1, "Must create exactly 1 item record and no duplicate notes");

        const docRecord = db.prepare("SELECT * FROM documents WHERE item_id = ?").get(createdId);
        assert.equal(docRecord, undefined, "Link must not create a document record");
    } finally {
        if (createdId) {
            deleteItemById(createdId, "url");
            permanentlyDeleteItemById(createdId);
        }
    }
});

test("saving a document creates exactly 1 document record containing file reference, custom title, and notes without secondary note", async () => {
    const buffer = Buffer.from("Quarterly report content: revenue up 25 percent in Q3.", "utf-8");
    const { itemId, document } = await createUploadedDocument({
        fileName: "Q3_Report.txt",
        extension: ".txt",
        mimeType: "text/plain",
        buffer,
        extractedText: "Quarterly report content: revenue up 25 percent in Q3.",
        title: "Q3 Financial Summary",
        description: "Important leadership briefing notes for executive review.",
    });

    try {
        assert.ok(itemId);
        const item = getItemById(itemId);
        assert.equal(item.source_type, "document");
        assert.equal(item.title, "Q3 Financial Summary");
        assert.match(item.content, /Important leadership briefing notes/);
        assert.match(item.content, /revenue up 25 percent/);
        assert.equal(item.original_file_name, "Q3_Report.txt");
        assert.ok(item.file_id);

        // Verify no secondary note item was created
        const allMatching = db.prepare("SELECT * FROM items WHERE (title = 'Q3 Financial Summary' OR content LIKE '%Important leadership briefing%') AND trashed_at IS NULL").all();
        assert.equal(allMatching.length, 1, "Must create exactly 1 item record, no separate note record");
        assert.equal(allMatching[0].source_type, "document");

        // Verify document table contains proper references
        assert.equal(document.title, "Q3 Financial Summary");
        assert.equal(document.file_name, "Q3_Report.txt");
        assert.equal(document.item_id, itemId);
    } finally {
        if (itemId) {
            deleteItemById(itemId, "document");
            permanentlyDeleteItemById(itemId);
            if (document) await removeStoredDocumentFile(document);
        }
    }
});

test("editing an item updates the record in place without creating duplicates or changing ID", async () => {
    const resAdd = mockResponse();
    addItem({
        body: {
            title: "Original Draft Title",
            content: "Initial draft text content.",
            sourceType: "note",
        },
    }, resAdd, (err) => { throw err; });

    const itemId = resAdd.body.data.id;

    try {
        const resUpdate = mockResponse();
        updateItem({
            params: { id: String(itemId) },
            body: {
                title: "Updated Final Title",
                content: "Polished and refined text content.",
                sourceType: "note",
            },
        }, resUpdate, (err) => { throw err; });

        assert.equal(resUpdate.statusCode, 200);
        assert.equal(resUpdate.body.success, true);
        assert.equal(resUpdate.body.data.id, itemId, "ID must remain unchanged after edit");
        assert.equal(resUpdate.body.data.title, "Updated Final Title");
        assert.equal(resUpdate.body.data.content, "Polished and refined text content.");

        // Check that no duplicate record exists
        const count = db.prepare("SELECT count(*) as count FROM items WHERE id = ?").get(itemId).count;
        assert.equal(count, 1);
        const totalWithTitle = db.prepare("SELECT count(*) as count FROM items WHERE title IN ('Original Draft Title', 'Updated Final Title') AND trashed_at IS NULL").get().count;
        assert.equal(totalWithTitle, 1, "Editing must not spawn duplicate records");
    } finally {
        deleteItemById(itemId, "note");
        permanentlyDeleteItemById(itemId);
    }
});

test("editing a document updates title and notes in place while preserving file attachment", async () => {
    const buffer = Buffer.from("System architecture diagram and technical specifications.", "utf-8");
    const { itemId, document } = await createUploadedDocument({
        fileName: "Architecture.txt",
        extension: ".txt",
        mimeType: "text/plain",
        buffer,
        extractedText: "System architecture diagram and technical specifications.",
        title: "Initial System Arch",
        description: "Initial draft notes.",
    });

    try {
        const resUpdate = mockResponse();
        updateItem({
            params: { id: String(itemId) },
            body: {
                title: "Production System Architecture v2",
                content: "Updated production notes: high availability cluster configured.\n\nSystem architecture diagram and technical specifications.",
                sourceType: "document",
            },
        }, resUpdate, (err) => { throw err; });

        assert.equal(resUpdate.statusCode, 200);
        assert.equal(resUpdate.body.success, true);
        assert.equal(resUpdate.body.data.id, itemId, "Preserves item ID");
        assert.equal(resUpdate.body.data.title, "Production System Architecture v2");
        assert.match(resUpdate.body.data.content, /high availability cluster/);
        assert.equal(resUpdate.body.data.original_file_name, "Architecture.txt", "Preserves original file name");
        assert.equal(resUpdate.body.data.file_id, document.file_id, "Preserves file attachment reference");

        // Verify documents table title is updated
        const updatedDoc = db.prepare("SELECT * FROM documents WHERE item_id = ?").get(itemId);
        assert.equal(updatedDoc.title, "Production System Architecture v2");
    } finally {
        deleteItemById(itemId, "document");
        permanentlyDeleteItemById(itemId);
        if (document) await removeStoredDocumentFile(document);
    }
});

test("filtering strictly distinguishes between note, url, and document types", async () => {
    const resNote = mockResponse();
    addItem({ body: { title: "Type Test Note", content: "Note body", sourceType: "note" } }, resNote, () => {});
    const noteId = resNote.body.data.id;

    const resLink = mockResponse();
    addItem({ body: { title: "Type Test Link", content: "Link desc", sourceType: "url", sourceUrl: "https://example.com/type" } }, resLink, () => {});
    const linkId = resLink.body.data.id;

    const { itemId: docId, document } = await createUploadedDocument({
        fileName: "TypeTest.txt",
        extension: ".txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Document body text", "utf-8"),
        extractedText: "Document body text",
        title: "Type Test Document",
    });

    try {
        const notesOnly = getFilteredItems("note");
        assert.ok(notesOnly.some((i) => i.id === noteId));
        assert.ok(!notesOnly.some((i) => i.id === linkId));
        assert.ok(!notesOnly.some((i) => i.id === docId));

        const linksOnly = getFilteredItems("url");
        assert.ok(linksOnly.some((i) => i.id === linkId));
        assert.ok(!linksOnly.some((i) => i.id === noteId));
        assert.ok(!linksOnly.some((i) => i.id === docId));

        const docsOnly = getFilteredItems("document");
        assert.ok(docsOnly.some((i) => i.id === docId));
        assert.ok(!docsOnly.some((i) => i.id === noteId));
        assert.ok(!docsOnly.some((i) => i.id === linkId));

        const allItems = getFilteredItems("all");
        assert.ok(allItems.some((i) => i.id === noteId));
        assert.ok(allItems.some((i) => i.id === linkId));
        assert.ok(allItems.some((i) => i.id === docId));
    } finally {
        deleteItemById(noteId, "note");
        permanentlyDeleteItemById(noteId);
        deleteItemById(linkId, "url");
        permanentlyDeleteItemById(linkId);
        deleteItemById(docId, "document");
        permanentlyDeleteItemById(docId);
        if (document) await removeStoredDocumentFile(document);
    }
});

test("RAG indexing and chunking captures both user notes and document text", async () => {
    const buffer = Buffer.from("Quantum teleportation relies on quantum entanglement to transfer states.", "utf-8");
    const { itemId, document } = await createUploadedDocument({
        fileName: "Quantum_Physics.txt",
        extension: ".txt",
        mimeType: "text/plain",
        buffer,
        extractedText: "Quantum teleportation relies on quantum entanglement to transfer states.",
        title: "Quantum Entanglement Research",
        description: "Key lab notes: Teleportation confirmed across 50km fiber link.",
    });

    try {
        const item = getItemById(itemId);
        const chunks = chunkKnowledgeItem(item);
        assert.ok(chunks.length > 0);
        const allChunkContent = chunks.map((c) => c.content).join(" ");

        // Contains both the user notes and the extracted text
        assert.match(allChunkContent, /Teleportation confirmed across 50km/);
        assert.match(allChunkContent, /Quantum teleportation relies on quantum entanglement/);
        assert.equal(chunks[0].metadata.sourceType, "document");
        assert.equal(chunks[0].metadata.title, "Quantum Entanglement Research");

        await indexKnowledgeItem(item);
        const retrieved = await retrieveRelevantChunks("What was confirmed across the 50km fiber link in quantum lab notes?");
        const matched = retrieved.find((r) => r.id === itemId);
        assert.ok(matched, "Retrieved chunk must match document by user notes");
        assert.equal(matched.type, "document");
        assert.equal(matched.title, "Quantum Entanglement Research");
    } finally {
        deleteItemById(itemId, "document");
        permanentlyDeleteItemById(itemId);
        if (document) await removeStoredDocumentFile(document);
    }
});

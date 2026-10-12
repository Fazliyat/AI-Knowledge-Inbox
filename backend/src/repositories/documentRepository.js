import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "../database/database.js";

const repositoryDirectory = path.dirname(fileURLToPath(import.meta.url));
const storageDirectory = path.resolve(
    process.env.DOCUMENT_STORAGE_DIR || path.resolve(repositoryDirectory, "../../uploads")
);

function getSafeStoragePath(storageName) {
    if (typeof storageName !== "string" || path.basename(storageName) !== storageName ||
        !/^[0-9a-f-]{36}\.[a-z0-9]{1,10}$/i.test(storageName)) {
        throw new Error("Stored document location is invalid.");
    }
    return path.join(storageDirectory, storageName);
}

export function getStoredDocument(itemId, { includeTrashed = false } = {}) {
    return db.prepare(`
        SELECT d.id, d.file_id, d.item_id, d.title, d.file_name, d.file_type, d.mime_type,
               d.file_size, d.storage_path, d.content, d.status, d.processing_status, d.extracted_text,
               d.uploaded_at, d.created_at, d.updated_at,
               i.created_at AS item_created_at, i.trashed_at
        FROM documents d
        LEFT JOIN items i ON i.id = d.item_id
        WHERE d.item_id = ? ${includeTrashed ? "" : "AND i.trashed_at IS NULL"}
        ORDER BY d.id DESC
        LIMIT 1
    `).get(itemId);
}

export function getStoredDocumentPath(storageName) {
    return getSafeStoragePath(storageName);
}

export async function createUploadedDocument({
    fileName,
    extension,
    mimeType,
    buffer,
    extractedText,
    title: customTitle,
    description,
}) {
    const fileId = randomUUID();
    const storageName = `${fileId}${extension}`;
    const storagePath = getSafeStoragePath(storageName);
    const fallbackTitle = fileName.replace(/\.[^.]+$/, "").trim() || fileName;
    const title = (typeof customTitle === "string" && customTitle.trim())
        ? customTitle.trim()
        : fallbackTitle;
    const processingStatus = extractedText ? "processed" : "stored_only";
    const now = new Date().toISOString();

    const cleanDescription = (typeof description === "string") ? description.trim() : "";
    const cleanExtracted = (typeof extractedText === "string") ? extractedText.trim() : "";

    let itemContent = "";
    if (cleanDescription && cleanExtracted) {
        itemContent = `${cleanDescription}\n\n${cleanExtracted}`;
    } else if (cleanDescription) {
        itemContent = cleanDescription;
    } else {
        itemContent = cleanExtracted;
    }

    await mkdir(storageDirectory, { recursive: true });
    await writeFile(storagePath, buffer, { flag: "wx", mode: 0o600 });

    try {
        const transaction = db.transaction(() => {
            const itemResult = db.prepare(`
                INSERT INTO items (title, content, source_type, source_url, favorite, created_at, updated_at, last_accessed_at)
                VALUES (?, ?, 'document', NULL, 0, ?, ?, ?)
            `).run(title, itemContent, now, now, now);
            const itemId = Number(itemResult.lastInsertRowid);
            db.prepare(`
                INSERT INTO documents (
                    file_id, item_id, title, file_name, file_type, mime_type, file_size,
                    storage_path, content, extracted_text, status, processing_status,
                    created_at, updated_at, uploaded_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                fileId, itemId, title, fileName, extension.slice(1), mimeType, buffer.length,
                storageName, cleanDescription || cleanExtracted, cleanExtracted, processingStatus, processingStatus,
                now, now, now
            );
            return itemId;
        });
        const itemId = transaction();
        return { itemId, document: getStoredDocument(itemId) };
    } catch (error) {
        try {
            await unlink(storagePath);
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Document metadata could not be saved and the uploaded file could not be removed.");
        }
        throw error;
    }
}

export function deleteStoredDocumentMetadata(itemId) {
    const transaction = db.transaction(() => {
        const document = getStoredDocument(itemId, { includeTrashed: true });
        if (!document?.trashed_at) return null;
        db.prepare("DELETE FROM documents WHERE item_id = ?").run(itemId);
        db.prepare("DELETE FROM items WHERE id = ? AND trashed_at IS NOT NULL").run(itemId);
        return document;
    });
    return transaction();
}

export async function removeStoredDocumentFile(document) {
    if (!document?.storage_path) return;
    await unlink(getSafeStoragePath(document.storage_path));
}

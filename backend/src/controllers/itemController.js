import {
    createItem,
    deleteItemById,
    getFilteredItems,
    getItemById,
    getTrashedItems,
    permanentlyDeleteItemById,
    restoreItemById,
    toggleFavoriteById,
    updateItemById,
} from "../repositories/itemRepository.js";
import { getStoredDocument, removeStoredDocumentFile } from "../repositories/documentRepository.js";
import { deleteItemChunks } from "../repositories/chunkRepository.js";
import { indexKnowledgeItem } from "../services/retrievalService.js";

const VALID_SOURCE_TYPES = new Set(["note", "url", "document"]);
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_URL_LENGTH = 2_000;

function isValidHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

function validItemId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

export function addItem(req, res, next) {
    try {
        const { title, content, sourceType, sourceUrl } = req.body;
        if (typeof title !== "string" || !title.trim() ||
            title.trim().length > MAX_TITLE_LENGTH) {
            return res.status(400).json({ success: false, message: "Title (up to 200 characters) is required." });
        }
        if (!VALID_SOURCE_TYPES.has(sourceType)) {
            return res.status(400).json({ success: false, message: "sourceType must be note, url, or document." });
        }
        if (sourceType === "note") {
            if (typeof content !== "string" || !content.trim() || content.length > MAX_CONTENT_LENGTH) {
                return res.status(400).json({ success: false, message: "Content (up to 100,000 characters) is required for notes." });
            }
        }
        if (sourceType === "url") {
            if (typeof sourceUrl !== "string" || sourceUrl.length > MAX_URL_LENGTH || !isValidHttpUrl(sourceUrl)) {
                return res.status(400).json({ success: false, message: "A valid HTTP or HTTPS URL is required." });
            }
        }
        if (sourceType === "document") {
            return res.status(400).json({ success: false, message: "Use the document upload endpoint (/api/documents) to save documents." });
        }

        const resolvedContent = (typeof content === "string" && content.trim())
            ? content.trim()
            : (sourceType === "url" ? sourceUrl.trim() : "");

        const item = createItem({
            title: title.trim(),
            content: resolvedContent,
            sourceType,
            sourceUrl: sourceType === "url" ? sourceUrl.trim() : null,
        });
        indexKnowledgeItem(item).catch(() => {});
        return res.status(201).json({ success: true, message: "Item saved successfully.", data: item });
    } catch (error) {
        next(error);
    }
}

export function listItems(req, res, next) {
    try {
        const type = typeof req.query.type === "string" ? req.query.type : "all";
        const searchText = typeof req.query.search === "string" ? req.query.search : "";
        if (!["all", "note", "url", "document", "favorites"].includes(type) || searchText.length > 200) {
            return res.status(400).json({ success: false, message: "Invalid item filter." });
        }
        const items = getFilteredItems(type, searchText);
        return res.status(200).json({ success: true, count: items.length, data: items });
    } catch (error) {
        next(error);
    }
}

export function getItem(req, res, next) {
    try {
        const id = validItemId(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid item id." });
        const item = getItemById(id);
        if (!item) return res.status(404).json({ success: false, message: "Item not found." });
        return res.json({ success: true, data: item });
    } catch (error) {
        next(error);
    }
}

export function updateItem(req, res, next) {
    try {
        const id = validItemId(req.params.id);
        const { title, content, sourceType, sourceUrl } = req.body;
        if (!id) return res.status(400).json({ success: false, message: "Invalid item id." });
        if (typeof title !== "string" || !title.trim() ||
            title.trim().length > MAX_TITLE_LENGTH ||
            !VALID_SOURCE_TYPES.has(sourceType)) {
            return res.status(400).json({ success: false, message: "A valid title and source type are required." });
        }
        if (sourceType === "url" &&
            (typeof sourceUrl !== "string" || sourceUrl.length > MAX_URL_LENGTH || !isValidHttpUrl(sourceUrl))) {
            return res.status(400).json({ success: false, message: "A valid HTTP or HTTPS URL is required." });
        }
        if (sourceType === "note" && (typeof content !== "string" || !content.trim() || content.length > MAX_CONTENT_LENGTH)) {
            return res.status(400).json({ success: false, message: "Content is required for notes." });
        }
        const existing = getItemById(id);
        if (!existing) return res.status(404).json({ success: false, message: "Item not found." });

        const resolvedContent = (typeof content === "string" && content.trim())
            ? content.trim()
            : (sourceType === "url" ? sourceUrl.trim() : existing.content);

        const item = updateItemById(id, {
            title: title.trim(),
            content: resolvedContent,
            sourceType,
            sourceUrl: sourceType === "url" ? sourceUrl.trim() : null,
        });
        if (!item) return res.status(404).json({ success: false, message: "Item not found." });
        indexKnowledgeItem(item).catch(() => {});
        return res.json({ success: true, data: item });
    } catch (error) {
        next(error);
    }
}

export function deleteItem(req, res, next) {
    try {
        const id = validItemId(req.params.id);
        const { sourceType } = req.body || {};
        if (!id) return res.status(400).json({ success: false, message: "Invalid item id." });
        if (sourceType !== undefined && !VALID_SOURCE_TYPES.has(sourceType)) {
            return res.status(400).json({ success: false, message: "sourceType must be note, url, or document." });
        }
        const result = deleteItemById(id, sourceType);
        if (!result.changes) return res.status(404).json({ success: false, message: "Item not found." });
        return res.json({ success: true, message: "Item moved to Trash." });
    } catch (error) {
        next(error);
    }
}

export function toggleFavorite(req, res, next) {
    try {
        const id = validItemId(req.params.id);
        const { favorite } = req.body;
        if (!id) return res.status(400).json({ success: false, message: "Invalid item id." });
        if (typeof favorite !== "boolean") {
            return res.status(400).json({ success: false, message: "favorite must be a boolean." });
        }
        const item = toggleFavoriteById(id, favorite);
        if (!item) return res.status(404).json({ success: false, message: "Item not found." });
        return res.json({ success: true, data: item });
    } catch (error) {
        next(error);
    }
}

export function listTrash(req, res, next) {
    try {
        const items = getTrashedItems();
        return res.json({ success: true, count: items.length, data: items });
    } catch (error) {
        next(error);
    }
}

export function restoreItem(req, res, next) {
    try {
        const id = validItemId(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid item id." });
        const item = restoreItemById(id);
        if (!item) return res.status(404).json({ success: false, message: "Trashed item not found." });
        return res.json({ success: true, data: item });
    } catch (error) {
        next(error);
    }
}

export async function permanentlyDeleteItem(req, res, next) {
    try {
        const id = validItemId(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid item id." });
        const document = getStoredDocument(id, { includeTrashed: true });
        const result = permanentlyDeleteItemById(id);
        if (!result.changes) return res.status(404).json({ success: false, message: "Trashed item not found." });
        deleteItemChunks(id);
        if (document?.storage_path) await removeStoredDocumentFile(document);
        return res.json({ success: true, message: "Item permanently deleted." });
    } catch (error) {
        next(error);
    }
}

import path from "node:path";
import { getStoredDocument, createUploadedDocument, getStoredDocumentPath } from "../repositories/documentRepository.js";
import { extractDocumentText, getExpectedMimeTypes, getSupportedExtensions } from "../services/documentProcessor.js";
import { getItemById, importTextDocument } from "../repositories/itemRepository.js";
import { indexKnowledgeItem } from "../services/retrievalService.js";

const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_FILE_SIZE = Number(process.env.DOCUMENT_MAX_UPLOAD_BYTES || DEFAULT_MAX_FILE_SIZE);
const MAX_FILENAME_LENGTH = 255;
const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream"]);

if (!Number.isSafeInteger(MAX_FILE_SIZE) || MAX_FILE_SIZE < 1 || MAX_FILE_SIZE > 100 * 1024 * 1024) {
    throw new Error("DOCUMENT_MAX_UPLOAD_BYTES must be an integer between 1 and 104857600.");
}

function validateFileName(fileName) {
    return typeof fileName === "string" &&
        fileName.length > 0 &&
        fileName.length <= MAX_FILENAME_LENGTH &&
        !/[\\/\x00-\x1f\x7f]/.test(fileName) &&
        fileName !== "." &&
        fileName !== "..";
}

export function getDocumentUploadConfig(req, res) {
    return res.json({
        success: true,
        data: {
            maxFileSize: MAX_FILE_SIZE,
            extensions: getSupportedExtensions(),
        },
    });
}

export function validateDocumentUploadFile(file, callback) {
    if (!validateFileName(file.originalname)) {
        callback(Object.assign(new Error("Provide a valid document filename."), { statusCode: 400 }));
        return;
    }
    const extension = path.extname(file.originalname).toLowerCase();
    const expectedTypes = getExpectedMimeTypes(extension);
    if (!expectedTypes) {
        callback(Object.assign(new Error("This file extension is not supported."), { statusCode: 415 }));
        return;
    }
    if (!GENERIC_MIME_TYPES.has(file.mimetype.toLowerCase()) &&
        !expectedTypes.includes(file.mimetype.toLowerCase())) {
        callback(Object.assign(new Error("The file MIME type does not match its filename extension."), { statusCode: 415 }));
        return;
    }
    callback(null, true);
}

export async function uploadDocument(req, res, next) {
    try {
        if (!req.file || !req.file.buffer.length) {
            return res.status(400).json({ success: false, message: "Choose a non-empty file to upload." });
        }
        const extension = path.extname(req.file.originalname).toLowerCase();
        let extractedText;
        try {
            extractedText = await extractDocumentText(extension, req.file.buffer);
        } catch (error) {
            return res.status(422).json({
                success: false,
                message: error.message || "The file could not be safely validated or processed.",
            });
        }

        const title = (typeof req.body?.title === "string" && req.body.title.trim())
            ? req.body.title.trim()
            : null;
        const description = (typeof req.body?.description === "string" && req.body.description.trim())
            ? req.body.description.trim()
            : (typeof req.body?.content === "string" && req.body.content.trim())
                ? req.body.content.trim()
                : "";

        const { itemId } = await createUploadedDocument({
            fileName: req.file.originalname,
            extension,
            mimeType: req.file.mimetype || "application/octet-stream",
            buffer: req.file.buffer,
            extractedText,
            title,
            description,
        });
        const item = getItemById(itemId);
        indexKnowledgeItem(item).catch(() => {});
        return res.status(201).json({ success: true, data: item });
    } catch (error) {
        next(error);
    }
}

export function getDocumentDetails(req, res, next) {
    try {
        const itemId = Number(req.params.id);
        if (!Number.isInteger(itemId) || itemId < 1) {
            return res.status(400).json({ success: false, message: "Invalid document ID." });
        }
        const document = getStoredDocument(itemId);
        if (!document) return res.status(404).json({ success: false, message: "Document not found." });
        return res.json({
            success: true,
            data: {
                id: document.file_id || String(document.id),
                itemId: document.item_id,
                fileName: document.file_name,
                fileType: document.file_type,
                mimeType: document.mime_type || document.file_type,
                fileSize: document.file_size,
                storageLocation: document.storage_path,
                uploadedAt: document.uploaded_at || document.created_at,
                processingStatus: document.processing_status || document.status,
                extractedText: document.extracted_text ?? document.content,
            },
        });
    } catch (error) {
        next(error);
    }
}

export function downloadDocument(req, res, next) {
    try {
        const itemId = Number(req.params.id);
        if (!Number.isInteger(itemId) || itemId < 1) {
            return res.status(400).json({ success: false, message: "Invalid document ID." });
        }
        const document = getStoredDocument(itemId);
        if (!document?.storage_path) {
            return res.status(404).json({ success: false, message: "Original file is unavailable for this document." });
        }
        const storedPath = getStoredDocumentPath(document.storage_path);
        res.download(storedPath, document.file_name, {
            headers: { "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" },
        }, (error) => {
            if (error) next(error);
        });
    } catch (error) {
        next(error);
    }
}

export function importDocument(req, res, next) {
    try {
        const { fileName, content } = req.body;
        if (!validateFileName(fileName) || /[\\/]/.test(fileName)) {
            return res.status(400).json({ success: false, message: "Provide a valid document file name." });
        }
        const extension = path.extname(fileName).toLowerCase();
        const fileType = getExpectedMimeTypes(extension)?.[0];
        if (![".txt", ".md", ".csv"].includes(extension)) {
            return res.status(415).json({ success: false, message: "This legacy text-import route accepts only TXT, Markdown, and CSV files." });
        }
        if (typeof content !== "string" || !content.trim()) {
            return res.status(400).json({ success: false, message: "The document contains no readable text." });
        }
        const fileSize = Buffer.byteLength(content, "utf8");
        if (fileSize > MAX_FILE_SIZE) {
            return res.status(413).json({ success: false, message: `Documents must be ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB or smaller.` });
        }
        const title = fileName.replace(/\.[^.]+$/, "");
        const item = importTextDocument({ title, fileName, fileType, fileSize, content });
        indexKnowledgeItem(item).catch(() => {});
        return res.status(201).json({ success: true, data: item });
    } catch (error) {
        next(error);
    }
}

export function documentUploadError(error, req, res, next) {
    if (error instanceof Error && error.name === "MulterError") {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        const message = error.code === "LIMIT_FILE_SIZE"
            ? `File exceeds the ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB upload limit.`
            : error.message;
        return res.status(status).json({ success: false, message });
    }
    if (error?.statusCode) {
        return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return next(error);
}

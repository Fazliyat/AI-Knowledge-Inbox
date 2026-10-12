import { Router } from "express";
import multer from "multer";
import {
    documentUploadError,
    downloadDocument,
    getDocumentDetails,
    getDocumentUploadConfig,
    importDocument,
    uploadDocument,
    validateDocumentUploadFile,
} from "../controllers/documentController.js";

const router = Router();
const maxFileSize = Number(process.env.DOCUMENT_MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSize, files: 1, fields: 10 },
    fileFilter: (req, file, callback) => validateDocumentUploadFile(file, callback),
});

router.get("/config", getDocumentUploadConfig);
router.post("/import-text", importDocument);
router.post("/", upload.single("file"), uploadDocument, documentUploadError);
router.get("/:id/download", downloadDocument);
router.get("/:id", getDocumentDetails);

export default router;

import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
import * as XLSX from "@e965/xlsx";
import { load } from "cheerio";

export const MAX_EXTRACTED_TEXT_LENGTH = 1_000_000;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_UNCOMPRESSED_SIZE = 50 * 1024 * 1024;

const MIME_TYPES = new Map([
    [".pdf", ["application/pdf"]],
    [".doc", ["application/msword"]],
    [".docx", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip"]],
    [".txt", ["text/plain"]],
    [".md", ["text/markdown", "text/x-markdown", "text/plain"]],
    [".csv", ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"]],
    [".xls", ["application/vnd.ms-excel", "application/xls"]],
    [".xlsx", ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip"]],
    [".json", ["application/json", "text/json", "text/plain"]],
    [".xml", ["application/xml", "text/xml", "text/plain"]],
    [".ppt", ["application/vnd.ms-powerpoint"]],
    [".pptx", ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip"]],
    [".png", ["image/png"]],
    [".jpg", ["image/jpeg"]],
    [".jpeg", ["image/jpeg"]],
    [".webp", ["image/webp"]],
    [".mp3", ["audio/mpeg", "audio/mp3"]],
    [".wav", ["audio/wav", "audio/x-wav", "audio/wave"]],
    [".m4a", ["audio/mp4", "audio/x-m4a"]],
    [".mp4", ["video/mp4"]],
    [".webm", ["video/webm"]],
    [".zip", ["application/zip", "application/x-zip-compressed"]],
]);

function decodeText(buffer) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (text.includes("\0")) throw new Error("The file is not valid UTF-8 text.");
    return text;
}

function assertSignature(extension, buffer) {
    const startsWith = (...bytes) => bytes.every((byte, index) => buffer[index] === byte);
    const isZip = startsWith(0x50, 0x4b, 0x03, 0x04) ||
        startsWith(0x50, 0x4b, 0x05, 0x06) ||
        startsWith(0x50, 0x4b, 0x07, 0x08);
    const isOle = startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

    if (extension === ".pdf" && !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
        throw new Error("The file contents do not match a PDF file.");
    }
    if ([".doc", ".xls", ".ppt"].includes(extension) && !isOle) {
        throw new Error("The file contents do not match this legacy Microsoft Office format.");
    }
    if ([".docx", ".xlsx", ".pptx", ".zip"].includes(extension) && !isZip) {
        throw new Error("The file contents do not match a ZIP-based file format.");
    }
    if (extension === ".png" && !startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
        throw new Error("The file contents do not match a PNG image.");
    }
    if ([".jpg", ".jpeg"].includes(extension) && !startsWith(0xff, 0xd8, 0xff)) {
        throw new Error("The file contents do not match a JPEG image.");
    }
    if (extension === ".webp" &&
        (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP")) {
        throw new Error("The file contents do not match a WEBP image.");
    }
    if (extension === ".wav" &&
        (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")) {
        throw new Error("The file contents do not match a WAV file.");
    }
    if (extension === ".m4a" && buffer.toString("ascii", 4, 8) !== "ftyp") {
        throw new Error("The file contents do not match an M4A audio file.");
    }
    if (extension === ".mp4" && buffer.toString("ascii", 4, 8) !== "ftyp") {
        throw new Error("The file contents do not match an MP4 video.");
    }
    if (extension === ".webm" && !startsWith(0x1a, 0x45, 0xdf, 0xa3)) {
        throw new Error("The file contents do not match a WEBM video.");
    }
    if (extension === ".mp3" && !startsWith(0x49, 0x44, 0x33) &&
        !(buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
        throw new Error("The file contents do not match an MP3 audio file.");
    }
}

function decodeXmlText(xml, tagPattern) {
    return [...xml.matchAll(tagPattern)]
        .map((match) => load(`<root>${match[1]}</root>`, { xmlMode: true }).text())
        .join(" ");
}

async function loadOfficeArchive(buffer, extension) {
    let archive;
    try {
        archive = await JSZip.loadAsync(buffer);
    } catch {
        throw new Error("The Office document contains an invalid ZIP archive.");
    }
    const entries = Object.values(archive.files).filter((entry) => !entry.dir);
    const totalSize = entries.reduce((total, entry) => total + (entry._data?.uncompressedSize ?? 0), 0);
    if (entries.length > MAX_ARCHIVE_ENTRIES || totalSize > MAX_ARCHIVE_UNCOMPRESSED_SIZE) {
        throw new Error("The Office document expands beyond the safe processing limit.");
    }
    const requiredEntry = {
        ".docx": "word/document.xml",
        ".xlsx": "xl/workbook.xml",
        ".pptx": "ppt/presentation.xml",
    }[extension];
    if (requiredEntry && !archive.file(requiredEntry)) {
        throw new Error("The ZIP contents do not match the selected Office document format.");
    }
    return archive;
}

export function getExpectedMimeTypes(extension) {
    return MIME_TYPES.get(extension) ?? null;
}

export function getSupportedExtensions() {
    return [...MIME_TYPES.keys()];
}

export async function extractDocumentText(extension, buffer) {
    assertSignature(extension, buffer);
    let text = null;

    if ([".txt", ".md", ".csv", ".json", ".xml"].includes(extension)) {
        text = decodeText(buffer);
        if (extension === ".json") {
            try {
                JSON.parse(text);
            } catch {
                throw new Error("The file does not contain valid JSON.");
            }
        } else if (extension === ".xml") {
            text = load(text, { xmlMode: true }).text();
        }
    } else if (extension === ".pdf") {
        const parser = new PDFParse({ data: buffer, verbosity: 0 });
        try {
            text = (await parser.getText()).text;
        } finally {
            await parser.destroy();
        }
    } else if ([".docx", ".pptx"].includes(extension)) {
        const archive = await loadOfficeArchive(buffer, extension);
        if (extension === ".docx") {
            const documentXml = await archive.file("word/document.xml").async("string");
            text = decodeXmlText(documentXml, /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
        } else {
            const slidePaths = Object.keys(archive.files)
                .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
                .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
            const slideTexts = [];
            for (const slidePath of slidePaths) {
                const xml = await archive.file(slidePath).async("string");
                slideTexts.push(decodeXmlText(xml, /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g));
            }
            text = slideTexts.join("\n");
        }
    } else if ([".xls", ".xlsx"].includes(extension)) {
        if (extension === ".xlsx") await loadOfficeArchive(buffer, extension);
        let workbook;
        try {
            workbook = XLSX.read(buffer, { type: "buffer", dense: true, sheetRows: 50_000 });
        } catch {
            throw new Error("The spreadsheet could not be read. Verify that it is a valid XLS or XLSX file.");
        }
        text = workbook.SheetNames.map((name) => {
            const sheet = workbook.Sheets[name];
            return `${name}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
        }).join("\n\n");
    } else if ([".docx", ".xlsx", ".pptx"].includes(extension)) {
        await loadOfficeArchive(buffer, extension);
    } else if (extension === ".zip") {
        await loadOfficeArchive(buffer, extension);
    }

    if (text === null || !text.trim()) return null;
    if (text.length > MAX_EXTRACTED_TEXT_LENGTH) {
        throw new Error("Extracted text exceeds the 1 MB processing limit.");
    }
    return text;
}

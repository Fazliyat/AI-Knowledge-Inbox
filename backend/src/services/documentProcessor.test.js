import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import * as XLSX from "@e965/xlsx";
import { extractDocumentText } from "./documentProcessor.js";

function createPdf(text) {
    const stream = `BT /F1 18 Tf 50 700 Td (${text}) Tj ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let content = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(content));
        content += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(content);
    content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) content += `${String(offset).padStart(10, "0")} 00000 n \n`;
    content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(content, "ascii");
}

test("extracts text from PDF, DOCX, PPTX, XLS, and XLSX uploads", async () => {
    const pdfText = await extractDocumentText(".pdf", createPdf("PDF extraction marker"));
    assert.match(pdfText, /PDF extraction marker/);

    const docx = new JSZip();
    docx.file("word/document.xml", '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>DOCX extraction marker</w:t></w:r></w:p></w:body></w:document>');
    const docxText = await extractDocumentText(".docx", await docx.generateAsync({ type: "nodebuffer" }));
    assert.match(docxText, /DOCX extraction marker/);

    const pptx = new JSZip();
    pptx.file("ppt/presentation.xml", '<p:presentation xmlns:p="p"/>');
    pptx.file("ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>PPTX extraction marker</a:t></p:sld>');
    const pptxText = await extractDocumentText(".pptx", await pptx.generateAsync({ type: "nodebuffer" }));
    assert.match(pptxText, /PPTX extraction marker/);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([["value"], ["Spreadsheet extraction marker"]]),
        "Notes"
    );
    for (const bookType of ["biff8", "xlsx"]) {
        const extension = bookType === "biff8" ? ".xls" : ".xlsx";
        const bytes = XLSX.write(workbook, { type: "buffer", bookType });
        assert.match(await extractDocumentText(extension, bytes), /Spreadsheet extraction marker/);
    }
});

test("extracts validated text formats and rejects mismatched or malformed content", async () => {
    assert.equal(await extractDocumentText(".txt", Buffer.from("Plain text marker")), "Plain text marker");
    assert.equal(await extractDocumentText(".json", Buffer.from('{"key":"JSON marker"}')), '{"key":"JSON marker"}');
    assert.match(await extractDocumentText(".xml", Buffer.from("<root>XML marker</root>")), /XML marker/);
    await assert.rejects(extractDocumentText(".json", Buffer.from("{broken")), /valid JSON/);
    await assert.rejects(extractDocumentText(".pdf", Buffer.from("not a PDF")), /match a PDF/);
});

test("preserves image and generic ZIP uploads without claiming text extraction", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8xkAAAAASUVORK5CYII=", "base64");
    assert.equal(await extractDocumentText(".png", png), null);
    const archive = new JSZip();
    archive.file("readme.txt", "Do not treat arbitrary ZIP contents as analyzed text.");
    assert.equal(await extractDocumentText(".zip", await archive.generateAsync({ type: "nodebuffer" })), null);
});

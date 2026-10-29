import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { renderPdfToPngs } from "./pdf-render.js";
it("renders the correct color and one-based page names using real PDFium", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-raster-"));
    try {
        const stream = "1 0 0 rg 0 0 72 72 re f\n";
        const objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>",
            `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
        ];
        let pdf = "%PDF-1.4\n";
        const offsets = [0];
        for (const [index, value] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${value}\nendobj\n`; }
        const xref = pdf.length;
        pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        const input = join(root, "red.pdf");
        await writeFile(input, pdf);
        const { paths: pages, totalPages } = await renderPdfToPngs(input, root, { scale: 1, maxPages: 1 });
        expect(totalPages).toBe(1);
        expect(pages).toEqual([join(root, "red-p1.png")]);
        const { data, info } = await sharp(await readFile(pages[0])).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(info.width).toBe(72);
        expect([...data.subarray(0, 3)]).toEqual([255, 0, 0]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

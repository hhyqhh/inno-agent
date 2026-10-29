import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { excelJsToUniver, univerSnapshotToXlsxBytes, univerToExcelJs } from "./univer-xlsx.js";

async function workbookFromRows(rows: ExcelJS.CellValue[][]): Promise<ExcelJS.Workbook> {
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("统计");
	rows.forEach((cells, i) => ws.addRow(cells));
	return wb;
}

describe("univer-xlsx converter", () => {
	it("round-trips values, types and formulas", async () => {
		const wb = await workbookFromRows([
			["名称", "数量", "达标"],
			["甲班", 3, true],
			["乙班", 4, false],
		]);
		const ws = wb.getWorksheet("统计")!;
		ws.getCell("C2").value = { formula: "B2>2", result: true };

		const snapshot = excelJsToUniver(wb, "test.xlsx");
		const sheet = snapshot.sheets[snapshot.sheetOrder[0]];
		expect(sheet.cellData[0][0]).toEqual({ v: "名称", t: 1 });
		expect(sheet.cellData[1][1]).toEqual({ v: 3, t: 2 });
		expect(sheet.cellData[1][2]).toMatchObject({ v: 1, t: 3, f: "=B2>2" });

		const back = univerToExcelJs(snapshot, "test.xlsx");
		const backWs = back.getWorksheet("统计")!;
		expect(backWs.getCell("A1").value).toBe("名称");
		expect(backWs.getCell("B2").value).toBe(3);
		expect(backWs.getCell("C2").value).toMatchObject({ formula: "B2>2", result: true });
	});

	it("round-trips bold, fill, alignment, number format and borders", async () => {
		const wb = new ExcelJS.Workbook();
		const ws = wb.addWorksheet("样式");
		const b2 = ws.getCell("B2");
		b2.value = 99;
		b2.font = { bold: true, italic: true, size: 14, name: "Arial", color: { argb: "FFFF0000" } };
		b2.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
		b2.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
		b2.numFmt = "0.00";
		b2.border = {
			top: { style: "thin", color: { argb: "FF000000" } },
			bottom: { style: "double", color: { argb: "FF000000" } },
		};

		const snapshot = excelJsToUniver(wb, "s.xlsx");
		const sheet = snapshot.sheets[snapshot.sheetOrder[0]];
		const style = sheet.cellData[1][1].s as import("./univer-xlsx.js").UniverStyle;
		expect(style).toMatchObject({
			bl: 1,
			it: 1,
			fs: 14,
			ff: "Arial",
			cl: { rgb: "#FF0000" },
			bg: { rgb: "#FFFF00" },
			ht: 2,
			vt: 2,
			tb: 3,
			n: { pattern: "0.00" },
		});
		expect(style?.bd?.t).toMatchObject({ s: 1 });
		expect(style?.bd?.b).toMatchObject({ s: 7 });

		// Back to xlsx bytes, reparse, assert the styles survived the round trip.
		const bytes = await univerSnapshotToXlsxBytes(snapshot, "s.xlsx");
		const reparsed = new ExcelJS.Workbook();
		await reparsed.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		const back = reparsed.getWorksheet("样式")!.getCell("B2");
		expect(back.value).toBe(99);
		expect(back.font).toMatchObject({ bold: true, italic: true, size: 14, name: "Arial" });
		expect(back.font.color?.argb).toBe("FFFF0000");
		expect((back.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFFF00");
		expect(back.alignment).toMatchObject({ horizontal: "center", vertical: "middle", wrapText: true });
		expect(back.numFmt).toBe("0.00");
		expect(back.border?.top?.style).toBe("thin");
		expect(back.border?.bottom?.style).toBe("double");
	});

	it("resolves string style ids through the workbook style registry", () => {
		const snapshot = {
			id: "wb",
			name: "t.xlsx",
			sheetOrder: ["sheet-1"],
			styles: { s1: { bl: 1, bg: { rgb: "#FFFF00" } } },
			sheets: {
				"sheet-1": {
					id: "sheet-1",
					name: "S",
					rowCount: 100,
					columnCount: 26,
					cellData: { 0: { 0: { v: "x", t: 1, s: "s1" } } },
				},
			},
		};
		const wb = univerToExcelJs(snapshot as never, "t.xlsx");
		const cell = wb.getWorksheet("S")!.getCell("A1");
		expect(cell.font?.bold).toBe(true);
		expect((cell.fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe("FFFFFF00");
	});

	it("preserves merges and column widths", async () => {
		const wb = new ExcelJS.Workbook();
		const ws = wb.addWorksheet("S");
		ws.mergeCells(1, 1, 1, 2);
		ws.getCell("A1").value = "merged";
		ws.getColumn(1).width = 20;
		ws.getColumn(2).width = 15.5;

		const snapshot = excelJsToUniver(wb, "m.xlsx");
		const sheet = snapshot.sheets[snapshot.sheetOrder[0]];
		expect(sheet.mergeData).toEqual([{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }]);
		expect(sheet.columnData?.[0]?.w).toBe(145);

		const back = univerToExcelJs(snapshot, "m.xlsx");
		const backWs = back.getWorksheet("S")!;
		expect(backWs.model.merges).toEqual(["A1:B1"]);
		expect(backWs.getColumn(1).width).toBeCloseTo(20, 5);
		expect(backWs.getCell("A1").value).toBe("merged");
	});

	it("keeps multi-sheet order and produces valid xlsx bytes", async () => {
		const wb = new ExcelJS.Workbook();
		wb.addWorksheet("第一个").addRow(["一"]);
		wb.addWorksheet("第二个").addRow(["二"]);

		const snapshot = excelJsToUniver(wb, "multi.xlsx");
		expect(snapshot.sheetOrder).toHaveLength(2);

		const bytes = await univerSnapshotToXlsxBytes(snapshot, "multi.xlsx");
		const reparsed = new ExcelJS.Workbook();
		await reparsed.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		expect(reparsed.worksheets.map((s) => s.name)).toEqual(["第一个", "第二个"]);
		expect(reparsed.getWorksheet("第二个")!.getCell("A1").value).toBe("二");
	});

	it("rejects huge ranges without silently dropping data", async () => {
		const wb = new ExcelJS.Workbook();
		const ws = wb.addWorksheet("big");
		ws.getCell("ZZ100000").value = "x";
		expect(() => excelJsToUniver(wb, "big.xlsx")).toThrow("exceeds editor limits");
	});
    it("preserves numeric dates and fractional days across real xlsx serialization", async () => {
        const wb = new ExcelJS.Workbook();
        wb.properties.date1904 = true;
        const ws = wb.addWorksheet("Dates");
        const date = new Date("2026-10-26T12:00:00Z");
        ws.getCell("A1").value = date;
        ws.getCell("A1").numFmt = "yyyy-mm-dd hh:mm";
        const snapshot = excelJsToUniver(wb, "dates.xlsx");
        expect(typeof snapshot.sheets["sheet-1"].cellData[0][0].v).toBe("number");
        const bytes = await univerSnapshotToXlsxBytes(snapshot, "dates.xlsx");
        const back = new ExcelJS.Workbook();
        await back.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        expect(back.getWorksheet("Dates")!.getCell("A1").value).toEqual(date);
    });
    it("keeps text entered as a rich Univer cell", async () => {
        const wb = await workbookFromRows([["old"]]);
        const snapshot = excelJsToUniver(wb, "rich.xlsx");
        snapshot.sheets["sheet-1"].cellData[0][0] = { p: { body: { dataStream: "new rich text\r\n" } } };
        const back = univerToExcelJs(snapshot, "rich.xlsx");
        expect(back.worksheets[0].getCell("A1").value).toBe("new rich text");
    });

});

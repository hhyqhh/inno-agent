import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { validateWordExport } from "./validate-word-export.js";
const encode = (text: string) => new Uint8Array(strToU8(text));
const exported = (xml: string) => zipSync({ "word/document.xml": encode(xml), "[Content_Types].xml": encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') }).slice().buffer as ArrayBuffer;
describe("Word export validation", () => {
 it("accepts well formed document XML", () => {
  expect(() => validateWordExport(exported('<w:document xmlns:w="urn:word"><w:body/></w:document>'))).not.toThrow();
 });
 it("rejects duplicate expanded attributes even with different namespace prefixes", () => {
  expect(() => validateWordExport(exported('<w:document xmlns:w="urn:word" xmlns:mc="urn:compat" xmlns:ns1="urn:compat" ns1:Ignorable="w14" mc:Ignorable="w14"/>'))).toThrow("WORD_EDITOR_INVALID_EXPORT");
 });
 it("rejects malformed XML and packages without a document", () => {
  expect(() => validateWordExport(exported('<document>'))).toThrow("WORD_EDITOR_INVALID_EXPORT");
  expect(() => validateWordExport(zipSync({}).buffer as ArrayBuffer)).toThrow("WORD_EDITOR_INVALID_EXPORT");
 });
});

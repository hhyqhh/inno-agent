import { unzipSync } from "fflate";

/** Refuse malformed engine output before it can replace a workspace original. */
export function validateWordExport(buffer: ArrayBuffer): void {
 let expandedBytes = 0;
 const parts = unzipSync(new Uint8Array(buffer), { filter: (file) => {
  if (!/\.(?:xml|rels)$/i.test(file.name)) return false;
  expandedBytes += file.originalSize;
  if (expandedBytes > 64 * 1024 * 1024) throw new Error("WORD_EDITOR_INVALID_EXPORT");
  return true;
 } });
 if (!parts["word/document.xml"] || !parts["[Content_Types].xml"]) throw new Error("WORD_EDITOR_INVALID_EXPORT");
 const parser = new DOMParser();
 const decoder = new TextDecoder("utf-8", { fatal: true });
 // BetterOffice 0.4.3 can preserve ns1:Ignorable and add mc:Ignorable
 // for the same namespace. Its own importer accepts this invalid XML,
 // so a successful editor round trip is insufficient validation.
 for (const bytes of Object.values(parts)) {
  const xml = parser.parseFromString(decoder.decode(bytes), "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("WORD_EDITOR_INVALID_EXPORT");
 }
}

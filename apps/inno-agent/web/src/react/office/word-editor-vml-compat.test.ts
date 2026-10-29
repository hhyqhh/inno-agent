import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { patchWordEditorVml } from "./word-editor-vml-compat.js";
import { worksheetShapes, worksheetPart } from "./word-editor-vml-fixture.js";
let engine: any;
const chunk = "node_modules/@docx-editor.dev/core/dist/chunk-GWM3AKUD.js";
beforeAll(async () => {
 const result = await build({ entryPoints:[chunk], bundle:true, platform:"node", format:"esm", write:false, plugins:[{name:"vml-test",setup(b){
 b.onLoad({filter:/chunk-GWM3AKUD\.js$/},async({path})=>({contents:await patchWordEditorVml(await readFile(path,"utf8"),path)+"\nexport { se as parse, hv as parseAsync, xj as project, is as drawing };",loader:"js"}));
 }}]});
 engine=await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});
function source(xml:string){ const result=engine.parse(xml,{name:"/worksheet.xml",contentType:"application/xml"}); expect(result.ok).toBe(true);return result.part.root; }
function pictures(root:any):any[]{return root.localName==="pict"?[root]:(root.children??[]).flatMap(pictures);}
describe("pinned Word VML compatibility",()=>{
 it("projects the worksheet's triangle, oval and cloud while preserving original OOXML",()=>{
  for(const [index,xml] of worksheetShapes.slice(0,3).entries()){
   const root=source(xml),before=JSON.stringify(root), result=engine.project(root);
   expect(result, `shape ${index}`).not.toBeNull();
   const svg=result.legacyGraphic.fragments.join("");
   expect(svg).toContain(index===1?"<ellipse":"<path");
   expect(svg).toContain('stroke="#2e54a1"');
   expect(svg).toContain('fill="none"');
   expect(svg).not.toMatch(/NaN|Infinity|undefined/);
   if(index===0)expect(svg).toContain("Z");
   if(index===2){expect(svg).toContain("C"); expect(svg.match(/<path/g)!.length).toBeGreaterThan(1);}
   expect(JSON.stringify(root)).toBe(before);
  }
 });
 it("projects all 12 pictures, including cross-pict templates and EMU-scale stars",()=>{
  const root=source(worksheetPart),before=JSON.stringify(root),picts=pictures(root);
  expect(picts).toHaveLength(12);
  const elements=["path","ellipse","path","path","rect","path","path","ellipse","path","path","rect","path"];
  for(const [i,pict] of picts.entries()){
   const drawing=engine.drawing(pict,"/worksheet.xml");
   expect(drawing,`picture ${i}`).not.toBeNull();
   const svg=drawing.legacyGraphic.fragments.join("");
   expect(svg).toContain(`<${elements[i]}`);
   expect(svg).toContain('stroke="#2e54a1"');
   expect(svg).not.toMatch(/NaN|Infinity|undefined/);
   if([3,9].includes(i))expect(svg.match(/L/g)).toHaveLength(9);
   if([5,6,11].includes(i))expect(svg).toContain("Z");
  }
  expect(JSON.stringify(root)).toBe(before);
 });
 it("indexes shared templates in the large-part incremental parser too",()=>{
  const xml=worksheetPart.replace("<w:body>",`<w:body><w:p><w:r><w:t>${"x".repeat(2_000_000)}</w:t></w:r></w:p>`);
  const parser=engine.parseAsync(xml,{name:"/large.xml",contentType:"application/xml"});
  let step=parser.next();while(!step.done)step=parser.next();
  expect(step.value.ok).toBe(true);
  expect(pictures(step.value.part.root).map(pict=>!!engine.drawing(pict,"/large.xml"))).toEqual(Array(12).fill(true));
 });
 it("keeps template scope isolated between parts and rejects unreasonable normalized geometry",()=>{
  source(worksheetPart);
  expect(engine.project(source(worksheetShapes[5]))).toBeNull();
  const duplicated=source(worksheetPart.replace("</w:body>",`<w:p><w:r>${worksheetShapes[0]}</w:r></w:p></w:body>`));
  expect(engine.project(pictures(duplicated)[5])).toBeNull();
  const star=worksheetShapes[3];
  expect(engine.project(source(star))).not.toBeNull();
  expect(engine.project(source(star.replace('1152525,1038225','0.000000001,0.000000001')))).toBeNull();
  expect(engine.project(source(star.replace('1152525,1038225','Infinity,1038225')))).toBeNull();
 });
 it("rejects malformed paths, invalid formulas and active content",()=>{
  const xml=worksheetShapes[0];
  for(const bad of [xml.replace('m@0,l,21600r21600,xe','m@999,l,21600xe'),xml.replace('m@0,l,21600r21600,xe','m0,0evil1,1'),xml.replace('val #0','prod 1 1 0'),xml.replace('strokecolor=', 'href="javascript:alert(1)" strokecolor=')]){
   expect(engine.project(source(bad))).toBeNull();
  }
 });
 it("refuses dependency drift and is idempotent",async()=>{
  expect(await patchWordEditorVml("other","/other.js")).toBeNull();
  await expect(patchWordEditorVml("new upstream",chunk)).rejects.toThrow("no longer matches");
  const patched=await patchWordEditorVml(await readFile(chunk,"utf8"),chunk);
  expect(await patchWordEditorVml(patched!,chunk)).toBe(patched);
 });
});

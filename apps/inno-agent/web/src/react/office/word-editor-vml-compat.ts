/** Extend the pinned legacy SVG projector, without converting or rewriting DOCX.
 * The worksheet's triangle uses an adjustment/formula template and its cloud
 * uses relative cubic curves. Later shapes reuse a template from a different
 * pict, and the star uses an EMU-sized coordinate system. Resolve templates
 * per XML part and normalize geometry independently of its coordinate scale.
 */
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const CHUNK = "/@docx-editor.dev/core/dist/chunk-GWM3AKUD.js";
const MARK = "function innoVmlShape";
// Compile the small, bounded coordinate parser into the dependency's module.
// It has no imports; the SVG remains owned by the existing legacy projector.
const parserSource = readFile(new URL("./word-editor-vml-path.ts", import.meta.url), "utf8");
let parser: Promise<string> | undefined;
const projection = `
// Word scopes shapetype IDs to the XML part, not an individual w:pict. Keep a
// derived weak index so separately opened documents cannot share templates;
// never attach projection metadata to the original, saved OOXML tree.
const innoVmlTemplates=new WeakMap();
function innoIndexVmlTemplates(root) {
 let templates=new Map(),pictures=[],pending=[root];
 while(pending.length){let node=pending.pop();
  if(te(node,de,"shapetype")){let id=S(node,"id");if(id)templates.set(id,templates.has(id)?null:node);}
  if(te(node,O,"pict"))pictures.push(node);
  if(node.children)for(let child of node.children)if(child.kind!=="textValue")pending.push(child);
 }
 if(templates.size)for(let pict of pictures)innoVmlTemplates.set(pict,templates);
 return root;
}
function innoVmlTemplate(e) {
 if(!te(e,de,"shapetype")||!S(e,"path")||!qf(e))return false;
 return Ee(e).every(n=>n.namespaceUri===de&&["stroke","path","formulas","handles"].includes(n.localName)&&
  (n.localName==="formulas"?Ee(n).every(f=>te(f,de,"f")&&!Ee(f).length):n.localName==="handles"?Ee(n).every(h=>te(h,de,"h")&&!Ee(h).length):!Ee(n).length));
}
function innoVmlShape(e,pict) {
 if(!te(e,de,"shape"))return e;
 let type=S(e,"type"),templates=innoVmlTemplates.get(pict),template=type?(templates?.has(type.slice(1))?templates.get(type.slice(1)):Ee(pict).find(n=>te(n,de,"shapetype")&&"#"+S(n,"id")===type)):undefined;
 if(type&&!type.startsWith("#"))return e;
 if(type&&(!template||!innoVmlTemplate(template)))return e;
 let path=S(e,"path")??(template&&S(template,"path"));
 if(!path)return e;
 try {
  const coords=(S(e,"coordsize")??(template&&S(template,"coordsize"))??"21600,21600").split(",").map(Number),origin=(S(e,"coordorigin")??"0,0").split(",").map(Number);
  // coordsize is an arbitrary local scale (the worksheet star is 1152525 by
  // 1038225). Bound finite arithmetic, not the author's choice of units.
  if(coords.length!==2||origin.length!==2||![...coords,...origin].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e12)||coords.some(n=>n<=0))return e;
  let formulas=Ee(e).find(n=>te(n,de,"formulas"))??(template&&Ee(template).find(n=>te(n,de,"formulas")));
  let resolve=vmlFormulaResolver(formulas?Ee(formulas).map(n=>S(n,"eqn")??""):[],S(e,"adj")??(template&&S(template,"adj"))??"",coords[0],coords[1]);
  let paths=parseVmlPath(path,resolve);
  return {...e,innoVmlPaths:paths,innoVmlCoords:coords,innoVmlOrigin:origin};
 }catch{return e;}
}
function innoVmlPaint(e,t) {
 if(!e.innoVmlPaths)return undefined;
 // Retain upstream paint/style validation. No text, image, links or arbitrary
 // XML is copied into SVG; only finite parsed coordinates and validated colors.
 if(Ee(e).some(n=>n.namespaceUri!==de||!["stroke","fill","path","formulas"].includes(n.localName)||n.localName!=="formulas"&&Ee(n).length))return null;
 let paint=Qf(e);if(!paint)return null;
 let join=S(paint.strokeNode??e,"joinstyle")??"miter";if(!["miter","round","bevel"].includes(join))return null;
 if(paint.strokeNode&&["startarrow","endarrow"].some(k=>![undefined,"none"].includes(S(paint.strokeNode,k))))return null;
 const [cw,ch]=e.innoVmlCoords,[ox,oy]=e.innoVmlOrigin;
 const point=p=>[t.x+(p[0]-ox)*t.width/cw,t.y+(p[1]-oy)*t.height/ch];
 if(e.innoVmlPaths.some(path=>path.commands.some(c=>c.points.some(p=>point(p).some(n=>!Number.isFinite(n)||Math.abs(n)>1e5)))))return null;
 return e.innoVmlPaths.map(path=>{
  let d=path.commands.map(c=>({moveTo:"M",lnTo:"L",cubicBezTo:"C",quadBezTo:"Q",close:"Z"}[c.kind])+c.points.map(p=>point(p).join(",")).join(" ")).join(" ");
  return '<path d="'+d+'" fill="'+(path.fill?paint.fill:"none")+'" stroke="'+(path.stroke?paint.stroke:"none")+'" stroke-width="'+paint.weight+'" stroke-linejoin="'+join+'"/>';
 }).join("");
}
`;

export async function patchWordEditorVml(code: string, id: string): Promise<string | null> {
	if (!id.replace(/\\/g, "/").split("?", 1)[0].endsWith(CHUNK)) return null;
	if (code.includes(MARK)) return code;
	const replacements: [string, string][] = [
		["let i=Vl(PV(o[0],new Bl,th(),t.name,\"0\",!1));", "let i=innoIndexVmlTemplates(Vl(PV(o[0],new Bl,th(),t.name,\"0\",!1)));"],
		["contentType:t.contentType,root:Vl(p)", "contentType:t.contentType,root:innoIndexVmlTemplates(Vl(p))"],
		["let i=o[0],a=!!(t??r);", "let i=innoVmlShape(o[0],e),a=!!(t??r);"],
		["te(ee,de,\"shapetype\")&&!Yf(ee)", "te(ee,de,\"shapetype\")&&!Yf(ee)&&!innoVmlTemplate(ee)"],
		["(u||[\"rect\",\"roundrect\",\"oval\"].includes(i.localName))?bR", "(u||i.innoVmlPaths||[\"rect\",\"roundrect\",\"oval\"].includes(i.localName))?bR"],
		["function Uh(e,t,n=t,r=false,o){", "function Uh(e,t,n=t,r=false,o){let innoSvg=innoVmlPaint(e,t);if(innoSvg!==undefined)return innoSvg;"],
	];
	for (const [before, after] of replacements) {
		if (code.split(before).length !== 2) throw new Error("EigenPal 2.32.0 VML patch no longer matches; review before upgrading.");
		code = code.replace(before, after);
	}
	parser ??= parserSource.then(source => transform(source.replace(/export /g, ""), { loader: "ts", target: "es2022" })).then(result => result.code);
	return code + "\n" + await parser + projection;
}

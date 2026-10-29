/** Rendering-only fixes for the pinned EigenPal 2.32.0 OMML projector.
 * Word writes ctrlPr inside script arguments and hint on Cambria Math rFonts;
 * the shipped subset rejects both, then flattens the complete script/eqArr.
 * Keep canonical OOXML untouched and disable compact rewriting for added nodes.
 * Fail the build on upstream drift instead of silently losing equations again.
 */
const CHUNK = "/@docx-editor.dev/core/dist/chunk-GWM3AKUD.js";
const LAYOUT_CHUNK = "/@docx-editor.dev/core/dist/chunk-DDFHKQFU.js";
const PAINT_CHUNK = "/@docx-editor.dev/core/dist/chunk-FS7CMYLT.js";
const MARK = "function innoMathCompatibleNode";

declare global {
	// Set by word-editor-fonts.ts once the KaTeX_Size delimiter faces load.
	var __innoMathDelimFamilies: readonly string[] | undefined;
}

const extraProjection = `
function innoMathCompatibleNode(e) {
 if(!uC(e)) return null;
 if(e.localName==="eqArr") return xs(e,{eqArrPr:tr,e:{min:1,max:32}}) && Nc(ze(e,"eqArrPr"),{maxDist:tr},p=>{let v=ze(p,"maxDist");return !v||Oc(v,new Set(["0","1","true","false","on","off"]))}) && bc(e,["e"]);
 if(e.localName==="d") return xs(e,{dPr:tr,e:{min:1,max:32}}) && Nc(ze(e,"dPr"),{begChr:tr,endChr:tr,sepChr:tr,grow:tr},p=>["begChr","endChr","sepChr","grow"].every(k=>{let v=ze(p,k);return !v||Oc(v)})) && bc(e,["e"]);
 if(e.localName==="func") return xs(e,{funcPr:tr,fName:Xo,e:Xo})&&Nc(ze(e,"funcPr"),{})&&bc(e,["fName","e"]);
 if(e.localName==="acc") return xs(e,{accPr:tr,e:Xo})&&Nc(ze(e,"accPr"),{chr:tr},p=>{let c=ze(p,"chr");return !!c&&Oc(c,new Set(["\\u0305","\\u00af"]))})&&bc(e,["e"]);
 if(e.localName==="m") {
  if(!xs(e,{mPr:tr,mr:{min:1,max:32}})||!Nc(ze(e,"mPr"),{mcs:tr},p=>{let mcs=ze(p,"mcs");return !mcs||xs(mcs,{mc:{min:1,max:32}})&&$a(mcs,"mc").every(mc=>xs(mc,{mcPr:Xo})&&Nc(ze(mc,"mcPr"),{count:tr,mcJc:tr},pr=>{let count=ze(pr,"count"),jc=ze(pr,"mcJc");return (!count||Oc(count)&&/^([1-9]|[12][0-9]|3[0-2])$/.test($y(count)))&&(!jc||Oc(jc,new Set(["center"])))}))}))return false;
  let rows=$a(e,"mr"),count=$a(rows[0],"e").length;
  return count>0&&count<=32&&rows.every(row=>xs(row,{e:{min:count,max:count}})&&bc(row,["e"]));
 }
 return null;
}
function innoMathProjection(e,t,n) {
 if(e.localName==="acc") return Object.freeze({kind:"bar",position:"top",body:Fn(ze(e,"e"),t,n+1),controlProperties:true});
 if(e.localName==="m") return Object.freeze({kind:"row",stacked:true,matrix:true,controlProperties:true,items:Object.freeze($a(e,"mr").map(row=>Object.freeze({kind:"row",matrixRow:true,items:Object.freeze($a(row,"e").map(cell=>Fn(cell,t,n+1)))})))});
 if(e.localName==="func") return Object.freeze({kind:"row",items:Object.freeze([Fn(ze(e,"fName"),t,n+1),Fn(ze(e,"e"),t,n+1)]),controlProperties:true});
 if(e.localName==="eqArr") {let rows=$a(e,"e");return Object.freeze({kind:"row",items:Object.freeze(rows.map(row=>Fn(row,t,n+1))),stacked:rows.length>1,controlProperties:true});}
 if(e.localName==="d") {
  let p=ze(e,"dPr"),begin=p?ze(p,"begChr"):null,end=p?ze(p,"endChr"):null,sep=p?ze(p,"sepChr"):null;
  let bodies=$a(e,"e").flatMap((body,i)=>i?[Object.freeze({kind:"text",value:Zy(t,sep?$y(sep):"|")}),Fn(body,t,n+1)]:[Fn(body,t,n+1)]);
  return Object.freeze({kind:"row",delimited:true,items:Object.freeze([
   Object.freeze({kind:"text",value:Zy(t,begin?$y(begin):"(")}),...bodies,
   Object.freeze({kind:"text",value:Zy(t,end?$y(end):")")})]),controlProperties:true});
 }
 return null;
}
function innoMathFonts(e,n) {
 if(e.children.length) return false;
 let fonts=new Map;
 for(let a of e.attributes) {
  if(a.namespaceUri!==O||fonts.has(a.localName)) return false;
  if(a.localName==="hint") {if(!["default","eastAsia","cs"].includes(a.value))return false;continue;}
  if(!["ascii","hAnsi","eastAsia","cs"].includes(a.localName)||!a.value||a.value.trim()!==a.value)return false;
  fonts.set(a.localName,a.value);
 }
 // Word commonly declares a separate CJK face on Latin/Greek math runs.
 // The equation projector's single math face follows the ASCII slot.
 n.fontFamily=fonts.get("ascii")??fonts.get("hAnsi")??fonts.get("eastAsia")??fonts.get("cs");
 return true;
}
// Word's # before a parenthesized integer is an equation-number separator.
// Flatten display rows only (never vertical arrays), then replace just that
// bounded pattern. Literal hashes and the canonical OOXML remain untouched.
function innoMathNormalize(e) {
 if(e.kind!=="row") return e;
 // Preserve each array branch as a horizontal row. Flattening it here made
 // every token a separate vertical branch and enlarged the brace to match.
 let items=e.items.map(innoMathNormalize).flatMap(c=>!e.stacked&&!e.matrixRow&&c.kind==="row"&&!c.stacked&&(!c.delimited||c.items.length===3&&c.items[0].value==="("&&/^\\d+$/.test(c.items[1].value??"")&&c.items[2].value===")")?c.items:[c]);
 for(let i=0;i<items.length-3;i++) if(items[i].kind==="text"&&items[i].value.endsWith("#")&&items[i+1].value==="("&&/^\\d+$/.test(items[i+2].value??"")&&items[i+3].value===")") {
  let prefix=items[i].value.slice(0,-1);
  items[i]=Object.freeze({...items[i],value:prefix+"\\u2003"});
  for(let j=i+1;j<=i+3;j++) items[j]=Object.freeze({...items[j],format:{...items[j].format,normalText:true,italic:false}});
 }
 return Object.freeze({...e,items:Object.freeze(items)});
}
`;

const extraLayout = `
function innoMathScript(e,t,n,r,o) {
 let font=ds(n,r,o),base=Cr(e.base,t,n,r,o),sub=e.subscript?Cr(e.subscript,t,n,r*Zd,o):null,sup=e.superscript?Cr(e.superscript,t,n,r*Zd,o):null;
 // Script shifts are BASELINE offsets, not top-edge offsets. The upstream
 // subscript top was below the base baseline, adding a whole script ascent
 // and making b_1 / b_2 look like a second, detached row.
 let subY=sub?base.baseline+font.fontSizePt*.2-sub.baseline:0,supY=sup?base.baseline-font.fontSizePt*.4-sup.baseline:0;
 if(sub&&sup) {let overlap=supY+sup.box.height+font.fontSizePt*.08-subY;if(overlap>0){subY+=overlap/2;supY-=overlap/2;}}
 let top=Math.min(0,sub?subY:0,sup?supY:0),shift=-top,x=base.box.width+Math.max(.4,font.fontSizePt*.04),width=x+Math.max(sub?.box.width??0,sup?.box.width??0),height=Math.max(base.box.height,sub?subY+sub.box.height:0,sup?supY+sup.box.height:0)+shift;
 return Object.freeze({kind:"script",base:mr(base,0,shift),...sub?{subscript:mr(sub,x,subY+shift)}:{},...sup?{superscript:mr(sup,x,supY+shift)}:{},box:eo(0,0,width,height),baseline:base.baseline+shift});
}
function innoMathRow(e,t,n,r,o) {
 let items=e.items.map(a=>Cr(a,t,n,r,o)),metrics=TB(t,n,r,o);
 if(e.matrix&&items.length) {
  let gap=ds(n,r,o).fontSizePt,columns=Math.max(...items.map(row=>row.items.length)),widths=Array.from({length:columns},(_,j)=>Math.max(...items.map(row=>row.items[j]?.box.width??0)));
  items=items.map(row=>{let x=0,cells=row.items.map((cell,j)=>{let placed=mr(cell,x+(widths[j]-cell.box.width)/2,cell.box.y);x+=widths[j]+gap;return placed});return Object.freeze({...row,items:Object.freeze(cells),box:eo(0,0,x-gap,row.box.height)});});
 }
 if(e.stacked) {
  let gap=ds(n,r,o).fontSizePt*.2,y=0,width=Math.max(0,...items.map(a=>a.box.width));
  let rows=items.map(a=>{let placed=mr(a,0,y);y+=a.box.height+gap;return placed});
  let height=Math.max(metrics.height,y-gap);
  return Object.freeze({kind:"row",items:Object.freeze(rows),box:eo(0,0,width,height),baseline:height/2+metrics.baseline-metrics.height/2});
 }
 if(e.delimited&&items.length===3&&items[1].box.height>metrics.height*1.4) {
  let body=items[1],fams=globalThis.__innoMathDelimFamilies;
  // KaTeX's actual delimiter ink metrics (depth, ascent, advance), in em.
  // Layout text nodes carry text/runStyle, NOT projection value/format.
  let heights=[1.20002,1.80002,2.40003,3.00003],ascents=[.85,1.15,1.45,1.75];
  let advances={"(":[.45834,.59722,.73611,.79167],")":[.45834,.59722,.73611,.79167],"[":[.41667,.47222,.52778,.58334],"]":[.41667,.47222,.52778,.58334],"{":[.58334,.66667,.75,.80556],"}":[.58334,.66667,.75,.80556]};
  for(let i of[0,2]) {
   let glyph=items[i],ch=glyph.text;
   if(!fams?.length||!advances[ch])continue;
   let pt=glyph.fontSizePt,index=heights.findIndex(h=>h*pt>=body.box.height);
   if(index<0)index=3;
   let fit=Cr({kind:"text",value:ch,format:{fontFamily:fams[index],normalText:true,bold:false,italic:false}},t,n,r,o);
   let height=Math.max(body.box.height,heights[index]*pt),scale=height/(heights[index]*pt);
   // Stretch only vertically beyond Size4. Increasing fontSizePt also
   // widened/thickened the strokes of tall matrices. Keep the admitted
   // delimiter runStyle on the layout node so paint uses that same face.
   items[i]=Object.freeze({...fit,box:eo(0,0,advances[ch][index]*pt,height),baseline:body.baseline+(height-body.box.height)/2,
    innoDelimiterPaint:{scaleY:scale,lineHeight:fit.box.height,offsetY:(ascents[index]*pt-fit.baseline)*scale}});
  }
 }
 return VX(items,metrics);
}
`;

export function patchWordEditorMath(code: string, id: string): string | null {
	const path = id.replace(/\\/g, "/").split("?", 1)[0];
	if (path.endsWith(PAINT_CHUNK)) {
		if (code.includes("n.innoDelimiterPaint")) return code;
		const before = 'f.style.whiteSpace="pre",n.kind==="fallback"';
		if (code.split(before).length !== 2) throw new Error("EigenPal 2.32.0 delimiter paint patch no longer matches; review before upgrading.");
		// Paint the unscaled glyph box before the CSS transform; using the final
		// layout height here scales its hit box twice and overlaps later text.
		return code.replace(before, 'f.style.whiteSpace="pre",n.innoDelimiterPaint&&(f.style.top=`${(u+n.innoDelimiterPaint.offsetY)*i}px`,f.style.height=f.style.lineHeight=`${n.innoDelimiterPaint.lineHeight*i}px`,f.style.transformOrigin="top left",f.style.transform=`scaleY(${n.innoDelimiterPaint.scaleY})`),n.kind==="fallback"');
	}
	if (path.endsWith(LAYOUT_CHUNK)) {
		if (code.includes("function innoMathRow")) return code;
		const before = 'case "row":return VX(e.items.map(a=>Cr(a,t,n,r,o)),TB(t,n,r,o));';
		if (code.split(before).length !== 2) throw new Error("EigenPal 2.32.0 OMML layout patch no longer matches; review before upgrading.");
		const scriptStart = code.indexOf('case "script":{let a=ds(n,r,o),i=Cr(e.base,t,n,r,o)');
		const scriptEnd = code.indexOf('case "nary":', scriptStart);
		if (scriptStart < 0 || scriptEnd < 0) throw new Error("EigenPal 2.32.0 script layout patch no longer matches; review before upgrading.");
		code = code.slice(0, scriptStart) + 'case "script":return innoMathScript(e,t,n,r,o);' + code.slice(scriptEnd);
		return extraLayout + code.replace(before, 'case "row":return innoMathRow(e,t,n,r,o);');
	}
	if (!path.endsWith(CHUNK)) return null;
	if (code.includes(MARK)) return code;
	const replacements: [string, string][] = [
		['if(i.children.length!==0)return  false;let a=new Set,l;for(let s of i.attributes){if(s.namespaceUri!==r||!["ascii","hAnsi","eastAsia","cs"].includes(s.localName)||a.has(s.localName)||(a.add(s.localName),s.value.length===0||s.value.trim()!==s.value||l!==void 0&&l!==s.value))return  false;l=s.value;}l!==void 0&&(n.fontFamily=l);', 'if(!innoMathFonts(i,n))return false;'],
		['}else if(!t&&i.localName==="sty"){', '}else if(t&&i.localName==="color"&&i.children.length===0&&i.attributes.length===1&&i.attributes[0].namespaceUri===O&&i.attributes[0].localName==="val"&&["000000","auto"].includes(i.attributes[0].value)){continue;}else if(!t&&i.localName==="sty"){'],
		['let a=t?i.localName==="b"?', 'if(t&&i.localName==="szCs"&&i.children.length===0&&i.attributes.length===1&&i.attributes[0].namespaceUri===O&&i.attributes[0].localName==="val"&&/^[1-9][0-9]{0,3}$/.test(i.attributes[0].value))continue;let a=t?i.localName==="b"?'],
		['t.children.length===0&&Oc(r,d$)', 't.children.every(c=>uC(c,"ctrlPr")&&cC(c))&&Oc(r,d$)'],
		// Word's formatting metadata counts toward the original 256-node cap:
		// the reported Pearson equation has more nodes before any glyph layout.
		['maxDepth:24,maxNodes:256,maxTextLength:512', 'maxDepth:48,maxNodes:4096,maxTextLength:2048'],
		['r.children.every(kc)', 'r.children.every(c=>uC(c,"ctrlPr")?cC(c):kc(c))'],
		['function kc(e){', `${extraProjection}\nfunction kc(e){let compatible=innoMathCompatibleNode(e);if(compatible!==null)return compatible;`],
		['for(let i of vc(e))o.push(kC(i,t,n+1));', 'for(let i of vc(e))if(!uC(i,"ctrlPr")||!cC(i))o.push(kC(i,t,n+1));'],
		['function f$(e,t,n){if(!kc(e))return null;', 'function f$(e,t,n){if(!kc(e))return null;let compatible=innoMathProjection(e,t,n);if(compatible)return compatible;'],
		['expression:d,fallbackText:a,truncated:false', 'expression:innoMathNormalize(d),fallbackText:a,truncated:false'],
	];
	for (const [before, after] of replacements) {
		if (code.split(before).length !== 2) throw new Error("EigenPal 2.32.0 OMML patch no longer matches; review the equation projector before upgrading.");
		code = code.replace(before, after);
	}
	return code;
}

import { useMemo, useId, useState, type ReactNode } from "react";
import { EditorToolbar, ToolbarCommand, ToolbarCommandSelect, useDocxCommand, useDocxCommandState, useDocxCommands, type DocxCommandArgs, type DocxCommandId, type DocxCommandOption } from "@betteroffice/docx-react";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Columns3, FilePlus2, Image, Italic, Link, List, ListOrdered, Maximize, Redo2, Rows3, ScanLine, Search, Settings2, Table2, Underline, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Select, SelectContent, SelectGroup, SelectLabel, SelectTrigger, SelectValue, SelectOption, TabPanel, Tabs } from "../ui/index.js";

type Props = { rulers: boolean; onRulersChange: () => void; outline: boolean; onOutlineChange: () => void; fontDisplay: string | null; onError: () => void };
function Command<K extends DocxCommandId>({ id, args, label, children, onError }: { id: K; args: DocxCommandArgs[K]; label: string; children?: ReactNode; onError: () => void }) {
 const command = useDocxCommand(id, args);
 return <Button variant="ghost" size="xs" disabled={!command.state.enabled} aria-label={label} title={command.state.enabled ? label : command.state.disabledReason?.message || label}
  aria-pressed={typeof command.state.active === "boolean" ? command.state.active : undefined}
  onMouseDown={(event) => event.preventDefault()} onClick={() => { void command.execute().then((result) => { if (!result.ok) onError(); }).catch(onError); }}>
  {children}<span>{label}</span>
 </Button>;
}
function Group({ label, children }: { label: string; children: ReactNode }) {
 return <div role="group" aria-label={label} className="inno-word-ribbon-group">{children}</div>;
}
const FONT_GROUPS: Array<{ id: "sans-serif" | "serif" | "monospace" | "other"; labelKey: string }> = [
 { id: "sans-serif", labelKey: "wordEditor.fontGroupSans" }, { id: "serif", labelKey: "wordEditor.fontGroupSerif" },
 { id: "monospace", labelKey: "wordEditor.fontGroupMono" }, { id: "other", labelKey: "wordEditor.fontGroupOther" },
];
/**
 * Script-aware replacement for the built-in fontFamily picker. The engine's
 * command value flattens rFonts to the ASCII slot, so a Times New Roman + 宋体
 * run always displayed "Times New Roman"; the host passes the east-Asian font
 * while the caret is on CJK text (see selection-font.ts) and this control
 * falls back to the engine value when that is unavailable.
 */
function FontFamilySelect({ fontDisplay, onError }: { fontDisplay: string | null; onError: () => void }) {
 const { t } = useTranslation();
 const commands = useDocxCommands();
 const state = useDocxCommandState("fontFamily");
 const options = state.options ?? [];
 const sections = useMemo(() => {
  const documentFonts: DocxCommandOption<"fontFamily">[] = [];
  const grouped = new Map<string, DocxCommandOption<"fontFamily">[]>(FONT_GROUPS.map(({ id }) => [id, []]));
  for (const option of options) {
   const group = option.preview?.group;
   if (group === "document") documentFonts.push(option);
   else (grouped.get(group ?? "other") ?? grouped.get("other"))!.push(option);
  }
  // The engine lists document fonts separately but the host fontFamilies prop
  // can overlap it; keep the first occurrence like the built-in picker.
  const seen = new Set<string>();
  const toItems = (list: DocxCommandOption<"fontFamily">[]) => list.filter((option) => {
   const key = option.label.toLocaleLowerCase();
   if (seen.has(key)) return false; seen.add(key); return true;
  }).map((option) => ({ value: option.label, label: option.label, icon: option.preview?.fontFamily ? <span className="inno-word-font-preview" style={{ fontFamily: option.preview.fontFamily }} aria-hidden="true">字Aa</span> : undefined }));
  return [
   { id: "document", labelKey: "wordEditor.fontGroupDocument", list: documentFonts },
   ...FONT_GROUPS.map(({ id, labelKey }) => ({ id, labelKey, list: grouped.get(id)! })),
  ].filter(({ list }) => list.length > 0).map(({ id, labelKey, list }) => ({ id, label: t(labelKey), options: toItems(list) }));
 }, [options, t]);
 // When the display font is not one of the listed options (a document naming
 // an unlisted family), show the raw name instead of an empty SelectValue.
 const listed = useMemo(() => {
  const key = fontDisplay?.toLocaleLowerCase();
  return key ? options.some((option) => option.label.toLocaleLowerCase() === key) : false;
 }, [fontDisplay, options]);
 const apply = (name: string) => {
  const option = options.find((candidate) => candidate.label === name);
  const family = option?.args.family || name;
  void commands.execute("fontFamily", { family }).then((result) => { if (!result.ok) onError(); }).catch(onError);
 };
 const value = fontDisplay ?? state.value ?? "";
 return <Select value={value || undefined} onValueChange={apply} disabled={!state.enabled}>
  <SelectTrigger className="inno-word-font-select" aria-label={t("wordEditor.fontSelector")} title={t("wordEditor.fontSelector")}>
   {value && !listed ? <span className="inno-ui-select-trigger-value">{value}</span> : <SelectValue placeholder="" />}
  </SelectTrigger><SelectContent>
   {sections.map((section) => <DisplayGroup key={section.id} label={section.label}>
    {section.options.map((option) => <SelectOption key={option.value} value={option.value} label={option.label} icon={option.icon} />)}
   </DisplayGroup>)}
  </SelectContent>
 </Select>;
}
function DisplayGroup({ label, children }: { label: string; children: ReactNode }) {
 return <SelectGroup>{<SelectLabel>{label}</SelectLabel>}{children}</SelectGroup>;
}
export function WordRibbon({ rulers, onRulersChange, outline, onOutlineChange, fontDisplay, onError }: Props) {
 const { t } = useTranslation();
 const [tab, setTab] = useState("home");
 const ribbonId = useId();
 const label = (key: string) => t(`wordEditor.${key}`);
 const command = <K extends DocxCommandId,>(id: K, args: DocxCommandArgs[K], key: string, icon?: ReactNode) => <Command id={id} args={args} label={label(key)} onError={onError}>{icon}</Command>;
 const table = (action: DocxCommandArgs["tableAction"], key: string, icon?: ReactNode) => command("tableAction", action, key, icon);
 return <EditorToolbar className="inno-word-ribbon">
  <Tabs id={ribbonId} size="compact" value={tab} onValueChange={setTab} ariaLabel={label("tools")} items={[
   { value: "home", label: label("home") }, { value: "insert", label: label("insert") }, { value: "page", label: label("page") },
   { value: "references", label: label("references") }, { value: "view", label: label("view") },
   { value: "tableStyle", label: label("tableStyle") }, { value: "tableLayout", label: label("tableLayout") },
  ]} />
  <TabPanel id={`${ribbonId}-panel`} labelledBy={`${ribbonId}-tab-${tab}`} tabIndex={-1} className="inno-word-ribbon-panel">
   <EditorToolbar.Toolbar className="inno-word-toolbar">
    {tab === "home" ? <>
     <Group label={label("history")}>{command("undo", null, "undo", <Undo2 size={16} />)}{command("redo", null, "redo", <Redo2 size={16} />)}</Group>
     <Group label={label("font")}><div className="inno-word-ribbon-stack"><div className="inno-word-ribbon-row"><FontFamilySelect fontDisplay={fontDisplay} onError={onError} /><ToolbarCommandSelect id="fontSize" /></div><div className="inno-word-ribbon-row">
      {command("bold", null, "bold", <Bold size={16} />)}{command("italic", null, "italic", <Italic size={16} />)}{command("underline", null, "underline", <Underline size={16} />)}<ToolbarCommand id="textColor" /><ToolbarCommand id="highlightColor" />
     </div></div></Group>
     <Group label={label("paragraph")}><div className="inno-word-ribbon-stack"><div className="inno-word-ribbon-row">{command("bulletList", null, "bullets", <List size={16} />)}{command("numberedList", null, "numbering", <ListOrdered size={16} />)}<ToolbarCommandSelect id="lineSpacing" /></div><div className="inno-word-ribbon-row">
      {command("alignment", { value: "left" }, "alignLeft", <AlignLeft size={16} />)}{command("alignment", { value: "center" }, "alignCenter", <AlignCenter size={16} />)}{command("alignment", { value: "right" }, "alignRight", <AlignRight size={16} />)}{command("alignment", { value: "both" }, "alignJustify", <AlignJustify size={16} />)}
     </div></div></Group>
     <Group label={label("styles")}><ToolbarCommandSelect id="paragraphStyle" /></Group>
     <Group label={label("find")}>{command("find", null, "find", <Search size={16} />)}</Group>
    </> : null}
    {tab === "insert" ? <Group label={label("insert")}><ToolbarCommand id="insertTable" />{command("insertImage", null, "image", <Image size={18} />)}{command("insertLink", null, "link", <Link size={18} />)}{command("insertPageBreak", null, "pageBreak", <FilePlus2 size={18} />)}</Group> : null}
    {tab === "page" ? <Group label={label("page")}>
     {command("pageSetup", null, "pageSetup", <Settings2 size={18} />)}{command("insertSectionBreakNextPage", null, "sectionBreak", <FilePlus2 size={18} />)}{command("watermark", null, "watermark")}
    </Group> : null}
    {tab === "references" ? <Group label={label("references")}>{command("insertTOC", null, "toc", <List size={18} />)}{command("find", null, "find", <Search size={18} />)}</Group> : null}
    {tab === "view" ? <>
     <Group label={label("view")}><Button variant="ghost" size="xs" disabled={!globalThis.document?.fullscreenEnabled} onClick={() => { void (globalThis.document.fullscreenElement ? globalThis.document.exitFullscreen() : globalThis.document.documentElement.requestFullscreen()).catch(onError); }}><Maximize size={18} />{label("fullscreen")}</Button>
      <Button variant="ghost" size="xs" aria-pressed={outline} onClick={onOutlineChange}><List size={18} />{label("outline")}</Button>
      <Button variant="ghost" size="xs" aria-pressed={rulers} onClick={onRulersChange}><ScanLine size={18} />{label("ruler")}</Button>
     </Group><Group label={label("zoom")}><ToolbarCommandSelect id="zoom" />{command("zoom", { scale: 1 }, "actualSize")}</Group>
    </> : null}
    {tab === "tableStyle" ? <>
     <Group label={label("tableStyle")}>{table({ type: "toggleHeaderRow" }, "repeatHeader")}{table("borderAll", "allBorders")}{table("borderOutside", "outsideBorders")}{table("borderNone", "noBorders")}</Group>
     <Group label={label("tableProperties")}>{table({ type: "openTableProperties" }, "tableProperties", <Settings2 size={18} />)}</Group>
    </> : null}
    {tab === "tableLayout" ? <>
     <Group label={label("tableStructure")}><div className="inno-word-ribbon-stack">{table("addRowAbove", "insertAbove", <Rows3 size={16} />)}{table("addRowBelow", "insertBelow", <Rows3 size={16} />)}</div><div className="inno-word-ribbon-stack">{table("addColumnLeft", "insertLeft", <Columns3 size={16} />)}{table("addColumnRight", "insertRight", <Columns3 size={16} />)}</div></Group>
     <Group label={label("mergeSplit")}>{table("mergeCells", "mergeCells", <Table2 size={18} />)}{table("splitCell", "splitCell")}</Group>
     <Group label={label("tableProperties")}>{table({ type: "openTableProperties" }, "tableProperties", <Settings2 size={18} />)}</Group>
     <Group label={label("delete")}><div className="inno-word-ribbon-stack">{table("deleteRow", "deleteRow")}{table("deleteColumn", "deleteColumn")}</div>{table("deleteTable", "deleteTable")}</Group>
    </> : null}
   </EditorToolbar.Toolbar>
  </TabPanel>
 </EditorToolbar>;
}

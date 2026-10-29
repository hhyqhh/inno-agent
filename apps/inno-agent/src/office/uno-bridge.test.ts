import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it("executes spreadsheet inspection and edit RPC against the actual Python bridge class", async () => {
    // Fake only UNO's import surface. Exercise the shipped bridge, rather than
    // a stand-in process which cannot detect misplaced class methods.
    const program = `
import importlib.util, sys, types
from unittest.mock import MagicMock
sys.modules['uno'] = types.ModuleType('uno')
sys.modules['uno'].systemPathToFileUrl = lambda path: 'file://' + path
for name in ['com', 'com.sun', 'com.sun.star', 'com.sun.star.beans']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['com.sun.star.beans'].PropertyValue = type('PropertyValue', (), {})
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
engine = bridge.OfficeEngine.__new__(bridge.OfficeEngine)
component = MagicMock()
component.Sheets.ElementNames = ['Budget']
component.Sheets.getByName.return_value.createCursor.return_value.RangeAddress.EndRow = 2
component.Sheets.getByName.return_value.createCursor.return_value.RangeAddress.EndColumn = 1
engine.docs = {'d1': {'component': component, 'kind': 'sheet', 'path': '/budget.xlsx'}}
outline = bridge.handle(engine, {'cmd': 'inspect', 'docId': 'd1'})
assert outline['sheets'] == [{'name': 'Budget', 'rows': 3, 'cols': 2}], outline
result = bridge.handle(engine, {'cmd': 'exec', 'docId': 'd1', 'ops': [{'op': 'set_cell', 'cell': 'A1', 'value': 12}]})
assert result['results'][0]['ok'], result
component.Sheets.getByIndex.return_value.getCellRangeByName.return_value.setValue.assert_called_once_with(12)
assert hasattr(engine, '_op_list_slides')
# Writer operations must share the same real class, not a shadowed handler.
paragraph = MagicMock()
paragraph.getString.return_value = 'Hello'
paragraph.ParaStyleName = 'Heading 1'
component.Text.createEnumeration.return_value.hasMoreElements.side_effect = [True, False]
component.Text.createEnumeration.return_value.nextElement.return_value = paragraph
component.TextTables.Count = 0
engine.docs['w1'] = {'component': component, 'kind': 'doc', 'path': '/report.docx'}
assert bridge.handle(engine, {'cmd': 'inspect', 'docId': 'w1'})['paragraphs'][0]['text'] == 'Hello'
component.replaceAll.return_value = 2
changed = bridge.handle(engine, {'cmd': 'exec', 'docId': 'w1', 'ops': [{'op': 'replace_text', 'find': 'a', 'replace': 'b'}]})
assert changed['results'][0]['result']['replaced'] == 2
# Converting an owned document uses its current component and keeps it open.
bridge.handle(engine, {'cmd': 'convert', 'path': '/report.docx', 'to': 'pdf', 'outDir': '/tmp'})
assert 'w1' in engine.docs
component.close.assert_not_called()
bridge.handle(engine, {'cmd': 'save', 'docId': 'w1', 'path': '/copy.docx'})
assert engine.docs['w1']['path'] == '/copy.docx'
component.storeAsURL.assert_called_once()
bridge.handle(engine, {'cmd': 'save', 'docId': 'w1'})
component.store.assert_called_once()
`;
    const result = await exec("python3", ["-B", "-c", program, fileURLToPath(new URL("../../scripts/uno-bridge.py", import.meta.url))]);
    expect(result.stderr).toBe("");
});

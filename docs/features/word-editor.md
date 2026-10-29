# Word 文档编辑

工作区 DOCX 的「编辑」在当前预览面板中打开 **EigenPal DOCX Editor 2.32.0**，使用 `@docx-editor.dev/react` 与 `@docx-editor.dev/core`（Apache-2.0）。不需要 ONLYOFFICE Document Server、容器或外部文档上传。旧 DOC 文件继续使用 PDF 预览，编辑前需另存为 DOCX。

## 接入与界面

- 直接向新引擎传入原始 DOCX 字节，由引擎解析、分页、编辑和重新序列化。不再经过 Univer 的 DOCX→HTML→文档快照及手工回填 XML 链路。
- 预览与编辑共用文件栏，保留保存状态、保存、下载编辑副本、返回预览。引擎提供字体、段落、列表、图片和表格等编辑控件、标尺、导航及缩放；不再保留旧引擎的七页签工具栏。
- 关闭引擎自身的 File 菜单并隐藏重复标题栏，文件打开与写回由宿主工作区统一管理，避免在引擎内打开另一文件后误写到原路径。
- 编辑器属于文件所在工作区；切换文件页签时隐藏但保留草稿，面板缩放、主题和语言变化不重新载入输入字节。
- 工具栏采用随包提供的简体中文/英文文案，宿主控件复用共享 UI，颜色通过语义变量跟随 light/dark。

## 保存

`WordEditorHandle` 保留 `isDirty()` 与 `save()`，兼容现有页签关闭保护。引擎的内容变更事件只更新脏标记；加载事件不视为编辑，不在每次输入时生成 DOCX。

保存按钮或当前活动编辑页签的 Ctrl/Cmd+S 按需调用引擎 `save()`，经现有 `saveWorkspaceFileBinary` 写回文件所属工作区。服务器确认 `saved: true` 后才清除对应版本的脏标记；保存期间继续输入则仍为未保存，保存并关闭不会丢掉新编辑。保存失败保留草稿及下载副本入口。下载副本不改变保存状态。

关闭未保存文档会确认；刷新/关闭浏览器有原生提醒。当前没有跨刷新草稿恢复和自动保存。

写回使用工作区通用 PUT 路由。当前通用路由不提供 ETag 冲突检查或原件备份，不能依赖旧 BetterOffice 专用保存服务的语义。

## 字体与边界

字体解析优先读取本机已安装字体的真实字节和 TTC 字面索引，按字体元数据中的中英文名称匹配宋体、黑体、仿宋及数学字体等。macOS 同时枚举系统、用户、已下载字体、Microsoft Office 字体目录及 PDF 引擎随包字体（包括 Noto Serif SC）；目录只扫描一次，按需求传输字节，页签间复用。中英文元数据别名共用一个字面，仅载入常规/粗体/斜体所需的字重；西文字体使用按需加载器，避免未使用字体占满引擎的总字节预算。布局计算和画面绘制使用同一字体来源，避免仅 CSS 换字体造成换行和行高不一致。单字体解析上限设为 64 MiB，与服务端读取上限一致，覆盖宋体等超过引擎默认 16 MiB 的已安装字体。

`GET /api/settings/fonts` 提供字体元数据，`GET /api/settings/fonts/<opaque-id>` 只读取已枚举且仍位于字体目录内的文件，不接受客户端文件路径。没有安装的字体仍由随包提供的西文/CJK 字体替代，无字体 CDN 请求。只有单个字重的中文字体会优先替代为同一家族的现有字面；这仍可能与 Word 的合成粗体有所不同，原生字体提示会保留此差异。

EigenPal 2.32.0 的有界公式投影额外识别 Word 参数内的 `m:ctrlPr`、字体 hint/分脚本字体声明、默认黑色和复杂文字字号元数据，以及公式阵列、增长括号、函数、上横线和居中矩阵。多行阵列和矩阵参与真实几何布局，`#(整数)` 作为公式编号分隔符显示；单独的井号保留。公式预算为 4096 节点、48 层、2048 字符，避免常规复杂公式的格式元数据触发原来 256 节点上限。兼容变换只修改显示投影，不改原始 OOXML；新增结构禁止有损的紧凑公式改写。其他未覆盖结构继续保留原生回退。Vite 在开发与构建中应用同一变换，上游代码变化会使构建明确失败，升级时必须复核。

已有文件如果曾经被旧转换链写坏，字体解析不会恢复已经丢失的段落属性、表格属性或原生公式。应从原件/备份另建恢复副本，不能自动覆盖可能包含新修改的文件。

引擎支持程度以其[功能矩阵](https://www.docx-editor.dev/docs/latest/word-fidelity)为准。当前不接入 Pro 包的批注、修订和多人协作。复杂浮动对象、公式、分节、合并表格及真实系统输入法仍需业务样本文档验收，不能把引擎支持列表理解为完整 Word 保真承诺。

## 验证

```bash
npm run build
npx vitest run apps/inno-agent/web/src/react/office/WordEditor.test.tsx apps/inno-agent/web/src/react/office/word-editor-fonts.test.ts apps/inno-agent/web/src/react/office/word-editor-math-compat.test.ts apps/inno-agent/src/office/system-fonts.test.ts apps/inno-agent/src/server/routes/fonts.test.ts apps/inno-agent/web/src/react/WorkspaceBrowser.word-editor.test.tsx
```

组件测试覆盖直接载入字节、加载事件与真实编辑的区分、输入路径不导出、状态更新不重新挂载、保存确认/失败/并发输入、工作区归属、未保存关闭确认、后台页签快捷键、重试与请求取消。真实分页、输入和 DOCX 往返另用浏览器样本验证。

加载状态作为编辑区域内的覆盖层显示，不再与引擎分摊 flex 高度；工具栏始终位于编辑区域顶部。

PDF 仍由独立的 LibreOffice 转换服务生成。字体和排版引擎不同可能导致与 Word 分页不同，不能用缩小字号或删除溢出内容强行匹配页数。试卷样本的 Noto Serif SC 与宋体替代可产生不同分页；Word 原生转换方案尚未启用。

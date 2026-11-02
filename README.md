# MySQL Lite（MySQL 轻量级客户端）

简洁、快速、专注日常 MySQL 查询与表结构管理的 Windows 桌面应用。  
维护者：[NealWizard](https://github.com/NealWizard) · [MIT License](LICENSE)

技术栈：Electron 38 + Vue 3 + TypeScript + electron-vite 6 + naive-ui + Monaco Editor + mysql2。

## 功能

- **界面**（对齐原型）：左侧图标栏（连接 / 历史 / 设置）+ 连接树（连接 → 库 → 表，已连接绿点）+ SQL 多标签；工具栏为蓝色「执行」、停止、格式化、清空、历史；结果区为「查询结果 / 执行信息 / 执行计划」，外框默认高 540 像素，拖动分隔条后写入工作区，重新打开保持；底栏显示连接状态、光标行列、字符集与 MySQL 版本
- **连接管理**：树顶「新建连接」弹窗（常规 / SSL / 高级），测试连接，密码经系统 safeStorage 加密存储；展开连接节点即打开。右键「编辑」在「高级 → 显示的库」勾选要保留的库，连接树只展示勾中的库；全选或从未勾选过则显示全部。点一下连接树后直接敲字母，树只留下名称里包含这些字的节点，并把键入的字标黄。退格删字，Esc 恢复全部。没展开的库不会搜到里面的表
- **SQL 查询工作台**：Monaco 编辑器（MySQL 语法高亮、行号）、多标签、执行选中/当前/全部（Ctrl+Enter）、格式化、EXPLAIN、结果多标签页
- **安全护栏**：只读模式（默认开，仅 SELECT/SHOW/EXPLAIN/DESC）、危险语句（DROP/TRUNCATE/无 WHERE 的 DML）二次确认、单条超时与最大行数截断。Ctrl+R / Ctrl+Shift+R 已禁用，避免误刷新整窗
- **编辑区快捷键**：Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做，Ctrl+X / Ctrl+C / Ctrl+V，Ctrl+A 全选，Ctrl+F 查找，Ctrl+H 替换，Ctrl+/ 行注释，Alt+↑/↓ 移动当前行，Ctrl+D 复制当前行，Ctrl+Enter 执行。选中语句后右键「执行(ctrl+enter)」，和 Ctrl+Enter 一样：有选中执行选中，否则执行光标所在语句。切换选项卡只换编辑器文档和当前页结果，不重建编辑器、不重绘全部行、不因此写入工作区
- **编辑区**：输入时补全关键字，以及当前库的表、视图和列。FROM、JOIN 后面先出表名，再出左侧已展示的库名。语句里写了其他库名时，补全那个库下的表和列；没写库名则只补当前库。格式化旁的「压缩」把当前 SQL 收成一行。选项卡内容自动写到本机工作区，下次打开恢复；单个选项卡超过 1MB 时提示「“选项卡名”工作区内容过大，是否加载」，不加载则这次不打开，文件里的原文保留
- **查询预览**：没有 `LIMIT` 的 `SELECT` 每次只取 1000 行（`LIMIT 1001 OFFSET n`），结果区底栏「上一批 / 下一批」再查下一批。数据先显示；这一批不满 1000 行时总数就是已返回行数，满了再后台 `COUNT(*)`，底栏先显示「统计中…」，完成后显示「共 N 行」。翻页沿用总数。语句里已有 `LIMIT` 的不改写、不额外计数
- **执行目标**：执行按钮左侧两个下拉框，先选实例（连接）再选库。执行时在所选库中运行；换实例会断开当前连接并打开新实例
- **结果网格**：表头只显示字段名。第一次移到某张表的表头时按真实库名查列注释并记住这一张表，之后再移到表头立刻显示。查询耗时只计语句本身。NULL 置灰、不可编辑的格子双击复制、勾选复制行、导出 CSV（默认文件名为表名加本机时间，转义 + BOM）、完整分页（共 X 条/条数切换/跳至）。列宽按这一批已取回的内容计算，最宽 300 像素，表头右缘可再拖。单表且结果含全部主键时，单击格子只选中，双击或 Enter 才编辑，改过的格子为浅绿色。点最左列的空白处选中整行。Ctrl+C 复制选中的格子或整行，NULL 复制成文字 NULL，粘贴时还原成数据库 NULL。Ctrl+V 从当前格子往右粘贴。点「+」后新行是整行选中，可直接粘贴再改主键。分页栏左侧「+」在当前页新增行、「−」删除勾选行、「×」撤销、「✓」保存，旁边显示已选行数。删除先划掉，点「✓」才写库。保存使用参数化 UPDATE / INSERT / DELETE，含删除时提示「将删除 n 行」，成功后重查当前这一批，重查时结果表仍可见，上面盖一层透明遮罩。只读开关不拦截这次保存。联表、没有主键或结果里没有主键列时仍只读
- **表结构编辑**：连接树右键「编辑表结构」只打开这一张表，不再显示表清单。字段和索引用带边框的表格显示，点格子任意位置即可编辑。字段可增删改（名称、类型、长度、小数位、非空、默认值、注释、主键、上下移动），索引可增删改（名称、字段、唯一）。保存前确认一条 ALTER 再执行。点执行后整页盖一层透明遮罩，避免重复执行。视图只读。自增、unsigned、ON UPDATE 不单独编辑，写回时保留
- **完整说明**：见 [docs/功能文档.md](docs/功能文档.md)（含回归清单）

## 启动与构建

```powershell
cd mysql-lite
npm install        # 首次；若 electron 二进制下载失败先设 $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm run dev        # 开发模式（热更新）
npm run dev:debug  # 开发模式 + CDP 调试端口 9222（配合 scripts/cdp-*.mjs 做界面自动化诊断）
npm run typecheck  # 类型检查
npm run selftest   # 端到端自检（需本机 127.0.0.1:33066 测试库，root/root）
npm run pack:win   # 打包 NSIS 安装包 → release/MySQL Lite Setup 1.0.0.exe
node scripts/publish-clean.mjs  # 干净安装包 → release-clean/MySQL Lite Setup 1.0.0.exe（不读取、不删除 %APPDATA%\mysql-lite）
```

## 验证

`npm run selftest` 以真实主进程服务直连测试库（`127.0.0.1:33066/test`），覆盖：连接测试、打开连接、库/表清单、表详情（字段/索引/DDL/统计）、只读拦截、危险语句确认与放行（临时表）、maxRows 截断、Date/Buffer 结果清洗、错误语句定位。当前 **18/18 PASS**（生产构建 `win-unpacked` 同测通过）。自检全程不写业务表，结束自动清理连接配置。

SQL 解析纯函数单测：`node scripts/parse-check.ts`（24 例）。

## 验收清单核对（产品方案第 9 章）

| # | 条目 | 状态 |
|---|---|---|
| 1 | 连接配置 CRUD + 连接测试 | ✅ |
| 2 | 连接后显示数据库列表并查看表 | ✅ |
| 3 | 刷新数据库和表列表 | ✅ |
| 4 | 表右键菜单（查询数据/编辑结构/复制表名/导出/删除/刷新）；库右键刷新 | ✅ |
| 5 | SQL 语法高亮 + 多标签 | ✅ |
| 6 | 执行选中 SQL；无选中执行当前语句 | ✅ |
| 7 | 结果列名/数据/NULL/耗时 | ✅ |
| 8 | 复制单元格/行 | ✅ 单元格双击复制、行勾选复制；矩形区域框选复制留待 V1.1 |
| 9 | 导出 CSV 中文编码正确 | ✅ BOM + 标准转义 |
| 10 | 断连/认证失败/SQL 错误/超时中文提示 | ✅ |
| 11 | 密码不明文落盘/日志 | ✅ safeStorage 加密，接口返回剥离凭据 |
| 12 | 大结果集限制、界面不冻结 | ✅ maxRows 截断 + 单条超时 + 异步执行 |
| 13 | Windows 安装包安装/启动/卸载 | ✅ 安装包已构建并验证启动；安装/卸载请执行安装包实测 |

## 与产品方案的偏差说明

- **库表浏览形态**：已实现左侧连接树（连接 → 库 → 表）；表结构页为单表编辑，无全库表清单分栏。
- **SQL 历史**：侧栏有会话内历史（最多 30 条），不落盘。
- **结果集矩形区域复制**：留待后续（单元格/行复制已覆盖日常场景）。
- **SSL / 外键与触发器设计**：未实现。

## 目录结构

```
electron/
  main/     主进程入口、IPC 白名单、配置持久化、自检入口（selftest.ts）
  preload/  contextBridge 白名单 API（window.mysqlLite）
  services/ connection / credential / mysql / query（业务全部集中在主进程）
src/
  views/    QueryWorkspace（查询）、TableStructure（表结构）、ConnectionManager（连接）
  components/ SqlEditor、ResultGrid
  stores/   Pinia（connection / query / ui）
```

安全边界：contextIsolation 开启、nodeIntegration 关闭，Renderer 仅可调 preload 暴露的白名单 API；所有 SQL 与标识符经参数化/转义，禁止拼接。

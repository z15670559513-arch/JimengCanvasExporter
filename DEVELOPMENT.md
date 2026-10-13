# 开发与发布

正式公开仓库只保存白名单运行源码、中文文档和合成测试，不保存个人调查、真实账号数据、下载记录或浏览器 Profile。
运行路径：侧栏与本地 IndexedDB → 后台定位当前窗口的授权画板 → 快照与严格原图解析 → 原样读取 CDN 图片 → 解码、SHA-256 与保存核验。

## 开发检查

安装 Node.js 20+。运行 `node scripts/test.mjs` 执行自动回归，`node scripts/release-audit.mjs .` 检查运行权限、隐私和导入闭包。
`node scripts/public-audit.mjs .` 用于检查干净公开源码目录；含 dist、node_modules 或私人材料的工作目录会被拒绝。

浏览器测试先运行 `npm install` 安装开发依赖，再运行 `node scripts/browser-smoke.mjs . backups/browser-test`。
也可设置 JCE_MODULE_ROOT 指向现有 Node 模块目录，JCE_CHROME_PATH 指向 Chrome 可执行文件。
测试在临时空 Profile 使用 Chrome 调试接口加载运行白名单；所有网站响应是合成样例，不读取日常登录，不修改真实画板。
原生 OPFS 测试文件读写与哈希真实，但测试选择器不代表 Windows 文件夹权限对话框。

## 构建与发布

运行 `powershell -ExecutionPolicy Bypass -File scripts/package.ps1` 执行回归与运行审计，生成 Release、Source ZIP 和 SHA256SUMS.txt；旧安装包归档于 dist 的往期版本目录。
Release 为 14 个运行文件；Source 额外包含维护文档、构建和合成测试。用户使用 Release 无需开发工具。
发布前必须独立解压核对条目、manifest、输入文件哈希，审计 Source，运行解压后的测试。
版本唯一来源为 manifest.json；version 与 version_name 应一致，UI 和后台从 manifest 读取版本。

提交前用 `git status` 和 `git ls-files` 检查白名单，不能将私人工作目录整体提交。发布附件必须对应同一提交的源码。
流程为审计 → 回归 → 构建/解压核验 → commit → tag → push → GitHub Release → 匿名访问与下载哈希核验。
使用 main 分支；新版本更新 manifest、CHANGELOG、发布说明与测试报告，再创建新的 Tag 和 Release，不能覆盖旧正式 Tag。

## 兼容与证据

保留严格 recordId/itemId 匹配、签名原样读取、默认并发、数据库 schema=3 和原目录/文件名。
不要把自动化通过当作真实账号通过，验证范围见 RELEASE_TEST_REPORT.md。
v0.4.2 稳定备份只保存在本机，不进入公开历史。更新保持原加载路径，回滚恢复旧运行文件并重载，不删除历史或图片。
源码公开但保留所有权利，不擅自更改 LICENSE。发布重大隐私、安全或功能问题时停止上线。
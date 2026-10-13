# 权限与数据处理

本插件只处理你已登录且有权访问的即梦画板，不要求提供账号密码、Cookie 或 Token，不重新生成、不扣积分、不修改画板。

## 使用的权限

- `scripting`：在当前即梦页面中执行只读资源查询，复用该页面正常登录状态。
- `downloads`：将已经读取、解码和计算 SHA 的图片保存到 Chrome 默认下载位置，并核对完成状态、大小和存在性。
- `sidePanel`：提供中文侧栏。
- `storage`：保存当前用户的界面/调度设置。任务及授权目录句柄保存在扩展自身 IndexedDB 中。
- 即梦域权限：读取有权访问的当前画板和资源。无需所有网页的 tabs 权限。
- `*.byteimg.com` 图片域权限：适配 CDN 的多个动态资源主机；实际下载代码进一步只允许 HTTPS 的 `*-dreamina-sign.byteimg.com` 主机及未缩放原生图片，拒绝其他域名、缩略图和不匹配的重定向。Chrome 主机匹配不能使用这种前缀内的部分通配，因此没有硬编码某几个 CDN 节点。

权限模型参考 [Chrome Tabs 权限说明](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions) 和 [主机匹配规则](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)。

## 数据保留与安全边界

历史任务、画板/资源身份、文件名、校验值、目录句柄及失败原因只保存在当前浏览器用户本地。资源签名 URL 只用于短时内存读取，不放进历史任务、导出报告或外发包。不上传图片、资源清单或登录资料到第三方，无默认遥测服务。

授权文件夹模式会回读磁盘文件并核对 SHA；Chrome 默认下载模式会对收到的 Blob 计算 SHA，再核对 Chrome complete、文件大小和 exists，不宣称它等同于授权目录的磁盘 SHA 回读。

插件会在批次结束、任务收尾及主动“保存报告”时生成本地报告，包含本人的画板/资源身份及本地下载信息。报告留在你选择的位置，分享前请自行确认内容。卸载会移除扩展本地数据，但不会删除已导出的图片；请不要把整个日常 Chrome Profile 或含私人调查数据的开发工作目录当作外发安装包。

外发 Release 包仅由白名单运行文件构成，Source 包只包含脱敏开发材料，不包含开发者个人历史、备份、响应 JSON 或索引。

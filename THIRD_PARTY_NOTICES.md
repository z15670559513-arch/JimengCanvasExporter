# 第三方与授权

运行包使用浏览器原生 API，无第三方运行库、字体、图标或图片素材，未内嵌第三方 CDN 脚本。
SHA-256 由 Web Crypto API 计算，图片由浏览器解码；测试 PNG 由合成代码生成，不含用户图片。

开发时使用 Playwright 1.62.1（Microsoft，Apache-2.0），通过 package.json 声明，未将其代码或浏览器二进制打包。
项目地址与授权文件：[microsoft/playwright](https://github.com/microsoft/playwright)、[LICENSE](https://github.com/microsoft/playwright/blob/main/LICENSE)。
Node.js、Chrome 和 PowerShell 为外部运行/开发工具，不随本项目分发。

项目自身源码保留所有权利，见 LICENSE。开发依赖的许可证不改变本项目授权方式。
本项目为第三方辅助工具，与即梦或 Chrome 官方无隶属关系，不包含即梦网页代码或用户内容。

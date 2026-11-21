# 第三方版权与许可说明

本说明随源码和应用安装包分发。应用自身代码的 MIT 许可证不会重新授权第三方字体、音频、标志或其他资源。本应用将相关版权与使用说明保留在随包文件，创作界面不设置额外的署名或许可入口。

## RhineLabUI

本软件的首页和三维档案交互基于 RhineLabUI 的原始代码与模型进行业务适配。

- 原仓库：https://github.com/LBEILC/RhineLabUI
- 记录的上游 commit：`12cc5e4013acb9408f753ff71de6b8492299b7c8`
- 保留版权：**Copyright (c) 2026 LBEILC**
- 授权：MIT License
- 可编辑源代码：`integrations/rhinelab-ui/`
- 上游完整许可证：`integrations/rhinelab-ui/LICENSE`
- 运行产物中的许可证：`public/rhine/licenses/RhineLabUI-MIT.txt`

上游 README 明确说明，作者有权授权的代码、自制 GLB、原创配乐及其他原创内容采用 MIT；额外的界面署名并非该许可证的强制条件。分发时仍保留其版权和完整许可文字：

```text
MIT License

Copyright (c) 2026 LBEILC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 字体与开场字形

**本软件使用 MiSans 字体。** MiSans 的权利归小米及其原权利人所有，遵循独立字体协议。字体分片保持原始字节；本软件保留以下文件：

- `public/rhine/fonts/NOTICE.txt`
- `public/rhine/fonts/MiSans-license.pdf`
- `public/rhine/fonts/misans-webfont-4.3.1/source.json`
- `public/rhine/fonts/misans-webfont-4.3.1/UPSTREAM-README.md`

开场中保留的预制英文字形轮廓，来源和使用说明见 `public/rhine/assets/boot-lettering-notice.txt`。其中 Novecento 字体设计权利归 Jan Tonellato / Synthview Type Design；预制图形的使用不等于取得其字体软件许可。集成构建不下载或携带作者专用的 Novecento 桌面字体及 webfont kit。新业务文字使用集成代码提供的普通文字回退方式。

## Three.js 与 Rolling Number

- Three.js：MIT License，Copyright © 2010–2026 three.js authors。完整许可随产物保存在 `public/rhine/licenses/Three-MIT.txt`。
- Rolling Number：MIT License，Copyright (c) 2026 Kit Langton。完整许可保存在 `public/rhine/licenses/rolling-number.txt`。

## 音频与原作相关权利

上游将 `atmosphere.ogg`、`motif.ogg` 和 `pulse.ogg` 声明为其原创程序编配的同步循环声部，采用上游 MIT 许可证。其来源说明以原仓库 `public/audio/README.md` 为准。

上游另有来自《明日方舟》PV的逐字短音，该部分不在其原创配乐的 MIT 授权范围内。本软件的业务适配已将可见品牌替换为 Guangxuan，并将键入声的播放分支替换为现有音色合成，不调用上游 PV 采样。品牌替换或移除采样并不重新授权原作品：游戏名称、标志、设定、PV、原片音频及其他第三方元素的权利仍归各自权利人所有，不能笼统视为本软件或上游作者的 MIT 内容。

## OpenFilm原生编辑器与电影格式

本应用在OpenFilm原始编辑器与电影格式上进行本地业务集成，使用独立的“光宣工作台”产品名称。此集成不是OpenFilm官方发行，也不表示原项目背书。

- 原仓库：[openfilm/openfilm](https://github.com/openfilm/openfilm)
- 集成版本：`packages/openfilm/package.json`中的 `0.3.2`
- 代码许可：MIT License，Copyright (c) 2026 OpenFilm contributors
- 保留原文件：`integrations/openfilm/LICENSE`、`integrations/openfilm/TRADEMARK.md`
- 包内相同说明：`integrations/openfilm/packages/openfilm/LICENSE`、`TRADEMARK.md`、`THIRD_PARTY_NOTICES.md`
- 共享代码许可：`integrations/openfilm/packages/shared/LICENSE`

商标说明独立于代码MIT许可证；OpenFilm名称与标志不能因代码授权而被当作本应用自己的品牌。这里对OpenFilm的名称使用是组件与格式说明。

**素材库不是统一MIT。** 实际许可文件为 `integrations/openfilm/packages/openfilm/library/LICENSE.md`：贡献者原创的模板、过渡、效果、文字、动画贴纸及所述声音资源按CC0 1.0提供；其中Microsoft Fluent Emoji另按MIT并保留Microsoft版权声明。用户导入、服务生成或额外取得的素材仍按其各自权利处理。是否包含某类资源，以实际分发目录为准。

原生UI及运行依赖的说明保存在上游 `THIRD_PARTY_NOTICES.md`，包括Inter字体的SIL OFL 1.1、React/React Flow等代码的MIT、Lucide等组件的ISC，以及 `playwright-core` 的Apache License 2.0。本集成将 `playwright-core 1.61.1` 放入根应用生产依赖，使用已安装Edge或Chrome；上游文档提到的默认下载浏览器行为，不代表本集成会自动下载浏览器。

打包时显式保留原生server、src、shared、library和完整Studio UI dist及其许可，不携带集成开发node_modules、用户工程、状态或密钥。版权、商标和素材文件随源码与发行包留存，不要求在创作界面增加额外署名入口。

## 其他组件

### 网址参考工具 yt-dlp

Windows发行包随附官方 yt-dlp **2026.10.26**，用于公开单视频网页的信息解析。主程序的许可证不改变该独立组件及其依赖的许可证。

- 固定版本与校验信息：`scripts/reference-downloader-manifest.json`
- 官方发行页：https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26
- 对应源码：https://github.com/yt-dlp/yt-dlp/tree/2026.10.26
- 源码归档：https://github.com/yt-dlp/yt-dlp/archive/refs/tags/2026.10.26.tar.gz
- yt-dlp源代码本体采用Unlicense；官方Windows合并可执行文件及其所含依赖整体采用GPL-3.0-or-later，详见官方README的Licensing章节。
- 发行包保留完整GPLv3、源码许可、官方README与校验清单，位于 `resources/third-party/reference-video/`；可执行文件位于 `resources/bin/yt-dlp.exe`。

打包器依据固定版本的官方SHA256校验工具，不携带用户浏览器资料、cookie或登录状态。获取脚本 `scripts/reference-downloader-setup.mjs` 可重现同版本下载和校验。

Electron、Chromium、React、Remotion、FFmpeg 及其他依赖保留各自许可证。具体分发来源及位置另见 `desktop/THIRD_PARTY.md`。

## PDF 导入运行时与本地字库

论文与教材PDF解析使用精确版本 unpdf 2.2.1（https://github.com/unjs/unpdf ，unpdf自身代码为MIT）。发行程序包含其完整普通包文件及LICENSE；内嵌PDF.js、JBIG2/OpenJPEG相关代码的各自许可一并保留在 `node_modules/unpdf/dist/licenses/`，不可将本应用或unpdf自身的MIT许可证视为对这些组件重新授权。

为在不联网的情况下提取常见中文CID PDF文字，程序从官方 pdfjs-dist 6.5.438 包中随附CMaps与standard_fonts纯数据。相关许可证与来源记录位于：

- `lib/science-pdf-assets/LICENSE_PDFJS`
- `lib/science-pdf-assets/cmaps/LICENSE`
- `lib/science-pdf-assets/standard_fonts/LICENSE_FOXIT`
- `lib/science-pdf-assets/standard_fonts/LICENSE_LIBERATION`
- `lib/science-pdf-assets/NOTICE.md`

Galgame人物立绘、表情及场景图片使用用户导入的素材，当前版本不再随附默认人物或场景绘图。Paper2Gal相关公开介绍只用于了解功能流程，未复制其人物、背景、音乐、品牌或业务代码。
## Video Shotcraft 源码参考库

本应用随附 Vincentwei1021/video-shotcraft 的一组原始源码文本，供AI查阅并按当前工程独立改写相机、运动、排版、媒体循环及可编辑时间线机制；这些文本不作为可执行内置模板或固定场景类型运行。

- 上游：https://github.com/Vincentwei1021/video-shotcraft
- 固定提交：075b548c2405a07b77129eb448b0b504fc60dea3
- 根许可证：Apache License 2.0；完整原文随附于 `lib/remotion-references/shotcraft/LICENSE`。
- 逐文件上游路径、Git blob SHA、SHA256、依赖与改写说明：`lib/remotion-references/shotcraft/origin-manifest.json`。全部 `.source.txt` 保留上游原始代码、注释和来源信息。
- 上游此提交没有单独的NOTICE文件；镜头研究来源说明一并保留于 `lib/remotion-references/shotcraft/UPSTREAM_ATTRIBUTION.md`。未随附其视频、音乐、截图、品牌或其它媒体资产；引用来源不代表对来源作品取得授权。

此参考库的加载器和检索接口是Gx新增代码；上游源码文本仍按其Apache-2.0许可及原出处提供。AI生成到用户工程的代码会按实际用途适配，不能据此把整个Gx、Remotion或第三方媒体重新授权。

## 本次公开 Windows 发行

公开安装器和便携包使用 `-PublicDistribution` 构建，不随包附带 FFmpeg、FFprobe、yt-dlp 或 Remotion 原生 compositor。首次启动从固定官方来源取得完整组件、校验并写入用户数据目录的工具缓存。此前描述随包媒体工具的段落适用于常规开发构建；本次公开发行以 `COPYRIGHT.md`、`THIRD_PARTY_SOURCES.md` 和 `scripts/distribution-runtime-manifest.json` 为准。各原始许可与源码入口保持提供。

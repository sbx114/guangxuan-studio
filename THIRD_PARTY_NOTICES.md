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

## 其他组件

Electron、Chromium、React、Remotion、FFmpeg 及其他依赖保留各自许可证。具体分发来源及位置另见 `desktop/THIRD_PARTY.md`。

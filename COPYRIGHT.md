# 版权与许可

Gx · 光宣工作台（Guangxuan Studio）由 sbx114 发布和维护。

本项目新增及修改的自有代码：**Copyright (c) 2026 sbx114**。既有项目代码保留 **Copyright (c) 2026 Guangxuan Studio contributors**。项目自有代码按随附的 MIT 许可证提供；这一许可不改变第三方代码、字体、模型、音频和其他素材的权利。对第三方代码的修改仍须遵守原许可。

## 主要第三方来源

| 组件或资源 | 原作者与来源 | 适用许可及范围 |
| --- | --- | --- |
| RhineLabUI 首页及三维交互 | Copyright (c) 2026 LBEILC；[LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)，提交 `12cc5e4013acb9408f753ff71de6b8492299b7c8` | MIT；仅涵盖作者有权授权的原创内容。第三方字体、原作品名称、标志、设定及音频采样不因此获得授权。 |
| OpenFilm 编辑器与格式 | Copyright (c) 2026 OpenFilm contributors；[openfilm/openfilm](https://github.com/openfilm/openfilm)，集成版本 `0.3.2` | 代码为 MIT；商标说明另见 `TRADEMARK.md`。本产品为独立集成，不是 OpenFilm 官方发行。 |
| OpenFilm 素材库 | OpenFilm contributors；Microsoft Corporation | 库内标明的原创素材为 CC0 1.0；Fluent Emoji 为 MIT。以库内 `LICENSE.md` 为准。 |
| Video Shotcraft 源码参考 | Copyright 2026 Wei Yihao；[Vincentwei1021/video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft)，提交 `075b548c2405a07b77129eb448b0b504fc60dea3` | Apache License 2.0；保留原始源码文本、完整许可、来源清单及 `UPSTREAM_ATTRIBUTION.md`。 |
| Electron / Chromium | Electron contributors / Chromium 及其第三方作者 | 按各自许可分发。桌面包根目录的 `LICENSE` 为 Electron 许可，`LICENSES.chromium.html` 为 Chromium 第三方许可。 |
| React / React DOM | Meta Platforms, Inc. and affiliates | MIT；完整版权和许可位于相应依赖目录。 |
| Remotion `4.0.543` | Copyright © 2026 Remotion | Remotion Free / Company License，完整原文位于 `node_modules/remotion/LICENSE.md`。它不采用本项目 MIT 许可。使用者须按自身组织及用途满足[对应版本的许可](https://github.com/remotion-dev/remotion/blob/v4.0.543/LICENSE.md)；[官方说明](https://www.remotion.dev/docs/license)和[许可问答](https://www.remotion.dev/docs/license/faq)提供进一步指引。 |
| FFmpeg / FFprobe `9.0.2` | Copyright (c) 2000–2026 the FFmpeg developers；Gyan Windows essentials 构建 | 此构建启用 GPL 和 version3，按 GPLv3 或后续版本提供，作为独立程序调用。本次发行由应用首次配置时直接从官方取得工具；原始许可和构建说明随应用保留在 `resources/third-party/ffmpeg`。 |
| yt-dlp `2026.10.26` | yt-dlp contributors 及其所含依赖的作者 | 源码本体为 Unlicense；官方 Windows 合并可执行文件整体为 GPL-3.0-or-later。本次发行由应用首次配置时直接从官方取得工具；GPL、源码许可、README 和官方校验清单随应用保留在 `resources/third-party/reference-video`，完整第三方许可提供固定版本官网链接。 |
| Remotion 原生 compositor `4.0.543` | Remotion contributors；所含 FFmpeg 与编解码库原作者 | 本次发行由应用首次配置时取得官方完整平台组件。其 FFmpeg 构建代码按 GPL-2.0-or-later，Remotion 自身按独立 Free / Company License，不能混为本项目 MIT。 |
| MiSans | Beijing Xiaomi Mobile Software Co., Ltd. / 小米 | 独立字体协议，完整原文和来源位于 `public/rhine/fonts/`；字体不按本项目 MIT 重新授权。 |
| 开场预制英文字形 | Jan Tonellato / Synthview Type Design 的 Novecento 字体设计 | 随附的是固定字形图形；来源及使用说明见 `public/rhine/assets/boot-lettering-notice.txt`。未随附 Novecento 桌面字体或需单独许可的 webfont kit。 |
| PDF 解析与数据 | unpdf、PDF.js 及其依赖原作者 | 各自的 MIT、Apache 2.0、BSD 等许可随依赖与 `lib/science-pdf-assets/` 保留，不能统一视为本项目 MIT。 |

更完整的组件、素材和归属说明见 `THIRD_PARTY_NOTICES.md` 与 `desktop/THIRD_PARTY.md`，以及各组件目录中的 LICENSE、NOTICE 和来源记录。桌面发行包中，应用文件通常位于 `resources/app/`；其中路径按该目录解析。

## 源码与再分发

当前应用源码随同版本的 GitHub Release 提供，含本项目修改和集成源码。再分发时，应保留本文件、项目 MIT 许可和所有适用的第三方许可、版权与来源说明。

本次安装器和便携包不附带上述独立媒体工具和 Remotion 原生 compositor，首次配置时直接从官方来源取得固定版本并校验，写入应用用户数据目录。首次配置需要联网，随后使用本地缓存。来源、工具许可与上游源码入口见 `THIRD_PARTY_SOURCES.md`。工具缓存不应混入本项目的 GitHub Release。

若自行再分发 GPL 工具，其完整对应源码与必要构建材料获取方式须与二进制下载一并提供。项目源码归档与 GPL 组件的完整对应源码是不同范围；前者不能替代后者。GPL 不要求下载者同时下载源码，但工具发行者须维持合规的源码获取途径。

用户导入的工程、图片、视频、音乐、字体及生成内容按其实际权利和使用条件处理。本项目的许可不授予第三方商标权，也不表示各上游作者为本产品背书。

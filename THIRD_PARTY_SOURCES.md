# 第三方工具来源与源码

本次应用发行提供项目当前完整源码与集成修改。媒体工具由应用在首次配置时直接从官方来源获取固定版本并验证完整性；这些工具的下载缓存不随 GitHub 安装器、便携包和项目源码分发。首次配置需要联网，下载后使用本地缓存。

## FFmpeg / FFprobe

本应用使用 Gyan 的 FFmpeg `9.0.2-essentials_build`。该构建采用 GPLv3 或后续版本，作为独立工具运行；不是本项目 MIT 许可的组成部分。

- [固定版本官方发行](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)
- [Gyan 构建说明](https://www.gyan.dev/ffmpeg/builds/)
- [该发行标明的 FFmpeg 源码提交](https://github.com/FFmpeg/FFmpeg/commit/946fcce07b)
- [FFmpeg 官方许可说明](https://ffmpeg.org/legal.html)

应用保存的 `scripts/ffmpeg-manifest.json` 与 `scripts/distribution-runtime-manifest.json` 记录固定下载、同版本官方 GitHub 备用来源与 SHA256。官方包内的 LICENSE、README 和构建说明随应用保留在 `resources/third-party/ffmpeg`；下载的二进制和校验记录写入用户工具缓存。本体源码提交与该 Windows 构建所链接的全部外部库源码不是相同范围；若要自行再分发工具，应另外遵守相应许可的完整对应源码要求。

## yt-dlp

本应用使用官方 Windows x64 `yt-dlp.exe 2026.10.26`。项目源码本体采用 Unlicense；Windows 合并可执行文件及所含依赖整体采用 GPL-3.0-or-later。

- [固定版本官方发行](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26)
- [固定版本本体源码](https://github.com/yt-dlp/yt-dlp/tree/2026.10.26)
- [官方 Licensing 说明](https://github.com/yt-dlp/yt-dlp/tree/2026.10.26#licensing)
- [完整第三方许可](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/THIRD_PARTY_LICENSES.txt)
- [Windows 构建 workflow](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/.github/workflows/build.yml)
- [固定版本依赖清单](https://github.com/yt-dlp/yt-dlp/tree/2026.10.26/bundle/requirements)

应用的 `scripts/reference-downloader-manifest.json` 与 `scripts/distribution-runtime-manifest.json` 记录固定版本、大小和已核对官方清单的 SHA256；首次运行将下载字节与固定清单中的 SHA256 比较，不另发起校验清单请求。官方 SHA2-256SUMS、GPL、源码许可和 README 随应用保留在 `resources/third-party/reference-video`，完整第三方许可通过上述固定版本官方链接提供。二进制和本次校验记录写入用户工具缓存。Python 本体、合并的 Python 包及底层库按各自许可处理，不能以一个 yt-dlp Git 源码归档代表所有合并依赖。

## Remotion 原生渲染组件

本应用使用 `@remotion/compositor-win32-x64-msvc 4.0.543` 的官方完整组件，与相同版本的 Remotion JavaScript 运行时配合。组件含其专用 FFmpeg、FFprobe 与共享库。

- [固定版本原始组件源码仓库](https://github.com/remotion-dev/remotion/tree/v4.0.543/packages/compositor)
- [该版本 FFmpeg 构建说明、源码链和补丁](https://github.com/remotion-dev/remotion/tree/v4.0.543/packages/compositor/ffmpeg)
- [固定下载资产及 SHA256](https://github.com/remotion-dev/remotion/blob/v4.0.543/packages/compositor/ffmpeg/assets.json)
- [官方 FFmpeg 许可说明](https://www.remotion.dev/docs/miscellaneous/ffmpeg-license)
- [Remotion 自身许可原文](https://github.com/remotion-dev/remotion/blob/v4.0.543/LICENSE.md)

FFmpeg 构建代码按 GPL-2.0-or-later 提供；Remotion 自身使用 Free / Company License，两者须分别遵守。工具取得方式、版权说明和源码链接不会扩大 Remotion 对使用组织及用途的许可。

## 其他随包运行时

Electron、Chromium 及其他随包依赖保留各自版权和许可全文。Electron 版本来源、源码入口及 Chromium 第三方许可位置见 `desktop/THIRD_PARTY.md`；各平台二进制实际分发范围以发行清单为准。

本项目新代码 © 2026 sbx114，并保留 Guangxuan Studio contributors 与所有第三方原作者。详细归属见 `COPYRIGHT.md`、`THIRD_PARTY_NOTICES.md` 及每个组件自己的许可文件。

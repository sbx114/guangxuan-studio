# 第三方组件

光宣工作台自身的界面、流程、模板和后端代码使用仓库根目录的 MIT 许可证。第三方组件保留各自许可证，不因本项目的许可证而重新授权。

## Electron 与 Chromium

便携包使用 Electron 45.3.3。Electron 许可证和 Chromium 第三方许可证位于便携包根目录的 `LICENSE` 与 `LICENSES.chromium.html`。

- 分发来源：https://github.com/electron/electron/releases/tag/v45.3.3
- Electron 源码：https://github.com/electron/electron

## Remotion

动画模板通过 Remotion 4.0.543、`@remotion/bundler` 和 `@remotion/renderer` 渲染。Remotion 使用其自身的 Free / Company 许可证，条款随安装包中的 `node_modules/remotion/LICENSE.md` 保留。

- 许可证：https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
- 使用条件：https://www.remotion.dev/docs/license

React 与 React DOM 19.2.4 使用 MIT 许可证，许可证保留在各自的依赖目录中。

## FFmpeg 与 FFprobe

Windows 便携包包含未经修改的 Gyan FFmpeg 9.0.2 essentials 构建中的 `ffmpeg.exe` 与 `ffprobe.exe`，由本应用作为独立进程调用。此构建使用 GPLv3；完整许可证、原始分发说明和构建配置位于 `resources/third-party/ffmpeg`。

- FFmpeg 官方下载入口：https://ffmpeg.org/download.html
- Windows 构建来源：https://www.gyan.dev/ffmpeg/builds/
- 精确分发及 SHA256：`scripts/ffmpeg-manifest.json`
- 上游源码版本：https://github.com/FFmpeg/FFmpeg/commit/946fcce07b

源码仓库不包含上述工具的二进制文件。构建脚本从上游下载固定版本并验证 SHA256。再次分发便携包时须保留第三方许可证及对应的分发义务。

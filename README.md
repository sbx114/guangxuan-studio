# Gx · 光宣智作

**AI 文案、视频剪辑、Remotion 动画与科普视觉小说工作台。**

Gx 将材料整理、内容写作、动画创作和多轨剪辑放在同一套本地工程中。你可以直接编辑，也可以与 AI 助手对话，让它读取工程、安排步骤、执行修改并返回实际结果。项目可保存、撤销、备份和继续创作。

[下载安装](https://github.com/sbx114/guangxuan-studio/releases) · [使用指南](docs/使用指南.md) · [版权归属](COPYRIGHT.md) · [第三方许可](THIRD_PARTY_NOTICES.md)

## 功能

| 工作区 | 可以做什么 |
| --- | --- |
| 视频剪辑 | 素材导入、预览、多轨时间线、片段分割与修剪、自由放置、变速、混音、画布变换、调色、关键帧、字幕与成片导出 |
| Remotion 动画 | 从空白创建或修改多文件 React/TSX 工程；使用图形、SVG、Canvas 和本机素材；编辑源码、编译、生成预览、小样并渲染 MP4 |
| AI 助手 | 读取当前工程和功能目录，搜索与阅读公开资料，导入素材，修改文案、动画和时间线；显示执行步骤、文件结果、改动差异与撤销入口 |
| 文案写作 | 导入 TXT、Markdown、Word 或文字型 PDF，起草、精修、局部修改；可选参考内容或写法，保留来源并导出稿件 |
| 科普视觉小说 | 选择原文页段、公用人物和场景，生成分阶段讲解、知识卡与互动问答，制作离线阅读包 |
| 工程管理 | 三维项目档案、名称与封面、任务中心、版本记录、导出前检查，以及包含媒体和资料的 `.gxproject` 完整项目包 |

动画创作使用可编辑的 Remotion 源码，无需选择固定模板。AI 助手可读取和操作整个当前工程；界面素材勾选、片段选择与放置设置作为参考。对话中的明确范围要求仍生效，并保留版本冲突检查和撤销记录。原生时间线与源时间不再受一小时或一天的业务上限限制。

发现可修复问题后，助手会接着修改和复查；缺少动作、停留、收尾或转场对照时，会补取对应画面。源码修改后，相关检查按当前版本重新确认，已有时间线结果也需同步更新。未检查的范围单列说明，**未完成**只列当前要求仍欠缺的部分；真实服务障碍或连续处理没有进展时，会说明具体原因并保留已有结果。

素材分析支持本地镜头变化检测和关键帧抽样。语音转写、图片理解与视觉摘要使用你配置的兼容模型服务；成功结果可供助手和剪辑规划引用。视频抽样是局部观察，字幕时间仍需结合实际成片复核。

## 下载安装

当前版本为 **0.2.1 / Windows x64**（2026-11-23 实际流程复查修复）。在 [GitHub Releases](https://github.com/sbx114/guangxuan-studio/releases) 获取安装器、便携包、完整源码包和 SHA256 校验文件。

1. **安装版**：运行 `Gx-0.2.1-Windows-x64-Setup.exe`，选择安装目录。安装面向当前 Windows 账户；从开始菜单的 **Gx** 或安装目录的 **Gx.exe** 打开。
2. **便携版**：完整解压 Windows x64 程序包，双击 **Gx.exe**。请保留整个目录，运行文件与依赖需一起使用。
3. **连接模型**：在 **模型连接** 填写服务地址、模型名称和 API 密钥。需要跨次恢复时勾选 **在本机加密保存密钥**，保存后测试连接。

正常使用原生 **Gx.exe** 无需预装 Node.js。Remotion 和原生剪辑导出需要本机的 Microsoft Edge 或 Google Chrome。`启动Gx.cmd` 是兼容入口，需要 Node.js 24 或更高版本及 Edge。

发行安装器尚未进行代码签名，可使用发布页的 SHA256 校验下载文件：

```powershell
Get-FileHash .\Gx-0.2.1-Windows-x64-Setup.exe -Algorithm SHA256
```

## 创作与数据

在首页新建或打开文案、视频、科普项目。剪辑可先导入素材，也可直接向助手描述目标，例如“把当前素材剪成 30 秒，保留原声并加标题”或“重新设计这段动画，先编译并检查预览，再渲染加入时间线”。制作结果以已保存文件、实际工程改动和完成的任务为准。

参考功能支持文字、图片、视频及可公开访问的单视频网址。可以分别设置借鉴维度、参考片段和作品应用位置；自由创作时可以不填写作品时间区间。网址读取受网站访问条件及所支持媒体格式影响。

原生版项目与设置默认保存到 `%APPDATA%\Guangxuan Studio`，兼容入口保存到 `%LOCALAPPDATA%\GuangxuanStudio`。通过 `.gxproject` 可备份完整工程及关联媒体，并恢复为新项目。安装器卸载保留工程与设置；升级前请保存并退出应用。

AI 请求会将任务所需材料发送给你选择的服务。密钥由本机存储机制保存；发行包与源码不包含用户密钥、个人工程或测试会话。详细说明见 [隐私说明](PRIVACY.md)。

## 源码运行与构建

源码开发需要 **Node.js 24+**。仓库包含当前应用源码、OpenFilm/RhineLabUI 集成源码、许可证及已构建的界面资源；公开安装包附带 Electron 与应用依赖；视频工具及 Remotion 原生组件在首次启动时从固定官方来源下载并校验。

```powershell
npm install
npm start
```

也可执行 `npm run desktop:local` 启动兼容窗口，或 `npm run web` 启动本地服务。准备 FFmpeg 后，将输出目录用于媒体运行时：

```powershell
$gxFFmpegDirectory = .\scripts\get-ffmpeg.ps1
$env:GUANGXUAN_BIN_DIR = Join-Path $gxFFmpegDirectory 'bin'
npm test
```

首页源码位于 `integrations/rhinelab-ui/`，首次重建可运行 `npm run build:home -- --install`。原生编辑器源码位于 `integrations/openfilm/`；修改其 UI 后，在准备好集成工程依赖的情况下运行 `npm --prefix integrations/openfilm/packages/openfilm run build:ui`。

```powershell
node scripts/package-openfilm-runtime.mjs --check
.\scripts\build-windows.ps1 -PublicDistribution -CreateZip
```

便携构建默认输出到 `dist/Gx-Windows-x64`。打包脚本检查原生 UI、生产依赖及第三方许可，并校验下载运行时的 SHA256。常规检查使用 `npm test`；设置 `GUANGXUAN_TEST_ANIMATION=1` 和 `GUANGXUAN_TEST_OPENFILM=1` 可启用需要浏览器与媒体运行时的集成验证。

已构建的 OpenFilm UI 位于 Git 跟踪文件中。重新构建会生成新文件名；提交更新时需显式包含受上游忽略规则影响的 `integrations/openfilm/packages/openfilm/studio/ui/dist`。构建与安装步骤见 [使用指南](docs/使用指南.md)。

## 版权与开源来源

Gx 项目的原创代码与适配改动采用 [MIT 许可证](LICENSE)，版权归属详见 [COPYRIGHT.md](COPYRIGHT.md)。第三方源码、字体、素材和运行时保留各自许可证，项目许可证不替代上游协议。

- [OpenFilm](https://github.com/openfilm/openfilm)：原生剪辑编辑器及工程能力；保留其许可证、商标和素材说明。
- [RhineLabUI](https://github.com/LBEILC/RhineLabUI)：首页与三维档案界面的源码基础。
- [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft)：Remotion 动效与源码创作机制参考。
- Remotion、React、Electron、FFmpeg、yt-dlp、PDF.js 和字体等组件的版本、许可及源码信息见 [第三方声明](THIRD_PARTY_NOTICES.md)。

本项目为独立软件。上游名称用于说明来源；请按所使用代码、素材和运行时的具体许可进行使用与再分发。

## Windows 安装器构建

使用固定版本 NSIS 3.13 编译器，在公开便携包构建完成后运行：

```powershell
.\packaging\windows\build-installer.ps1 -PayloadRoot .\dist\Gx-Windows-x64 -CompilerPath C:\NSIS\makensis.exe -OutputDirectory .\dist\installer
```

安装器面向当前账户，保留用户创建的工程与设置；卸载按明确文件清单移除安装内容。发布包不包含个人资料、测试过程或下载工具缓存。


## 素材依据与可执行制作安排

素材分析按真实 FFmpeg 画面变化估计与前后采样帧建立依据，记录实际源时间、帧哈希、主体主次、构图留白、观察到的运动和候选片段用途。镜头与素材可分页继续分析；两帧之间的变化仍属于有限观察，不代表逐帧看完或完整动作确认。技术参数、文件名和未转写声音不会被当作已识别内容。

剪辑安排可关联这些素材 cue，说明所选片段用途，核对入出源段，再应用实际速度、画面运动、滤镜与淡入淡出。字幕排版使用经过本机测量的换行、字号、位置与宽度；字幕源时码按最终片段入出点及实际速度映射。Remotion 导演安排会保留素材出处与证据边界，并将镜头运动、停留和转场安排落实到可编辑代码。

本轮同时保留此前执行闭环：按当前要求继续修正可修问题及必要检查，源码变化后重新确认相应结果，更新已有时间线产物并保留撤销。实际接口阻断或持续无进展会明确报告已保存结果和剩余事项。


## 助手持续恢复与文案窗口

文案页面可打开共享的文案或项目助手，选择自动处理/仅问答，以及当前稿件或选中文字作为参考。模型连接与写作偏好沿用已有设置；当前对话决定实际目标，文案读写保留版本冲突保护和撤销。

助手按服务端保存的原任务、模式与已确认结果恢复工作。进度连接断开时继续读取状态；可恢复任务使用原任务ID续接，不重复已成功写入。旧任务缺少恢复凭据时说明真实原因并保留结果，仍可按当前对话提出新要求。

需要联网的写作请求可将当前对话授权的搜索或已读网页材料用于文章起草与精修；材料保留来源和覆盖范围，网页内容作为数据处理，不能把助手操作说明或未知网页信息当作用户已提供的事实。公开网页不可访问时会说明真实障碍。

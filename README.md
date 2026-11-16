# 光宣工作台

面向学院宣传的本地创作应用。首页的三维项目方块对应实际保存的项目：选中方块进入详情，修改名称与简介，确认后打开相应编辑工作区。

视频工作区集成OpenFilm原生编辑器，文案工作区负责素材核对与多种内容写作。文案、AI粗剪和Remotion动画可以接续到同一个视频工程。独立科普工作室仍为后续规划。

## 当前功能

| 功能 | 行为 |
| --- | --- |
| 真实项目档案 | 方块与项目ID一一对应；空档案不生成虚构项目；详情展示名称、简介、内容统计与最近修改时间 |
| 项目资料 | 标题和简介单独保存，旧自动保存不会覆盖刚修改的名称 |
| 原生视频编辑 | 原生素材、预览、多轨时间线、属性、画布、字幕和导出；确认进入编辑后载入对应工程 |
| 文案写作 | 导入资料、提取并确认事实，生成推文、海报文案、分镜、社群文案，支持修改、核查和导出 |
| AI粗剪 | 根据实际媒体元数据与脚本生成方案；检查后应用到原生主画面轨 |
| AI动画 | 可编辑场景JSON，经本机Remotion渲染为MP4，再追加到原生时间线 |
| 备份与导出 | 文案导出Word、Markdown、PNG、JSON及制作记录；视频导出MP4，完整备份以原生工程目录为准 |

AI粗剪不进行视频画面识别。方案绑定原生工程版本；生成后若工程已修改，应用会拒绝过期方案并要求重新检查。主轨混有无法完整表示的HTML、外部链接、禁用或不可读片段时，粗剪不能直接应用；其它独立原生轨道保留。工作台的字幕拟定属于文案估时，不等于语音识别。

## 启动与安装

完整解压 **光宣工作台-Windows-x64**，双击 **启动光宣工作台.cmd**，使用已安装的Node.js 24和Edge打开独立工作窗口。桌面安装版可直接使用“光宣工作台”快捷方式。

本次交付环境的DeviceGuard策略阻止新Electron可执行文件，因此提供标准Edge兼容入口，不修改组织策略。**光宣工作台.exe** 保留给允许运行的设备。FFmpeg与FFprobe随发行目录提供；原生导出和Remotion使用已有Edge或Chrome。

关闭窗口会保留本地后台。需要结束服务时使用 **停止本地服务.cmd**；需要加载后端更新时先保存项目，再使用 **重启光宣工作台.cmd**。启动器会复用仍健康的服务，不自动把密钥改发到其它端口。

可通过 `scripts/install-desktop.ps1 -SourceRoot '完整程序包目录'` 安装到 `%LOCALAPPDATA%\Programs\GuangxuanStudio` 并创建桌面快捷方式。安装器校验原生编辑器、生产依赖和许可文件，不复制用户数据。

## 项目数据与备份

兼容入口使用 `%LOCALAPPDATA%\GuangxuanStudio`：

| 位置 | 内容 |
| --- | --- |
| `projects/<项目ID>.json` | 项目名称、简介、来源、文案、记录及保留的旧剪辑数据 |
| `openfilm/projects/<项目ID>/film.html` | 当前原生电影文件，是新视频编辑的依据 |
| `openfilm/projects/<项目ID>/assets/`、`pages/`、`.film/` | 工程媒体、页面片段、原生画布、设置及历史 |
| `openfilm/projects/<项目ID>/legacy-project.json` | 首次迁移时保存的旧项目快照 |
| `openfilm/state/` | 本应用隔离的原生编辑器状态与配置 |
| `openfilm/exports/` | 原生导出文件 |

首次迁移保留原JSON，之后原生剪辑写入电影工程；项目详情改名只更新相应元数据。不会读取或修改用户的 `~/.openfilm`。

新复制的素材使用安全化原文件名加短ID，字幕页使用序号，便于在时间线识别；已有工程的文件名与片段顺序不批量改写。

**视频完整备份不能只保存JSON。** 应使用原生工程导出或保存完整工程目录，包含媒体、页面和需要保留的历史；若使用外部链接素材，先将媒体收集进工程。还原光宣档案中的名称和来源时，同时保留对应Root JSON。文案项目可使用JSON备份恢复其内容。

## 连接AI

打开 **模型连接**，填写中转API基础地址、模型ID和密钥。支持Chat Completions与Responses，JSON模式按接口能力开启；模型列表不可用时手动填写ID。测试连接会发出真实短请求。

工作台中转密钥默认仅当前会话使用；Electron版可选择系统加密保存。原生编辑器的可选服务配置独立，按其设置保存在本应用的 `openfilm/state/`，不会自动继承宿主环境里的模型密钥。

主动使用AI时，所需资料、脚本或元数据会发送到选定接口。本地编辑、读取工程和渲染不需要把媒体交给中转站。预置文案、动画方案都标明 **预置演示，非本次实时AI生成**，没有编造的调用次数、反馈或提效数据。

## 页面复用与暂停

首页、详情和原生编辑器之间切换时保留已加载的工作区。返回前等待待写入操作完成，再次进入同一项目可继续编辑；后台会话变化时会刷新失效缓存。隐藏首页暂停3D渲染，隐藏编辑器暂停播放；已提交的后台导出任务仍可继续。

已完成的界面验收包括：真实项目选择、改名保存、确认进入原生编辑器、返回后保留详情、再次进入复用编辑器。具体等待时间取决于机器和工程，不以单次测试作为性能承诺。

## 源码运行与打包

需要Node.js 24或更高版本：

```powershell
npm install
node server.mjs
```

也可使用 `npm run desktop:local` 打开兼容窗口；`npm start` 为Electron入口。源码模式通过 `GUANGXUAN_BIN_DIR` 或分别设置 `GUANGXUAN_FFMPEG`、`GUANGXUAN_FFPROBE` 指向已有媒体运行时。

首页直接修改 [RhineLabUI原始源码](https://github.com/LBEILC/RhineLabUI)，位于 `integrations/rhinelab-ui/`，并接入真实项目记录。首次准备构建依赖可运行 `npm run build:home -- --install`，之后使用 `npm run build:home`；已有产物用 `--copy-only` 发布到 `public/rhine/`。

原生编辑器源码位于 `integrations/openfilm/`。修改原生UI后，在已准备构建依赖的集成工程执行 `npm --prefix integrations/openfilm/packages/openfilm run build:ui`，保证 `studio/ui/dist/index.html` 存在。

```powershell
node scripts/package-openfilm-runtime.mjs --check
npm run build:win
```

打包器显式复制OpenFilm的server、src、shared、library、完整UI dist和许可文件，忽略集成node_modules及用户目录。`playwright-core` **1.61.1** 是根项目生产依赖，发行包和安装器都会检查；不能只复制主应用的public目录。

原生UI dist受上游Git忽略规则影响。发布已构建源码时需显式纳入：

```powershell
git add -f integrations/openfilm/packages/openfilm/studio/ui/dist
```

否则接收方必须先构建原生UI；打包器会明确拒绝缺少产物的包。运行时白名单可查看 `scripts/package-openfilm-runtime.mjs`，单独复制到暂存应用目录可用 `--destination <resources/app目录>`。最终发行/安装同步应保留用户数据目录。

## 验证与许可

`npm test` 运行常规检查。真实媒体集成测试需配置FFmpeg目录；设置 `GUANGXUAN_TEST_ANIMATION=1`、`GUANGXUAN_TEST_OPENFILM=1` 可启用Remotion和原生导出验证。测试覆盖版本冲突、主轨保护、原JSON保留、原生MP4导出和摘要更新时间，不等于用户效率或准确率实验。

- [使用指南](docs/使用指南.md)
- [参赛演示](docs/参赛演示.md)
- [第三方版权与许可](THIRD_PARTY_NOTICES.md)

光宣自身代码采用 [MIT许可证](LICENSE)。第三方代码、字体、品牌和素材遵循各自规则；许可证与版权声明随源码及发行文件保留，不添加到创作界面作为额外署名入口。OpenFilm代码的MIT、商标说明和素材库许可分别保留，不能把所有库素材统称为MIT。

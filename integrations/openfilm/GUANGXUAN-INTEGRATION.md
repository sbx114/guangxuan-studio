# 光宣 Studio 集成

本目录直接复用 OpenFilm 的格式、Studio、时间线、画布、Inspector、编辑事务、撤销和渲染核心，不包含其 Electron/聊天应用。

上游：https://github.com/openfilm/openfilm

记录版本：`0bc08008d933af7d42ef73a53cae384e2f54e6eb`。MIT 版权和原第三方说明保留在本目录。界面品牌使用光宣工作台，不表示本应用属于 OpenFilm 官方。

根项目执行 `node scripts/build-openfilm.mjs` 生成 `packages/openfilm/studio/ui/dist`，依赖缺失时可显式加 `--install`。不执行上游 CLI 的自动安装或浏览器下载。

Studio 由根应用的独立 Node worker 通过 `startStudio` 启动，不运行 `openfilm open` CLI。worker 在导入前固定 `OPENFILM_HOME`、`OPENFILM_SHARED_HOME`、`OPENFILM_LIBRARY`、`OPENFILM_EXPORTS`、`OPENFILM_SAVED`，全部位于应用自己的数据目录。`OPENFILM_LOCAL_ONLY=1` 禁用官方账号、自动在线目录和自动更新；用户可主动填写自己的服务密钥，主工作台的中转密钥不自动传入，也不自动采用宿主环境中的服务密钥。

`OPENFILM_BROWSER_EXECUTABLE` 指向已安装的 Edge/Chrome，FFmpeg/ffprobe 由worker的PATH提供。运行时npm依赖仅为根项目精确版本的 `playwright-core`；UI的React、Vite、Tailwind等只在构建时使用。发行时保留本目录源码、library、shared、manual及UI产物，不需要携带集成目录的node_modules。

编辑器使用127.0.0.1独立端口，电影页面使用localhost的另一端口。不要合并这两个origin。`OPENFILM_EMBED_ORIGIN` 为主应用的精确本机origin，Studio允许其嵌入，电影页面继续只读。launch key只在受控wrapper内部传递，不应记录到日志或对外展示。

`.guangxuan-project.json` 标记受主应用管理的项目，其title用于显示名称；目录改名和整项目删除由主工作台完成。原生媒体/轨道/画布编辑保持可用。

父wrapper通过 `guangxuan:studio-project` 选择本窗口的nativeProjectId，嵌入页忽略全局WS open通知。`studio-visibility`暂停隐藏窗口播放，保留编辑器；`studio-flush`等待原生舞台、film写入队列与画布保存后回应，帮助切换项目保留最后一次编辑。

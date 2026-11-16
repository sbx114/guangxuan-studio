# 光宣工作台内嵌入口

本目录直接修改 RhineLabUI 的源代码，保留原来的 Three.js 档案场景、GLB 模型、玻璃材质、镜头运动、档案解密、滚动文字、启动轨迹和界面布局。原始 MIT 许可保存在 `LICENSE`。

## 构建

需要 Node.js 20.19+ 或 22.12+，本次使用 Node.js 24 与 pnpm 11。

```sh
pnpm install --ignore-scripts
pnpm run build
```

`prebuild` 只运行仓库原有的 rolling-number 测字补丁。构建不恢复作者专有的 Novecento 字体，不生成或注册 PWA。`dist/` 是 `/rhine/` 部署目录的内容，由光宣主应用复制到 `public/rhine/`。

## 父子页面协议

父页面以同源 iframe 加载 `/rhine/index.html?embed=1`。三维资源就绪后，子页面发送：

```js
{ type: "guangxuan:ready" }
```

项目列表由父页发送，子页只保留ID、名称、类型、简介、时间与统计等元数据：

```js
{ type: "guangxuan:projects", projects: [projectSummary], selectedId }
```

每个真实ID只有一个有限网格位置，没有无限重复档案。空列表不会生成占位项目。单击立方体打开原版抽取/详情动画，可修改名称和简介；只有明确点击“进入编辑”才发送：

```js
{ type: "guangxuan:edit-project", projectId }
```

保存信息使用请求回执，不会将本地输入误报为已保存：

```js
{ type: "guangxuan:update-project", projectId, title, description, requestId }
// parent response
{ type: "guangxuan:project-updated", requestId, project, error }
```

顶栏项目和模型入口仍支持：

```js
{ type: "guangxuan:open", view: "video" | "writer" | "archive" | "settings" }
```

消息仅发送给同源父页面，接收时同时核验父窗口身份和origin。此入口不读取API密钥或项目正文，不发起模型请求。新建按钮发送 `guangxuan:new-project`，由父页创建真实项目。

父页可用 `guangxuan:select-project` 定位存在的ID，并以 `detail:true` 打开详情；不存在的ID会被忽略。`guangxuan:editor-status` 用于显示编辑器的准备状态或错误。

主页iframe保持挂载，父页用 `guangxuan:visibility` 暂停或恢复显示。隐藏时停止主RAF并暂停声音；恢复时修正逻辑时间，保留renderer、模型与材质。默认均衡预设保留玻璃效果，使用AO16、半分辨率遮蔽和DPR上限1；空闲30fps，交互60fps。显式选择的高画质保留。

初次打开保留原启动轨迹，时间压缩为资源就绪后约5.3秒，可随时跳过。正常返回首页继续使用已挂载iframe；需要重新创建且跳过启动时可传 `?embed=1&skipBoot=1`。右下角可重播。减少运动偏好和界面音量设置仍可使用，默认音效、音乐均关闭。

`pnpm run check:projects` 检查空状态、一一映射、无循环别名、排序稳定、元数据过滤和画质默认值。`#three-scene.dataset.renderStats` 包含 `projectCount`、`selectedProjectId`、`visibleProjectIds`，可核对渲染实例；`fps`、`targetFps` 和 `renderPaused` 可用于性能检查。

## 素材与许可

- 上游 MIT 许可、Three 和 Rolling Number 许可随构建保留。
- 本软件使用 MiSans 字体。字体分片、`NOTICE.txt`、`MiSans-license.pdf` 和字体来源信息完整保留。
- 可见标志替换为光宣原有的叠框与光线图形；启动仍使用原程序描线和轨迹。
- 上游原创的三条 Ogg 配乐保留。打字音改用已有 Web Audio 合成方法，移除了第三方 PV 采样。
- 原游戏档案下载和 PWA 图标不进入嵌入构建。

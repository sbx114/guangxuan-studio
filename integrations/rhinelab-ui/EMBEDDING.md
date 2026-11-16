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

用户打开功能档案时，原版档案抽取和镜头推进先运行约 900 毫秒，然后发送：

```js
{ type: "guangxuan:open", view: "video" | "writer" | "archive" | "settings" }
```

消息仅发送给同源父页面。此入口不读取 API 密钥，也不发起模型请求。科普工作室是只读规划说明，不发送进入消息。

初次打开保留原启动轨迹，时间压缩为资源就绪后约 5.3 秒，可随时跳过。返回首页使用 `?embed=1&skipBoot=1`；右下角可重播。减少运动偏好和界面音量设置仍可使用，默认音效、音乐均关闭。

## 素材与许可

- 上游 MIT 许可、Three 和 Rolling Number 许可随构建保留。
- 本软件使用 MiSans 字体。字体分片、`NOTICE.txt`、`MiSans-license.pdf` 和字体来源信息完整保留。
- 可见标志替换为光宣原有的叠框与光线图形；启动仍使用原程序描线和轨迹。
- 上游原创的三条 Ogg 配乐保留。打字音改用已有 Web Audio 合成方法，移除了第三方 PV 采样。
- 原游戏档案下载和 PWA 图标不进入嵌入构建。

/* Derived from OpenFilm library/index.json; source SHA256: 990cdd8d58eafe33283b198a23d4eb81363161c6f450c9b0a14f20e8e15a4581.
 * MIT License
 * 
 * Copyright (c) 2026 OpenFilm contributors
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * 
 */
export const CAPTION_LIBRARY = [
  {
    "id": "text/looks/title",
    "kind": "textstyle",
    "group": "basic",
    "name": "标题",
    "vars": {
      "--weight": "900",
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif"
    }
  },
  {
    "id": "text/looks/subtitle",
    "kind": "textstyle",
    "group": "basic",
    "name": "副标题",
    "vars": {
      "--weight": "700"
    }
  },
  {
    "id": "text/looks/body",
    "kind": "textstyle",
    "group": "basic",
    "name": "正文",
    "vars": {
      "--weight": "500",
      "--in": "fade"
    }
  },
  {
    "id": "text/looks/note",
    "kind": "textstyle",
    "group": "basic",
    "name": "注释",
    "vars": {
      "--size": "52vh",
      "--weight": "500",
      "--box": "rgba(0,0,0,0.55)",
      "--box-pad": "0.35em 0.7em",
      "--box-radius": "0.3em",
      "--in": "fade"
    }
  },
  {
    "id": "text/looks/lower",
    "kind": "textstyle",
    "group": "basic",
    "name": "下方字幕",
    "vars": {
      "--weight": "600",
      "--stroke": "0.08em",
      "--in": "fade"
    }
  },
  {
    "id": "text/looks/white-black",
    "kind": "textstyle",
    "group": "wordart",
    "name": "白字黑边",
    "vars": {
      "--stroke": "0.12em",
      "--stroke-color": "#111"
    }
  },
  {
    "id": "text/looks/yellow-variety",
    "kind": "textstyle",
    "group": "wordart",
    "name": "综艺黄字",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#ffd400",
      "--stroke": "0.14em",
      "--stroke-color": "#151515",
      "--shadow": "0.07em 0.09em 0 #151515"
    }
  },
  {
    "id": "text/looks/variety-pink",
    "kind": "textstyle",
    "group": "wordart",
    "name": "综艺粉字",
    "vars": {
      "--font": "'ZCOOL KuaiLe', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--weight": "400",
      "--color": "#ffffff",
      "--stroke": "0.16em",
      "--stroke-color": "#ff3d7f",
      "--shadow": "0 0.1em 0 #9e0040"
    }
  },
  {
    "id": "text/looks/candy",
    "kind": "textstyle",
    "group": "wordart",
    "name": "糖果字",
    "vars": {
      "--font": "'ZCOOL KuaiLe', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--weight": "400",
      "--color": "transparent",
      "--fill": "linear-gradient(180deg, #ffffff 35%, #ffe08a 80%)",
      "--glow": "drop-shadow(0.05em 0em 0 #ff8a00) drop-shadow(-0.05em 0em 0 #ff8a00) drop-shadow(0em 0.05em 0 #ff8a00) drop-shadow(0em -0.05em 0 #ff8a00) drop-shadow(0.04em 0em 0 #ff8a00) drop-shadow(-0.04em 0em 0 #ff8a00) drop-shadow(0em 0.04em 0 #ff8a00) drop-shadow(0em -0.04em 0 #ff8a00) drop-shadow(0 0.09em 0 #c24e00)"
    }
  },
  {
    "id": "text/looks/comic",
    "kind": "textstyle",
    "group": "wordart",
    "name": "漫画字",
    "vars": {
      "--font": "'ZCOOL KuaiLe', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--weight": "400",
      "--color": "#ffeb3b",
      "--stroke": "0.12em",
      "--stroke-color": "#111",
      "--shadow": "0.09em 0.09em 0 #e53935"
    }
  },
  {
    "id": "text/looks/cute-pink",
    "kind": "textstyle",
    "group": "wordart",
    "name": "可爱粉",
    "vars": {
      "--font": "'ZCOOL KuaiLe', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--weight": "400",
      "--color": "#ffffff",
      "--stroke": "0.13em",
      "--stroke-color": "#ff7eb6",
      "--shadow": "0 0.08em 0 #e05597"
    }
  },
  {
    "id": "text/looks/mint",
    "kind": "textstyle",
    "group": "wordart",
    "name": "薄荷",
    "vars": {
      "--font": "'ZCOOL KuaiLe', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--weight": "400",
      "--color": "#ffffff",
      "--stroke": "0.13em",
      "--stroke-color": "#2ec4a0",
      "--shadow": "0 0.08em 0 #13866b"
    }
  },
  {
    "id": "text/looks/neon-pink",
    "kind": "textstyle",
    "group": "wordart",
    "name": "霓虹粉",
    "vars": {
      "--weight": "700",
      "--color": "#fff0fb",
      "--glow": "drop-shadow(0 0 0.06em #ff2fd0) drop-shadow(0 0 0.25em #ff2fd0)"
    }
  },
  {
    "id": "text/looks/neon-cyan",
    "kind": "textstyle",
    "group": "wordart",
    "name": "霓虹青",
    "vars": {
      "--weight": "700",
      "--color": "#effffe",
      "--glow": "drop-shadow(0 0 0.06em #19e3ff) drop-shadow(0 0 0.25em #19e3ff)"
    }
  },
  {
    "id": "text/looks/neon-yellow",
    "kind": "textstyle",
    "group": "wordart",
    "name": "霓虹黄",
    "vars": {
      "--weight": "700",
      "--color": "#fffbe0",
      "--glow": "drop-shadow(0 0 0.06em #ffd21f) drop-shadow(0 0 0.25em #ff9d00)"
    }
  },
  {
    "id": "text/looks/gold",
    "kind": "textstyle",
    "group": "wordart",
    "name": "鎏金",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "transparent",
      "--fill": "linear-gradient(180deg, #fff7cc 0%, #f2c14e 45%, #9a6a12 52%, #f6d784 100%)",
      "--stroke": "0.03em",
      "--stroke-color": "#5a3a00",
      "--glow": "drop-shadow(0 0.04em 0.06em rgba(0,0,0,0.55))"
    }
  },
  {
    "id": "text/looks/silver",
    "kind": "textstyle",
    "group": "wordart",
    "name": "银色",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "transparent",
      "--fill": "linear-gradient(180deg, #ffffff 0%, #c9d1d9 45%, #6b7480 52%, #e8edf2 100%)",
      "--stroke": "0.03em",
      "--stroke-color": "#2d333b",
      "--glow": "drop-shadow(0 0.04em 0.06em rgba(0,0,0,0.55))"
    }
  },
  {
    "id": "text/looks/sunset",
    "kind": "textstyle",
    "group": "wordart",
    "name": "日落渐变",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "transparent",
      "--fill": "linear-gradient(90deg, #ffb35c, #ff4d8d 55%, #8a5cff)"
    }
  },
  {
    "id": "text/looks/ocean",
    "kind": "textstyle",
    "group": "wordart",
    "name": "海洋渐变",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "transparent",
      "--fill": "linear-gradient(90deg, #7cf6ff, #2f8cff 60%, #5b3cff)"
    }
  },
  {
    "id": "text/looks/aurora",
    "kind": "textstyle",
    "group": "wordart",
    "name": "极光",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "transparent",
      "--fill": "linear-gradient(90deg, #8affc1, #5ad1ff 50%, #c08bff)",
      "--glow": "drop-shadow(0 0 0.15em rgba(120,220,255,0.6))"
    }
  },
  {
    "id": "text/looks/fire",
    "kind": "textstyle",
    "group": "wordart",
    "name": "火焰",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "transparent",
      "--fill": "linear-gradient(0deg, #ff3d00, #ffb300 55%, #fff59d)",
      "--glow": "drop-shadow(0 0 0.18em #ff6d00)"
    }
  },
  {
    "id": "text/looks/ice",
    "kind": "textstyle",
    "group": "wordart",
    "name": "冰霜",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "transparent",
      "--fill": "linear-gradient(180deg, #ffffff, #a8ecff)",
      "--stroke": "0.02em",
      "--stroke-color": "#e6faff",
      "--glow": "drop-shadow(0 0 0.15em #7fdcff)"
    }
  },
  {
    "id": "text/looks/solid-red",
    "kind": "textstyle",
    "group": "wordart",
    "name": "立体红",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#ff4a3d",
      "--shadow": "0.012em 0.012em 0 #7a0f08, 0.024em 0.024em 0 #7a0f08, 0.036em 0.036em 0 #7a0f08, 0.048em 0.048em 0 #7a0f08, 0.060em 0.060em 0 #7a0f08, 0.072em 0.072em 0 #7a0f08, 0.084em 0.084em 0 #7a0f08, 0.096em 0.096em 0 #7a0f08"
    }
  },
  {
    "id": "text/looks/solid-blue",
    "kind": "textstyle",
    "group": "wordart",
    "name": "立体蓝",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#4aa8ff",
      "--shadow": "0.012em 0.012em 0 #0b2f66, 0.024em 0.024em 0 #0b2f66, 0.036em 0.036em 0 #0b2f66, 0.048em 0.048em 0 #0b2f66, 0.060em 0.060em 0 #0b2f66, 0.072em 0.072em 0 #0b2f66, 0.084em 0.084em 0 #0b2f66, 0.096em 0.096em 0 #0b2f66"
    }
  },
  {
    "id": "text/looks/long-shadow",
    "kind": "textstyle",
    "group": "wordart",
    "name": "长投影",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#ffffff",
      "--shadow": "0.012em 0.012em 0 rgba(0,0,0,0.35), 0.024em 0.024em 0 rgba(0,0,0,0.35), 0.036em 0.036em 0 rgba(0,0,0,0.35), 0.048em 0.048em 0 rgba(0,0,0,0.35), 0.060em 0.060em 0 rgba(0,0,0,0.35), 0.072em 0.072em 0 rgba(0,0,0,0.35), 0.084em 0.084em 0 rgba(0,0,0,0.35), 0.096em 0.096em 0 rgba(0,0,0,0.35), 0.108em 0.108em 0 rgba(0,0,0,0.35), 0.120em 0.120em 0 rgba(0,0,0,0.35), 0.132em 0.132em 0 rgba(0,0,0,0.35), 0.144em 0.144em 0 rgba(0,0,0,0.35), 0.156em 0.156em 0 rgba(0,0,0,0.35), 0.168em 0.168em 0 rgba(0,0,0,0.35), 0.180em 0.180em 0 rgba(0,0,0,0.35), 0.192em 0.192em 0 rgba(0,0,0,0.35)"
    }
  },
  {
    "id": "text/looks/outline",
    "kind": "textstyle",
    "group": "wordart",
    "name": "空心字",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "transparent",
      "--stroke": "0.035em",
      "--stroke-color": "#ffffff"
    }
  },
  {
    "id": "text/looks/double-edge",
    "kind": "textstyle",
    "group": "wordart",
    "name": "双描边",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#ffffff",
      "--glow": "drop-shadow(0.035em 0em 0 #2b5bff) drop-shadow(-0.035em 0em 0 #2b5bff) drop-shadow(0em 0.035em 0 #2b5bff) drop-shadow(0em -0.035em 0 #2b5bff) drop-shadow(0.03em 0em 0 #2b5bff) drop-shadow(-0.03em 0em 0 #2b5bff) drop-shadow(0em 0.03em 0 #2b5bff) drop-shadow(0em -0.03em 0 #2b5bff) drop-shadow(0.035em 0em 0 #ffffff) drop-shadow(-0.035em 0em 0 #ffffff) drop-shadow(0em 0.035em 0 #ffffff) drop-shadow(0em -0.035em 0 #ffffff)"
    }
  },
  {
    "id": "text/looks/retro",
    "kind": "textstyle",
    "group": "wordart",
    "name": "复古",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#f6e7c8",
      "--shadow": "0.06em 0.06em 0 #d2452f, 0.12em 0.12em 0 #24384d"
    }
  },
  {
    "id": "text/looks/vapor",
    "kind": "textstyle",
    "group": "wordart",
    "name": "蒸汽波",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#ffe9ff",
      "--italic": "italic",
      "--shadow": "0.05em 0.05em 0 #ff4fd8, 0.1em 0.1em 0 #3bd5ff"
    }
  },
  {
    "id": "text/looks/glitch",
    "kind": "textstyle",
    "group": "wordart",
    "name": "故障",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#ffffff",
      "--shadow": "-0.05em 0 0 #ff0050, 0.05em 0 0 #00e5ff"
    }
  },
  {
    "id": "text/looks/label-black",
    "kind": "textstyle",
    "group": "wordart",
    "name": "黑底白字",
    "vars": {
      "--weight": "700",
      "--box": "#111111",
      "--box-pad": "0.25em 0.55em",
      "--box-radius": "0.18em"
    }
  },
  {
    "id": "text/looks/label-yellow",
    "kind": "textstyle",
    "group": "wordart",
    "name": "黄底黑字",
    "vars": {
      "--weight": "800",
      "--color": "#111111",
      "--box": "#ffd400",
      "--box-pad": "0.25em 0.55em",
      "--box-radius": "0.18em"
    }
  },
  {
    "id": "text/looks/label-red",
    "kind": "textstyle",
    "group": "wordart",
    "name": "新闻红条",
    "vars": {
      "--weight": "800",
      "--box": "#d6202f",
      "--box-pad": "0.22em 0.6em",
      "--box-radius": "0"
    }
  },
  {
    "id": "text/looks/highlighter",
    "kind": "textstyle",
    "group": "wordart",
    "name": "荧光笔",
    "vars": {
      "--weight": "800",
      "--color": "#ffffff",
      "--box": "linear-gradient(transparent 55%, rgba(255,61,127,0.85) 55%, rgba(255,61,127,0.85) 90%, transparent 90%)",
      "--box-pad": "0 0.15em"
    }
  },
  {
    "id": "text/looks/bubble",
    "kind": "textstyle",
    "group": "wordart",
    "name": "气泡框",
    "vars": {
      "--font": "'ZCOOL KuaiLe', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--weight": "400",
      "--color": "#222222",
      "--box": "#ffffff",
      "--box-pad": "0.3em 0.8em",
      "--box-radius": "1.2em",
      "--glow": "drop-shadow(0 0.05em 0.1em rgba(0,0,0,0.4))"
    }
  },
  {
    "id": "text/looks/handwriting",
    "kind": "textstyle",
    "group": "wordart",
    "name": "手写",
    "vars": {
      "--font": "'ZCOOL KuaiLe', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--weight": "400",
      "--shadow": "0 0.04em 0.2em rgba(0,0,0,0.5)"
    }
  },
  {
    "id": "text/looks/cinema",
    "kind": "textstyle",
    "group": "wordart",
    "name": "电影字",
    "vars": {
      "--font": "'Songti SC', 'Noto Serif SC', 'Source Han Serif SC', Georgia, serif",
      "--weight": "600",
      "--color": "#f5e6c4",
      "--spacing": "0.25em",
      "--size": "6vw",
      "--shadow": "0 0.02em 0.12em rgba(0,0,0,0.85)"
    }
  },
  {
    "id": "text/looks/elegant",
    "kind": "textstyle",
    "group": "wordart",
    "name": "优雅衬线",
    "vars": {
      "--font": "'Songti SC', 'Noto Serif SC', 'Source Han Serif SC', Georgia, serif",
      "--weight": "500",
      "--italic": "italic",
      "--spacing": "0.06em"
    }
  },
  {
    "id": "text/looks/thin",
    "kind": "textstyle",
    "group": "wordart",
    "name": "极简细体",
    "vars": {
      "--weight": "200",
      "--spacing": "0.18em"
    }
  },
  {
    "id": "text/looks/soft-shadow",
    "kind": "textstyle",
    "group": "wordart",
    "name": "柔和投影",
    "vars": {
      "--weight": "800",
      "--shadow": "0 0.06em 0.3em rgba(0,0,0,0.65)"
    }
  },
  {
    "id": "text/looks/stamp",
    "kind": "textstyle",
    "group": "wordart",
    "name": "印章",
    "vars": {
      "--font": "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Hiragino Sans GB', sans-serif",
      "--color": "#e23b2e",
      "--box": "transparent",
      "--box-pad": "0.15em 0.4em",
      "--stroke": "0",
      "--shadow": "0.020em 0.000em 0 rgba(226,59,46,0.5), -0.020em 0.000em 0 rgba(226,59,46,0.5), 0.000em 0.020em 0 rgba(226,59,46,0.5), 0.000em -0.020em 0 rgba(226,59,46,0.5), 0.014em 0.014em 0 rgba(226,59,46,0.5), -0.014em 0.014em 0 rgba(226,59,46,0.5), 0.014em -0.014em 0 rgba(226,59,46,0.5), -0.014em -0.014em 0 rgba(226,59,46,0.5)"
    }
  },
  {
    "id": "text/motions/in-none",
    "kind": "textmotion",
    "group": "in",
    "name": "无",
    "vars": {
      "--in": "none",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-fade",
    "kind": "textmotion",
    "group": "in",
    "name": "渐显",
    "vars": {
      "--in": "fade",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-rise",
    "kind": "textmotion",
    "group": "in",
    "name": "上浮",
    "vars": {
      "--in": "rise",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-drop",
    "kind": "textmotion",
    "group": "in",
    "name": "下落",
    "vars": {
      "--in": "drop",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-pop",
    "kind": "textmotion",
    "group": "in",
    "name": "弹出",
    "vars": {
      "--in": "pop",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-zoom",
    "kind": "textmotion",
    "group": "in",
    "name": "缩放",
    "vars": {
      "--in": "zoom",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-blur",
    "kind": "textmotion",
    "group": "in",
    "name": "模糊渐显",
    "vars": {
      "--in": "blur",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-slide-left",
    "kind": "textmotion",
    "group": "in",
    "name": "左侧滑入",
    "vars": {
      "--in": "slide-left",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-slide-right",
    "kind": "textmotion",
    "group": "in",
    "name": "右侧滑入",
    "vars": {
      "--in": "slide-right",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-wipe",
    "kind": "textmotion",
    "group": "in",
    "name": "擦入",
    "vars": {
      "--in": "wipe",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-type",
    "kind": "textmotion",
    "group": "in",
    "name": "打字机",
    "vars": {
      "--in": "type",
      "--in-time": "1.2s"
    }
  },
  {
    "id": "text/motions/in-stamp",
    "kind": "textmotion",
    "group": "in",
    "name": "盖章",
    "vars": {
      "--in": "stamp",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-spin-in",
    "kind": "textmotion",
    "group": "in",
    "name": "旋入",
    "vars": {
      "--in": "spin-in",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-flip-in",
    "kind": "textmotion",
    "group": "in",
    "name": "翻转",
    "vars": {
      "--in": "flip-in",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/in-bounce-in",
    "kind": "textmotion",
    "group": "in",
    "name": "弹跳",
    "vars": {
      "--in": "bounce-in",
      "--in-time": "0.6s"
    }
  },
  {
    "id": "text/motions/loop-none",
    "kind": "textmotion",
    "group": "loop",
    "name": "无",
    "vars": {
      "--loop": "none"
    }
  },
  {
    "id": "text/motions/loop-float",
    "kind": "textmotion",
    "group": "loop",
    "name": "漂浮",
    "vars": {
      "--loop": "float"
    }
  },
  {
    "id": "text/motions/loop-pulse",
    "kind": "textmotion",
    "group": "loop",
    "name": "脉动",
    "vars": {
      "--loop": "pulse"
    }
  },
  {
    "id": "text/motions/loop-wiggle",
    "kind": "textmotion",
    "group": "loop",
    "name": "摇摆",
    "vars": {
      "--loop": "wiggle"
    }
  },
  {
    "id": "text/motions/loop-shake",
    "kind": "textmotion",
    "group": "loop",
    "name": "抖动",
    "vars": {
      "--loop": "shake"
    }
  },
  {
    "id": "text/motions/loop-breathe",
    "kind": "textmotion",
    "group": "loop",
    "name": "呼吸",
    "vars": {
      "--loop": "breathe"
    }
  },
  {
    "id": "text/motions/loop-swing",
    "kind": "textmotion",
    "group": "loop",
    "name": "钟摆",
    "vars": {
      "--loop": "swing"
    }
  },
  {
    "id": "text/motions/loop-flicker",
    "kind": "textmotion",
    "group": "loop",
    "name": "闪烁",
    "vars": {
      "--loop": "flicker"
    }
  },
  {
    "id": "text/motions/out-none",
    "kind": "textmotion",
    "group": "out",
    "name": "无",
    "vars": {
      "--out": "none",
      "--out-time": "0.5s"
    }
  },
  {
    "id": "text/motions/out-fade-out",
    "kind": "textmotion",
    "group": "out",
    "name": "渐隐",
    "vars": {
      "--out": "fade-out",
      "--out-time": "0.5s"
    }
  },
  {
    "id": "text/motions/out-sink",
    "kind": "textmotion",
    "group": "out",
    "name": "下沉",
    "vars": {
      "--out": "sink",
      "--out-time": "0.5s"
    }
  },
  {
    "id": "text/motions/out-lift",
    "kind": "textmotion",
    "group": "out",
    "name": "上飘",
    "vars": {
      "--out": "lift",
      "--out-time": "0.5s"
    }
  },
  {
    "id": "text/motions/out-shrink",
    "kind": "textmotion",
    "group": "out",
    "name": "缩小",
    "vars": {
      "--out": "shrink",
      "--out-time": "0.5s"
    }
  },
  {
    "id": "text/motions/out-blur-out",
    "kind": "textmotion",
    "group": "out",
    "name": "模糊消失",
    "vars": {
      "--out": "blur-out",
      "--out-time": "0.5s"
    }
  },
  {
    "id": "text/motions/out-wipe-out",
    "kind": "textmotion",
    "group": "out",
    "name": "擦除",
    "vars": {
      "--out": "wipe-out",
      "--out-time": "0.5s"
    }
  },
  {
    "id": "text/motions/out-zoom-out",
    "kind": "textmotion",
    "group": "out",
    "name": "放大消失",
    "vars": {
      "--out": "zoom-out",
      "--out-time": "0.5s"
    }
  }
];

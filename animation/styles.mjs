export const ANIMATION_FONTS = Object.freeze({
  original: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  sans: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif',
  serif: '"Noto Serif SC", "Source Han Serif SC", "SimSun", "Songti SC", Georgia, serif',
  mono: '"Cascadia Code", Consolas, "Courier New", "Microsoft YaHei", monospace',
});

export const ANIMATION_THEMES = {
  paper: { background: '#e8e5e1', ink: '#080a08', muted: '#656856', line: '#bfc0b5', soft: '#dcdcd1', accent: '#565c46', brass: '#9b8356', opposite: '#efede6', glass: 'rgba(255,255,248,0.35)', glassEdge: '#f7f5ef', shade: '#747363' },
  dark: { background: '#080a08', ink: '#e8e5e1', muted: '#bec2ac', line: '#454b3b', soft: '#22291c', accent: '#b2bb95', brass: '#bc9b62', opposite: '#10140d', glass: 'rgba(201,211,177,0.05)', glassEdge: '#747d65', shade: '#000000' },
};

const PRESETS = {
  ocean: { paper: { ink: '#122e3c', muted: '#496975', line: '#afc3ca', soft: '#d8e2e5', accent: '#275c77', brass: '#4a7b94' }, dark: { ink: '#e5f1f5', muted: '#afc8d2', line: '#3e5a69', soft: '#172c37', accent: '#94c8df', brass: '#77b4d2' } },
  amber: { paper: { ink: '#35291d', muted: '#806750', line: '#cabb9e', soft: '#e4dbc9', accent: '#8a5e2e', brass: '#a97d42' }, dark: { ink: '#f1e7d5', muted: '#c5b194', line: '#63533a', soft: '#30271b', accent: '#dbb472', brass: '#c49856' } },
  plum: { paper: { ink: '#302638', muted: '#75627d', line: '#c7b9cd', soft: '#e2dbe5', accent: '#72567e', brass: '#9872a3' }, dark: { ink: '#eee4f1', muted: '#c2abc9', line: '#59445f', soft: '#2d2332', accent: '#ceb0d8', brass: '#b791c3' } },
};

function mix(a, b, amount) {
  const parts = [1, 3, 5].map(offset => Math.round(parseInt(a.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(b.slice(offset, offset + 2), 16) * amount));
  return `#${parts.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

export function animationPalette(theme = 'paper', brand) {
  const base = ANIMATION_THEMES[theme] || ANIMATION_THEMES.paper;
  if (!brand || !Object.keys(brand).some(key => key !== 'font' && !(key === 'palette' && brand.palette === 'original'))) return base;
  const palette = { ...base, ...(PRESETS[brand.palette]?.[theme] || {}) };
  if (brand.background) palette.background = brand.background;
  if (brand.ink) palette.ink = brand.ink;
  if (brand.background || brand.ink) {
    palette.muted = mix(palette.ink, palette.background, .4);
    palette.line = mix(palette.ink, palette.background, .73);
    palette.soft = mix(palette.ink, palette.background, .91);
    palette.opposite = mix(palette.background, palette.ink, .06);
  }
  if (brand.accent) { palette.accent = brand.accent; palette.brass = brand.accent; }
  return palette;
}

export const ANIMATION_PACE = Object.freeze({ calm: .78, normal: 1, brisk: 1.3 });

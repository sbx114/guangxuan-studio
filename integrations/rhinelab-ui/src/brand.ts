// One shared mark for the interface and the printed archive label.
const paths = `<path d="M48 48H168V133H48ZM136 13H256V98H136Z" fill="none" stroke="currentColor" stroke-width="10"/><path d="M36 137L277 8" fill="none" stroke="currentColor" stroke-width="8"/>`;
export const labelMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 310 145" color="#171713">${paths}</svg>`;
export const logo = `<svg viewBox="0 0 310 185" aria-label="光宣工作台" role="img">${paths}<text x="165" y="174" text-anchor="middle" font-family="MiSans,sans-serif" font-size="16" font-weight="700" letter-spacing="18">GUANGXUAN</text></svg>`;
// The same Bezier contour, continuous for the opening's moving draw/erase ends.
// Its small printed gap is animated with stroke dashes, not baked into the path.
export const bootMarkContour =
  "M48 48H168V133H48ZM136 13H256V98H136ZM36 137L277 8";

export const brandHeading = `<h1>GUANGXUAN</h1><div>光宣工作台</div>`;

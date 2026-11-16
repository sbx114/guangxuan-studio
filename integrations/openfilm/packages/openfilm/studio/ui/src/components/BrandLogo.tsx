/* Guangxuan's stacked frames and a play mark; the upstream editor retains its own licenses. */
const VIEWBOX = '0 0 40 40';

export function BrandLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VIEWBOX} fill="none" className="block shrink-0" role="img" aria-label="光宣工作台">
      <path d="M5 11h23v24H5zM12 5h23v24" stroke="currentColor" strokeWidth="2.7" strokeLinejoin="round" />
      <path d="m14 17 10 6-10 6z" fill="currentColor" />
    </svg>
  );
}

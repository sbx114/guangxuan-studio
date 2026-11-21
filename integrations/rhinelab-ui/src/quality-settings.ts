export type PerformanceMode = "original" | "smooth";

const performanceModes = [
  { value: "original", label: "原画", description: "完整三维效果" },
  { value: "smooth", label: "流畅", description: "降低渲染开销" },
] as const;

export function qualityMarkup(mode: PerformanceMode = "original") {
  const selectedMode = mode === "smooth" ? "smooth" : "original";
  return `<section class="quality-settings" aria-label="性能">
    <div class="quality-heading"><h3 id="performance-mode-label">性能</h3></div>
    <div class="quality-mode-options" role="group" aria-labelledby="performance-mode-label">
      ${performanceModes.map(({ value, label, description }) => `<button type="button" class="quality-mode" data-performance-mode="${value}" aria-pressed="${selectedMode === value}"><strong>${label}</strong><span>${description}</span></button>`).join("")}
    </div>
  </section>`;
}

export function syncQualityUI(mode: PerformanceMode = "original") {
  const selectedMode = mode === "smooth" ? "smooth" : "original";
  document.querySelectorAll<HTMLButtonElement>(".quality-settings [data-performance-mode]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.performanceMode === selectedMode));
  });
}

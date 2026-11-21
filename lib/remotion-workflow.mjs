import { AppError } from './errors.mjs';

const protectedError = error => error?.name === 'AbortError' || error?.status === 409 || error?.status === 499 || /(?:CANCELLED|REVISION_CONFLICT|OWNER_CHANGED)/.test(error?.code || '');
const check = signal => { if (signal?.aborted) throw new DOMException('动画创作已取消。', 'AbortError'); };
const diagnostic = value => String(value || '').replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, '[工程文件]').replace(/\\\\[^\s"'<>]+/g, '[工程文件]').slice(0, 6000);

/** Compile repair and visual improvement have independent, bounded budgets. */
export async function runReviewedRemotion({ generate, inspect, review, signal, onProgress = () => {}, compileRepairs = 2, visualRepairs = 1 } = {}) {
  if (typeof generate !== 'function' || typeof inspect !== 'function') throw new TypeError('Remotion creation requires generation and inspection.');
  if (![compileRepairs, visualRepairs].every(value => Number.isInteger(value) && value >= 0 && value <= 3)) throw new TypeError('Invalid Remotion repair budget.');
  let project, result, inspection, reviewResult, feedback = '', phase = 'create';
  const workflow = { generations: 0, compileRepairs: 0, visualRepairs: 0, reviews: 0 };
  while (true) {
    check(signal);
    result = await generate({ project, diagnostics: feedback, phase });
    check(signal);
    project = result?.project;
    if (!project?.id || !Number.isSafeInteger(project.revision)) throw new AppError(502, '动画生成未返回有效工程。', 'REMOTION_MODEL_FORMAT');
    workflow.generations++;
    try {
      inspection = await inspect(project);
      check(signal);
      const compositions = Array.isArray(inspection) ? inspection : inspection?.compositions;
      if (!project.compositionId && compositions?.length === 1) project = { ...project, compositionId: compositions[0].id };
      if (!compositions?.some(item => item.id === project.compositionId)) throw new Error('请选择实际注册的Composition：' + (compositions || []).map(item => item.id).join('、'));
    } catch (error) {
      if (protectedError(error) || signal?.aborted) throw error;
      if (workflow.compileRepairs >= compileRepairs) throw new AppError(422, `动画工程${project.id}已保存，编译仍未通过：${diagnostic(error.message || error)}`, 'REMOTION_COMPILE_FAILED');
      workflow.compileRepairs++;
      phase = 'compile'; feedback = '实际编译反馈，仅修复对应错误并保留设计：\n' + diagnostic(error.message || error);
      onProgress('正在修复编译问题');
      continue;
    }
    reviewResult = undefined;
    if (typeof review === 'function') {
      check(signal); onProgress('正在检查实际画面'); workflow.reviews++;
      try { reviewResult = await review(project); }
      catch (error) {
        if (protectedError(error) || signal?.aborted) throw error;
        reviewResult = { status: 'unavailable', verdict: 'unknown', summary: '画面检查暂不可用，源码已保留，可稍后重试。', issues: [], code: typeof error?.code === 'string' ? error.code.slice(0, 100) : 'REMOTION_REVIEW_UNAVAILABLE' };
      }
      check(signal);
      if (!reviewResult || !['reviewed', 'unavailable'].includes(reviewResult.status) || !['pass', 'revise', 'unknown'].includes(reviewResult.verdict) || reviewResult.status === 'reviewed' && !Array.isArray(reviewResult.issues)) reviewResult = { status: 'unavailable', verdict: 'unknown', summary: '画面检查未返回有效结果，源码已保留。', issues: [] };
      const fixes = reviewResult.status === 'reviewed' && reviewResult.verdict === 'revise' && (reviewResult.issues || []).some(issue => typeof issue.fix === 'string' && issue.fix.trim());
      if (fixes && workflow.visualRepairs < visualRepairs) {
        workflow.visualRepairs++;
        phase = 'visual'; feedback = '实际采样画面反馈，按证据改进并保留事实、素材和未涉及的内容：\n' + JSON.stringify({ summary: reviewResult.summary, issues: reviewResult.issues }).slice(0, 8000);
        onProgress('正在按画面反馈优化');
        continue;
      }
    }
    return { ...result, project, inspection, ...(reviewResult ? { review: reviewResult } : {}), workflow };
  }
}

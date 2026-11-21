import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../lib/errors.mjs';
import { runReviewedRemotion } from '../lib/remotion-workflow.mjs';

const compositions = { compositions: [{ id: 'Main', width: 640, height: 360, fps: 30, durationInFrames: 120 }] };
const issue = { status: 'reviewed', verdict: 'revise', summary: '主体与标题重叠。', issues: [{ severity: 'polish', frame: 30, detail: '标题压住主体。', fix: '将标题移至上方，保留主体运动空间。' }] };
const passed = { status: 'reviewed', verdict: 'pass', summary: '采样画面清楚。', issues: [] };
function fixture() {
  const calls = [];
  return { calls, generate: async request => { calls.push(request); return { project: { id: 'source-one', revision: calls.length, compositionId: '', inputProps: {} }, notes: [] }; } };
}

test('two compile repairs leave a separate visual repair and a final real review', async () => {
  const fx = fixture(); let inspections = 0, reviews = 0;
  const result = await runReviewedRemotion({ generate: fx.generate, inspect: async () => { if (++inspections <= 2) throw new Error('Undefined component'); return compositions; }, review: async () => ++reviews === 1 ? issue : passed });
  assert.equal(result.project.revision, 4); assert.equal(result.project.compositionId, 'Main'); assert.equal(result.review.verdict, 'pass');
  assert.deepEqual(result.workflow, { generations: 4, compileRepairs: 2, visualRepairs: 1, reviews: 2 });
  assert.deepEqual(fx.calls.map(call => call.phase), ['create', 'compile', 'compile', 'visual']);
  assert.match(fx.calls[3].diagnostics, /标题压住主体/); assert.equal(fx.calls[3].project.revision, 3);
});

test('vision service failure is unavailable and never triggers a compile repair', async () => {
  const fx = fixture();
  const result = await runReviewedRemotion({ generate: fx.generate, inspect: async () => compositions, review: async () => { throw new Error('upstream temporary failure'); } });
  assert.equal(fx.calls.length, 1); assert.equal(result.review.status, 'unavailable'); assert.equal(result.review.verdict, 'unknown'); assert.equal(result.workflow.compileRepairs, 0);
});

test('a remaining visible problem stays revise after its visual budget is used', async () => {
  const fx = fixture(), blocking = { ...issue, issues: [{ ...issue.issues[0], severity: 'blocking' }] };
  const result = await runReviewedRemotion({ generate: fx.generate, inspect: async () => compositions, review: async () => blocking });
  assert.equal(result.project.revision, 2); assert.equal(result.review.verdict, 'revise'); assert.equal(result.review.issues[0].severity, 'blocking'); assert.equal(result.workflow.visualRepairs, 1);
});

test('compile exhaustion preserves the last source identity without calling vision', async () => {
  const fx = fixture(); let reviews = 0;
  await assert.rejects(runReviewedRemotion({ generate: fx.generate, inspect: async () => { throw new Error('C:/private/project/component.tsx failed'); }, review: async () => { reviews++; return passed; } }), error => error.code === 'REMOTION_COMPILE_FAILED' && error.message.includes('source-one') && !error.message.includes('C:/private'));
  assert.equal(fx.calls.length, 3); assert.equal(reviews, 0);
});

test('owner/version conflicts and cancellation never cause another generation', async () => {
  for (const stage of ['inspect', 'review']) {
    const fx = fixture(), conflict = new AppError(409, 'changed', 'REMOTION_REVISION_CONFLICT');
    await assert.rejects(runReviewedRemotion({ generate: fx.generate, inspect: async () => { if (stage === 'inspect') throw conflict; return compositions; }, review: async () => { throw conflict; } }), { code: 'REMOTION_REVISION_CONFLICT' });
    assert.equal(fx.calls.length, 1);
  }
  const fx = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(runReviewedRemotion({ generate: fx.generate, inspect: async () => compositions, signal: controller.signal }), { name: 'AbortError' }); assert.equal(fx.calls.length, 0);
});

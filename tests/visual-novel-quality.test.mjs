import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { buildVisualNovelPrompt, normalizeVisualNovel } from '../lib/visual-novel.mjs';
import { normalizeNovelScript, hydratePlayableNovel } from '../public/visual-novel-model.js';
import { runAi } from '../lib/ai.mjs';
import { singleGuideInput, singleGuideFixture } from './fixtures/single-guide.mjs';

const prepared = () => { const input = singleGuideInput(); return { input, payload: buildVisualNovelPrompt(input).payload, data: singleGuideFixture() }; };
const modelError = error => error.code === 'MODEL_FORMAT_ERROR';

test('visual novel teaching requirements connect concepts, evidence, application and specific correction without fixed question counts', () => {
  const { system } = buildVisualNovelPrompt(singleGuideInput());
  for (const requirement of ['概念的依赖关系', '前提和关键推导', '假设情境', '隐藏前提', '真实误区', '正确答案位置应自然变化', '纠正具体错因', '材料不足以排除歧义', '不能照搬固定题数', '不要求各知识点套同一段落模板']) assert.ok(system.includes(requirement), requirement);
});

test('visual novel generation rejects identical displayed options even with opposite flags or presentation-only whitespace differences', () => {
  for (const suffix of ['', ' \n ']) {
    const { data, payload } = prepared();
    data.scenes[0].lines[1].question.choices[1].text = data.scenes[0].lines[1].question.choices[0].text + suffix;
    assert.throws(() => normalizeVisualNovel(data, payload), error => modelError(error) && /重复的选项/.test(error.message));
  }
});

test('visual novel duplicate detection preserves mathematical operators, scientific case, signs and decimals', () => {
  for (const pair of [['x=y', 'x≠y'], ['x<y', 'x≤y'], ['1.0', '10'], ['+1', '-1'], ['m', 'M'], ['A/B', 'AB']]) {
    const { data, payload } = prepared();
    data.scenes[0].lines[1].question.choices.forEach((choice, index) => { choice.text = pair[index]; });
    assert.doesNotThrow(() => normalizeVisualNovel(data, payload), pair.join(' versus '));
  }
});

test('visual novel generation catches exact copied quizzes under new IDs but allows the same stem with distinct options', () => {
  const { data, payload } = prepared();
  const duplicate = structuredClone(data.scenes[0].lines[1].question);
  duplicate.id = 'question-copy'; duplicate.choices.forEach((choice, index) => { choice.id = 'copy-' + index; });
  data.scenes[0].lines[2].question = duplicate;
  assert.throws(() => normalizeVisualNovel(data, payload), error => modelError(error) && /完全重复/.test(error.message));
  data.scenes[0].lines[2].question.choices[1].text = '只记录结果，忽略其他条件';
  assert.doesNotThrow(() => normalizeVisualNovel(data, payload));
});

test('visual novel generation quality checks leave saved-work hydration compatible', () => {
  const { data, payload, input } = prepared();
  data.scenes[0].lines[1].question.choices[1].text = data.scenes[0].lines[1].question.choices[0].text;
  const previous = normalizeNovelScript(data, payload);
  assert.doesNotThrow(() => hydratePlayableNovel(previous, input));
  assert.throws(() => normalizeVisualNovel(data, payload), modelError);
});

test('actual local model responses reject duplicate quiz content clearly and accept a corrected next request without hidden provider retries', async t => {
  const requests = [], outputs = [], input = singleGuideInput();
  const duplicateOptions = singleGuideFixture();
  duplicateOptions.scenes[0].lines[1].question.choices[1].text = duplicateOptions.scenes[0].lines[1].question.choices[0].text;
  const duplicateQuestion = singleGuideFixture();
  duplicateQuestion.scenes[0].lines[2].question = structuredClone(duplicateQuestion.scenes[0].lines[1].question);
  duplicateQuestion.scenes[0].lines[2].question.id = 'copied-question';
  outputs.push(duplicateOptions, duplicateQuestion, singleGuideFixture());
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(outputs.shift()) } }] }));
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const settings = { baseUrl: 'http://127.0.0.1:' + server.address().port, apiKey: 'synthetic-local-quality-provider', model: 'controlled-fixture', apiStyle: 'chat', jsonMode: true };
  await assert.rejects(runAi('visual-novel', input, settings), error => modelError(error) && /重复的选项/.test(error.message));
  assert.equal(requests.length, 1, 'A rejected response must not trigger unannounced model calls.');
  await assert.rejects(runAi('visual-novel', input, settings), error => modelError(error) && /完全重复/.test(error.message));
  assert.equal(requests.length, 2);
  const result = await runAi('visual-novel', input, settings);
  assert.equal(result.data.scenes[0].lines.length, 4); assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.path, '/v1/chat/completions');
    assert.match(request.body.messages[0].content, /真实误区/);
    assert.match(request.body.messages[0].content, /前提和关键推导/);
  }
});

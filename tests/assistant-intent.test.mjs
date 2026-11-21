import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';

const cases = [
  ['搜索图片并处理好后导入当前科普项目，也导入已经下载的这份图片', true],
  ['先分析素材，然后把第二条轨道的音量压低', true],
  ['搜索如何下载并导入素材的方法', false],
  ['搜索文案修改资料，并解释如何改写正文', false],
  ['在5秒处分割当前片段', true],
  ['复制选中的片段到结尾', true],
  ['把选中片段变速到1.5倍', true],
  ['将第二段静音', true],
  ['把画面旋转90度', true],
  ['选中片段放大到120%', true],
  ['给片段设置0.5秒淡出', true],
  ['请镜像当前画面', true],
  ['Split the selected clip at five seconds', true],
  ['Mute the selected audio clip', true],
  ['不要将第二段静音，只给我建议', false],
  ['先别分割片段', false],
  ['请勿旋转当前画面', false],
  ['怎么复制并移动片段', false],
  ['请解释如何分割并变速', false],
  ['只分析画面是否需要缩放', false],
  ['请解释“将第二段静音”的意思', false],
  ['请改写当前文案', true],
  ['帮我优化当前文案，让表达更清楚', true],
  ['把当前稿精简到200字', true],
  ['把开头写得更自然一点', true],
  ['把第二段改得更清楚', true],
  ['请把这篇文案改一下', true],
  ['请压缩当前正文到一半长度', true],
  ['请扩写当前稿的结尾', true],
  ['请校对当前文案', true],
  ['请润色当前文案', true],
  ['不要用太正式的语气，帮我改写当前文案', true],
  ['请改写“这是一段待修改的文字”', true],
  ['请介绍标题的修改方法，并直接修改标题', true],
  ['请介绍标题的优化方法，并直接优化标题', true],
  ['先解释精简的方法，再直接精简当前稿', true],
  ['先介绍功能，然后下载这篇论文', true],
  ['介绍功能。然后下载这篇论文', true],
  ['先下载这篇论文并导入当前科普项目', true],
  ['搜索论文并下载原PDF', true],
  ['只修改标题，正文别动', true],
  ['我只是想修改标题', true],
  ['请只校对当前文案的错别字', true],
  ['如何优化文案？', false],
  ['请问怎么修改文案', false],
  ['请帮我解释如何精简当前文案', false],
  ['我想知道怎样优化文案', false],
  ['优化文案的方法是什么？', false],
  ['优化算法的原理是什么', false],
  ['这个软件支持精简文案吗', false],
  ['请讲解如何下载并导入这篇论文', false],
  ['介绍新建并导入素材的流程', false],
  ['请解释如何修改并保存文案', false],
  ['先讲解如何下载并导入论文', false],
  ['如何修改当前文案并保存', false],
  ['请介绍修改方法并直接修改标题', false],
  ['只给我建议：优化文案怎么做', false],
  ['我只是想了解怎么优化当前文案', false],
  ['只分析当前稿需要修改的地方', false],
  ['请先只提供一些建议，看看哪些地方需要修改', false],
  ['我仅仅想先了解怎样修改当前文案', false],
  ['只想要建议：修改标题是否合适', false],
  ['只给我建议，然后直接优化当前文案', false],
  ['不要优化当前文案，只解释一下', false],
  ['请不要修改项目，只解释一下', false],
  ['请先别修改当前文案，给我建议', false],
  ['暂时不要修改当前文案，只分析问题', false],
  ['我现在不想进行修改，只想看建议', false],
  ['请不要把当前文案改写成另一种口吻', false],
  ['暂不对当前稿进行修改，只要建议', false],
  ['请勿优化当前文案', false],
  ['现在不需要修改当前项目', false],
  ['不要改A，但是修改B', true],
  ['请不要修改标题，然后直接优化正文', true],
  ['Please do not optimize the current draft', false],
  ["Please don't edit the current project", false],
  ['请解释“修改项目”这句话的意思', false],
  ['请解释‘修改项目’这句话的意思', false],
  ["请解释 '修改项目' 这句话的意思", false],
  ['请阅读下面的文字并解释："删除当前项目"', false],
  ['请解释下面代码的作用：\n```text\n修改项目\n```', false],
  ['请解释下面代码的作用：\n~~~text\n修改项目\n~~~', false],
  ['请解释下面引文的意思：\n> 删除当前项目', false],
  ['请解释 `删除当前项目` 这段代码', false],
];

async function probe(t, instruction, { mode = 'auto' } = {}) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir());
  const dataDir = await mkdtemp(path.join(parent, 'gx-assistant-intent-'));
  let writes = 0, calls = 0, exposed = false;
  const service = createAssistantAgentService({
    dataDir,
    appTools: [{ name: 'writing_revise', description: '修改文案', mutating: true, inputSchema: { type: 'object', additionalProperties: false }, execute: async (_args, ctx) => {
      assert.equal(ctx.instruction, instruction, 'authorization normalization must not alter the actual user instruction');
      writes++; return { summary: 'fixture write', effects: [{ type: 'project', changed: true }] };
    } }],
    modelStep: async (_system, user) => {
      if (calls++ === 0) {
        exposed = JSON.parse(user).tools.some(tool => tool.name === 'writing_revise');
        // Attempt a write even when it was withheld: the server must enforce it.
        return { data: { type: 'tool', tool: 'writing_revise', arguments: {}, summary: 'fixture attempted write' } };
      }
      return { data: { type: 'final', message: 'fixture complete', sourceIds: [] } };
    },
  });
  t.after(async () => {
    await service.close();
    if (path.dirname(path.resolve(dataDir)) !== parent || !path.basename(dataDir).startsWith('gx-assistant-intent-')) throw new Error('Unsafe intent test cleanup');
    await rm(dataDir, { recursive: true, force: true });
  });
  const { runId } = await service.start({ projectId: 'intent-fixture', instruction, mode, settings: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-only-no-network' } });
  let job;
  for (let poll = 0; poll < 400; poll++) {
    job = await service.get(runId);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(job.status, 'completed', JSON.stringify(job));
  return { writes, exposed, toolStatus: job.steps.find(step => step.tool === 'writing_revise')?.status };
}

for (const [instruction, expected] of cases) test(`assistant mutation intent: ${instruction.replace(/\n/g, ' ')}`, async t => {
  const result = await probe(t, instruction);
  assert.equal(result.exposed, expected, 'mutating tool exposure');
  assert.equal(result.writes, expected ? 1 : 0, 'actual mutating adapter execution');
  assert.equal(result.toolStatus, expected ? 'completed' : 'failed');
});

test('ask mode stays read-only for a direct optimization request', async t => {
  const result = await probe(t, '帮我优化当前文案', { mode: 'ask' });
  assert.deepEqual(result, { writes: 0, exposed: false, toolStatus: 'failed' });
});

import { AppError } from './errors.mjs';
import { createWritingReferenceService, normalizeWritingReferenceConfig } from './writing-references.mjs';

const schema = (properties = {}) => ({ type: 'object', additionalProperties: false, properties });
export function createAssistantWritingReferenceTools({ tool, owner, current, commit, store, writingReferences = createWritingReferenceService({ store }) } = {}) {
  return [
    tool('writing_reference_options', '读取当前文案的可选参考设置和已有项目材料/作品候选。参考默认关闭；按用户要求选择，不自动开启。', schema(), false, async (_args, ctx) => {
      await owner(ctx, 'writing'); return { summary: '已读取文案参考选项。', data: await writingReferences.options(ctx.projectId) };
    }),
    tool('writing_reference_set', '按用户要求保存当前文案的可选参考，可粘贴text或从候选选择projectId及projectPart=work作品/material材料，两者可并用。enabled开关；purpose=style只学写法不加事实，content可引用内容且必须标注实际参考来源，auto按写作目标决定。未提及不自行开启。起草/精修自动使用已启用参考，修改可撤销。清空projectId可取消项目参考。', schema({ enabled: { type: 'boolean' }, purpose: { type: 'string', enum: ['auto', 'content', 'style'] }, text: { type: 'string', maxLength: 12000 }, projectId: { type: 'string', maxLength: 128 }, projectPart: { type: 'string', enum: ['work', 'material'] } }), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'writing');
      const keys = ['enabled', 'purpose', 'text', 'projectId', 'projectPart'];
      if (!keys.some(key => Object.hasOwn(args, key))) throw new AppError(400, '请填写要修改的参考设置。', 'WRITING_REFERENCE_INVALID');
      const config = { ...normalizeWritingReferenceConfig(project.writing?.references), ...Object.fromEntries(keys.filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])) };
      if (Object.hasOwn(args, 'projectId') || Object.hasOwn(args, 'projectPart')) config.projectCreatedAt = '';
      const validated = await writingReferences.configure(project.id, config);
      if (JSON.stringify(validated) === JSON.stringify(normalizeWritingReferenceConfig(project.writing?.references))) return { summary: '参考设置未变。', data: validated, effects: [] };
      return commit(ctx, state, [{ path: ['writing', 'references'], value: validated }], validated.enabled ? '已更新文案参考' : '已关闭文案参考');
    }, { repeatable: true }),
  ];
}

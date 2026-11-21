import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEditTime, readEditScope, editScopeSnapshot, contextForEditScope, editPlacementText, selectTimelineRange } from '../public/editor-scope.js';
import { normalizeEditScope } from '../lib/edit-scope.mjs';
import { MAX_TIME_SECONDS } from '../public/time-range.js';

const context={duration:8,assets:[{id:'a'},{id:'b'}],timeline:[{id:'one',assetId:'a'},{id:'two',assetId:'b'}]};
test('a chosen insertion may leave a gap after the current end and shares the backend limit',()=>{
 const project={id:'scope-gap',video:{editScope:{assetIds:['a'],placement:{mode:'insert',at:10}}}};
 const snapshot=editScopeSnapshot(project,context);
 assert.equal(snapshot.placement.at,10);
 assert.deepEqual(normalizeEditScope(snapshot,context.assets),snapshot);
 project.video.editScope.placement.at=86401;
 assert.equal(editScopeSnapshot(project,context).placement.at,86401);
 project.video.editScope.placement.at=MAX_TIME_SECONDS+1;
 assert.throws(()=>editScopeSnapshot(project,context),/精确/);
 assert.equal(parseEditTime('01:02.5'),62.5);
 assert.throws(()=>parseEditTime('01:60'),/小于 60/);
});

test('long existing timeline tail ranges and insertion coordinates agree with backend bounds',()=>{
 const project={id:'scope-long-tail',video:{editScope:{placement:{mode:'insert',at:3900}}}}, current={...context,duration:4000};
 assert.deepEqual(normalizeEditScope(editScopeSnapshot(project,current)).placement,{mode:'insert',at:3900});
 selectTimelineRange(project,{range:{start:3900,end:4000},clipIds:['tail']});
 const range=editScopeSnapshot(project,current); assert.deepEqual(normalizeEditScope(range).placement,{mode:'range',start:3900,end:4000,clipIds:['tail']});
 assert.throws(()=>editScopeSnapshot(project,{...current,duration:3950}),/超出当前时间线/);
 assert.deepEqual(selectTimelineRange(project,{range:{start:0,end:3601}}).placement,{mode:'range',start:0,end:3601});
 assert.deepEqual(normalizeEditScope({placement:{mode:'insert',at:86401}}).placement,{mode:'insert',at:86401});
 assert.throws(()=>normalizeEditScope({placement:{mode:'insert',at:MAX_TIME_SECONDS+1}}),error=>error.code==='INVALID_EDIT_PLACEMENT');
});

test('selected scope hides other assets from AI while an explicit empty selection stays empty',()=>{
 const project={id:'scope-selected',video:{editScope:{assetIds:['a'],placement:{mode:'append'}}}};
 const snapshot=editScopeSnapshot(project,context);
 assert.deepEqual(contextForEditScope(context,snapshot).assets,[{id:'a'}]);
 assert.deepEqual(contextForEditScope(context,snapshot).timeline,[{id:'one',assetId:'a'}]);
 project.video.editScope.assetIds=[];
 const empty=editScopeSnapshot(project,context);
 assert.deepEqual(empty.assetIds,[]);assert.deepEqual(contextForEditScope(context,empty).assets,[]);
 assert.equal(context.assets.length,2);
});

test('free placement keeps material selection and discards obsolete time or range data',()=>{
 const project={id:'scope-free',video:{editScope:{assetIds:['a','a','removed'],placement:{mode:'free',at:-1,start:9,end:1,clipIds:['old-range-clip']}}}};
 assert.deepEqual(readEditScope(project),{assetIds:['a','removed'],placement:{mode:'free'}});
 const snapshot=editScopeSnapshot(project,context);
 assert.deepEqual(snapshot,{assetIds:['a'],placement:{mode:'free'}});
 assert.equal(editPlacementText(snapshot),'自由创作');
 assert.deepEqual(contextForEditScope(context,snapshot).assets,[{id:'a'}]);
 assert.deepEqual(contextForEditScope(context,snapshot).timeline,[{id:'one',assetId:'a'}]);
 assert.deepEqual(project.video.editScope.placement,{mode:'free',at:-1,start:9,end:1,clipIds:['old-range-clip']},'Snapshot does not overwrite the project while normalizing request data');
 project.video.editScope.assetIds=[];
 assert.deepEqual(editScopeSnapshot(project,context),{assetIds:[],placement:{mode:'free'}});
 delete project.video.editScope.assetIds;
 assert.deepEqual(editScopeSnapshot(project,context),{placement:{mode:'free'}});
});

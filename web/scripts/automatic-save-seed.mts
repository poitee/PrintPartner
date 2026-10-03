import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SqliteDatabase,getDb} from '../apps/server/src/db/client.js';
import {AppRepository} from '../apps/server/src/db/repository.js';
const [root,shared,mode]=process.argv.slice(2);
if(!root||!shared||!mode)throw Error('arguments');
if(process.env.LD_PRELOAD||process.env.DYLD_INSERT_LIBRARIES)throw Error('preloads rejected');
const database=new SqliteDatabase(root);database.connect();const repo=new AppRepository(getDb(database),'default',join(shared,'repos'));
new AppRepository(getDb(database),'save-foreign',join(shared,'repos')).createProfile('Protected foreign Build');
let draft=repo.getPlanDraft(1,1);
if(mode==='null-first'){
 assert(draft);assert.equal(repo.transitionPlanDraft({profileId:1,draftId:draft.id,transition:{kind:'abandon',expectedLifecycleVersion:draft.lifecycleVersion}}).kind,'transitioned');draft=null;
}else if(mode==='multiple-open'){
 assert(draft);const next=repo.recomputePlanDraft({profileId:1,actor:'default',idempotencyKey:'other-open',applyManifest:true});assert.equal(next.kind,'created');const old=repo.getPlanDraft(1,1);assert(old);assert.equal(repo.transitionPlanDraft({profileId:1,draftId:1,transition:{kind:'resume',expectedLifecycleVersion:old.lifecycleVersion}}).kind,'transitioned');draft=repo.getPlanDraft(1,1);
}else if(mode==='explicit'){
 const next=repo.recomputePlanDraft({profileId:1,actor:'default',idempotencyKey:'explicit-observed',applyManifest:true});assert.equal(next.kind,'created');if(next.kind!=='created')throw Error('draft');
 const selected=repo.savePlanDraftRequiredUnitReconciliation({profileId:1,draftId:next.draft.id,expectedSnapshotDigest:next.draft.snapshotDigest,actorId:'default',idempotencyKey:'selected',decisions:next.draft.parts.map((p,index)=>({kind:'select_exact_predecessor',targetDraftPartId:p.id,predecessorRevisionPartId:index+1}))});assert.equal(selected.kind,'saved');draft=repo.getPlanDraft(1,next.draft.id);
}else if(mode==='live-inputs'){
 assert(draft);const selected=repo.savePlanDraftRequiredUnitReconciliation({profileId:1,draftId:1,expectedSnapshotDigest:draft.snapshotDigest,actorId:'default',idempotencyKey:'selected-before-source-move',decisions:[]});assert.equal(selected.kind,'saved');draft=repo.getPlanDraft(1,1);
 const source=repo.getProjectRow(1);assert(source);const revision=repo.recordSourceRevision({sourceId:1,upstreamRevisionKey:'save-moved',manifestDigest:'e'.repeat(64),snapshotLocator:'1/revisions/ordinary',syncedAt:new Date().toISOString(),completeness:'complete'});repo.activateSourceRevision({sourceId:1,revisionId:revision.id,observed:source,sourceVersion:'save-moved'});
}else if(mode==='checkoff'||mode==='plates'){
 draft=null;const accepted=repo.readAcceptedPlanOperationalSnapshot(1);assert.equal(accepted.kind,'ready');if(accepted.kind!=='ready')throw Error('snapshot');const a=accepted.snapshot;
 const published=repo.publishAcceptedPlates({profileId:1,expected:{profileId:1,revisionId:a.revisionId,planVersion:a.planVersion,revisionDigest:a.revisionDigest,requiredUnitMappingDigest:a.requiredUnitMappingDigest},expectedPlateRevisionId:null,plates:[{plateId:'save-plate',printerId:'fixture-printer',printerName:'Fixture printer',printerModel:'Fixture model',bedWidthUm:600000,bedDepthUm:500000,bedHeightUm:220000,marginUm:5000,units:a.parts.filter(p=>p.included).flatMap(p=>p.units).map((u,index)=>({token:u.token,xUm:5000+60000*index,yUm:5000,widthUm:50000,depthUm:40000,heightUm:30000}))}]});assert.equal(published.kind,'published');
 if(mode==='checkoff'){const part=a.parts.find(p=>p.included);assert(part);repo.setSetting('printer.checkoff_links',JSON.stringify([{id:'save-watch',filename:part.relativePath,profile_id:1,state:'watching',units:[{part_id:part.projectionPartId,unit_index:0}],resolved_units:[]}]))}
}else throw Error('unknown constructor');
const accepted=repo.getAcceptedPlanRevision(1);const base={revision_id:accepted?.id??null,plan_version:accepted?.planVersion??0};
const part=draft?.parts[0]??repo.getAcceptedPlanPartRows(1)?.[0];
let target;if(draft){const p=draft.parts[0];assert(p);target={part_key:p.partKey,relative_path:p.relativePath,source_layer:p.sourceLayer}}else if(part){target={part_key:part.match_key,relative_path:part.relative_path,source_layer:part.source_layer}}else target={part_key:'[a] cover.stl',relative_path:'[a] cover.stl',source_layer:'base:Ordinary Draft'};
const request={action:'save',profile:1,key:'constructed-'+mode,request:{expected_base:base,expected_draft:draft?{draft_id:draft.id,state:'open',lifecycle_version:draft.lifecycleVersion,snapshot_digest:draft.snapshotDigest,base:{revision_id:draft.baseRevisionId,plan_version:draft.basePlanVersion}}:null,remap_checkoff_links:false,decisions:[{kind:'set_quantity_override',target,value:2}]}};
writeFileSync(join(root,'save-request.jsonl'),JSON.stringify(request)+'\n'+JSON.stringify(request)+'\n');database.close();console.log(JSON.stringify({mode,request}));

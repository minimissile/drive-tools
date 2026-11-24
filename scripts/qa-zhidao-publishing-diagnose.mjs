import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export async function run({page,windowId}) {
  const snapshot=await page.evaluate(()=>window.panxu.invoke("snapshot"));
  const db=new DatabaseSync(join(snapshot.dataPath,"panxu.db"),{readOnly:true});
  try {
    const records=db.prepare("SELECT value FROM settings WHERE key LIKE 'zhidao-publishing-resource:%' ORDER BY json_extract(value,'$.updatedAt') DESC LIMIT 8").all().map(row=>JSON.parse(row.value));
    return {windowId,records:records.map(record=>{
      const copyId=record.copyId||record.resource.copyId;
      const copy=copyId&&db.prepare("SELECT c.account_id,c.owner_uid,c.status,c.verified_at,a.alias,a.uid,r.source_kind FROM copies c JOIN accounts a ON a.id=c.account_id JOIN resources r ON r.id=c.resource_id WHERE c.id=?").get(copyId);
      const environment=copy&&db.prepare("SELECT e.engine FROM browser_environment_accounts a JOIN browser_environments e ON a.environment_id=e.id WHERE a.kind='drive' AND a.account_id=?").get(copy.account_id);
      const times=record.operations.map(id=>db.prepare("SELECT json_extract(value,'$.receipt.createdAt') time FROM settings WHERE key=?").get(`share-creation:${id}`)?.time).filter(Boolean).map(Date.parse);
      const gaps=times.slice(1).map((time,i)=>Math.round((time-times[i])/100)/10);
      return {title:record.resource.title,stage:record.stage,links:record.links.length,lastShareSeconds:record.lastShareMs===undefined?null:record.lastShareMs/1000,account:copy?.alias,engine:environment?.engine||"electron",copyStatus:copy?.status,sourceKind:copy?.source_kind,ownerVerified:!!copy?.owner_uid&&copy.owner_uid===copy.uid,manifestVerified:!!copy?.verified_at,betweenCreateSeconds:gaps};
    })};
  }finally{db.close();}
}

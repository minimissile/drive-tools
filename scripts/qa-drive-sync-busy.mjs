export async function run({page}) {
  const result=await page.evaluate(async()=>{
    const snapshot=await window.panxu.invoke("snapshot");
    const environments=await window.panxu.invoke("environments.list");
    const jobs=await window.panxu.invoke("environments.jobs");
    const batch=await window.panxu.invoke("accountBatch.current");
    const scans=[];
    for(const account of snapshot.accounts) {
      const run=(await window.panxu.invoke("driveSync.index",{accountId:account.id})).run;
      if(run)scans.push({account:account.alias,status:run.status});
    }
    return {environments:environments.filter(e=>e.busy).map(e=>({name:e.name,accounts:e.accounts.map(a=>a.alias)})),jobs:jobs.filter(j=>['running','queued'].includes(j.status)).map(j=>({label:j.label,status:j.status,accounts:j.accounts})),batch:batch?.status,scans,transfers:snapshot.jobs.filter(j=>['queued','preflight','transferring','verifying','sharing','archiving'].includes(j.stage)).map(j=>({kind:j.kind,stage:j.stage})),discovery:snapshot.tiebaDiscoveryTasks?.map(t=>({status:t.status}))};
  });
  console.log(JSON.stringify(result,null,2));
}

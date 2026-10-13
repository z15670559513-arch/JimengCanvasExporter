let database;
async function db() {
  if (!database) database=new Promise((resolve,reject)=>{
    const r=indexedDB.open('jimeng-exporter-v2',1);
    r.onupgradeneeded=()=>{r.result.createObjectStore('tasks',{keyPath:'id'});r.result.createObjectStore('handles');};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  return database;
}
async function operation(store,mode,action) {
  const connection=await db();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction(store,mode);
    const r=action(tx.objectStore(store));
    tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('本地记录事务中断'));
  });
}
export const saveTask = task => operation('tasks','readwrite',s=>s.put(structuredClone(task)));
export const listTasks = () => operation('tasks','readonly',s=>s.getAll());
export const saveHandle = (id,handle) => operation('handles','readwrite',s=>s.put(handle,id));
export const getHandle = id => operation('handles','readonly',s=>s.get(id));

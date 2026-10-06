export async function getSessionToken():Promise<string|null>{
  const s=(window as unknown as {shopify?:{idToken?:()=>Promise<string>}}).shopify;
  return s?.idToken ? s.idToken() : null;
}

export async function api<T>(path:string, options:RequestInit={}, importKey?:string) {
  const token = await getSessionToken();
  const isForm = options.body instanceof FormData;
  const headers: Record<string,string> = {
    ...(isForm ? {} : {'Content-Type':'application/json'}),
    ...(token ? {Authorization:`Bearer ${token}`} : {}),
    ...(importKey ? {'x-import-key':importKey} : {}),
    ...(options.headers as Record<string,string> | undefined || {}),
  };
  const res=await fetch(path,{...options,headers});
  if(!res.ok) throw new Error((await res.json().catch(()=>({error:res.statusText}))).error||res.statusText);
  return (res.status===204?null:await res.json()) as T;
}

export async function uploadImport(file:File){
  const body=new FormData();
  body.append('file',file);
  return api<{id:string;accessKey:string;status:string;totalRows:number;uniqueProducts:number;duplicateRows:number;shopifyConnected:boolean}>(
    '/api/imports/upload',
    {method:'POST',body},
  );
}

export async function downloadImportCsv(importId:string, accessKey:string, fileName:string){
  const token=await getSessionToken();
  const res=await fetch(`/api/imports/${importId}/export`,{
    headers:{
      'x-import-key':accessKey,
      ...(token?{Authorization:`Bearer ${token}`}:{}),
    },
  });
  if(!res.ok) throw new Error((await res.json().catch(()=>({error:res.statusText}))).error||res.statusText);
  const blob=await res.blob();
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;
  anchor.download=fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

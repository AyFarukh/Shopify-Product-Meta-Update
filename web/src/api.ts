export async function api<T>(path:string, options:RequestInit={}) {
  const token = await getSessionToken();
  const res=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...(options.headers||{})}});
  if(!res.ok) throw new Error((await res.json().catch(()=>({error:res.statusText}))).error||res.statusText);
  return (res.status===204?null:await res.json()) as T;
}
async function getSessionToken():Promise<string|null>{
  const s=(window as unknown as {shopify?:{idToken?:()=>Promise<string>}}).shopify;
  return s?.idToken ? s.idToken() : null;
}

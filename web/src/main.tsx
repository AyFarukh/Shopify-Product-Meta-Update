import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@shopify/polaris/build/esm/styles.css';
import {
  AppProvider, Page, Card, Text, Button, BlockStack, InlineGrid, IndexTable, Badge,
  TextField, Select, Checkbox, Modal, InlineStack, ProgressBar, Banner, Tabs,
} from '@shopify/polaris';
import en from '@shopify/polaris/locales/en.json';
import { api, downloadImportCsv, uploadImport } from './api';

type Dashboard={totalProducts:number;syncedProducts:number;productsScanned:number;vendorsDetected:number;genericVendorProducts:number;alreadyCorrect:number;reviewRequired:number;readyToUpdate:number;updated:number;failed:number};
type Suggestion={id:string;suggestedVendor:string|null;confidence:number;reason:string;source:string;status:string;approved:boolean};
type Product={id:string;handle:string;title:string;currentVendor:string;suggestion:Suggestion|null};
type Job={id:string;type:string;status:string;total:number;processed:number;successful:number;failed:number;remaining:number;percentage:number;error?:string|null};
type JobStart={queued:boolean;jobId:string};
type HistoryJob={id:string;type:string;successful:number;failed:number;records:Array<{id:string}>};
type ImportSummary={id:string;accessKey:string;status:string;totalRows:number;uniqueProducts:number;duplicateRows:number;shopifyConnected:boolean;originalFileName?:string};
type ImportProduct={id:string;handle:string;title:string;currentVendor:string;suggestedVendor:string|null;confidence:number;reason:string;source:string;status:string;approved:boolean;manual:boolean};
type ImportList={batch:{id:string;originalFileName:string;totalRows:number;uniqueProducts:number;duplicateRows:number;status:string};items:ImportProduct[];total:number;page:number;pageSize:number};

function useJob(onDone:()=>void){
  const [job,setJob]=useState<Job|null>(null);
  useEffect(()=>{
    if(!job || ['COMPLETED','FAILED'].includes(job.status)) return;
    const timer=window.setInterval(()=>{void api<Job>(`/api/jobs/${job.id}`).then(next=>{setJob(next);if(['COMPLETED','FAILED'].includes(next.status))onDone()})},1000);
    return()=>window.clearInterval(timer);
  },[job?.id,job?.status]);
  return {job,start:async(result:JobStart)=>setJob(await api<Job>(`/api/jobs/${result.jobId}`))};
}

function JobCard({job}:{job:Job|null}){
  if(!job)return null;
  return <Card><BlockStack gap="200">
    <InlineStack align="space-between"><Text as="h3" variant="headingMd">{job.type} progress</Text><Badge tone={job.status==='FAILED'?'critical':job.status==='COMPLETED'?'success':'attention'}>{job.status}</Badge></InlineStack>
    <ProgressBar progress={job.total?job.percentage:job.status==='COMPLETED'?100:0}/>
    <Text as="p">Processed {job.processed}{job.total?` / ${job.total}`:''} · Successful {job.successful} · Failed {job.failed} · Remaining {job.remaining}</Text>
    {job.error?<Banner tone="critical">{job.error}</Banner>:null}
  </BlockStack></Card>;
}

function App(){
  const [tab,setTab]=useState(0);
  const tabs=[
    {id:'import',content:'ZIP / CSV Import'},
    {id:'dashboard',content:'Shopify Dashboard'},
    {id:'review',content:'Shopify Review'},
    {id:'history',content:'History'},
  ];
  return <AppProvider i18n={en}><Page title="Vendor Title Update"><Tabs tabs={tabs} selected={tab} onSelect={setTab}/><div style={{marginTop:16}}>
    {tab===0?<ImportPage/>:tab===1?<DashboardPage onReview={()=>setTab(2)}/>:tab===2?<ReviewPage/>:<HistoryPage/>}
  </div></Page></AppProvider>;
}

function ImportPage(){
  const [file,setFile]=useState<File|null>(null);
  const [summary,setSummary]=useState<ImportSummary|null>(null);
  const [items,setItems]=useState<ImportProduct[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [pageSize,setPageSize]=useState('25');
  const [q,setQ]=useState('');
  const [status,setStatus]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [editing,setEditing]=useState<ImportProduct|null>(null);
  const [vendor,setVendor]=useState('');
  const [confirm,setConfirm]=useState(false);
  const [connected,setConnected]=useState(false);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const {job,start}=useJob(()=>{if(summary)void loadRows(summary)});

  const loadRows=async(current=summary)=>{
    if(!current)return;
    try{
      const result=await api<ImportList>(
        `/api/imports/${current.id}/products?page=${page}&pageSize=${pageSize}&q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`,
        {},
        current.accessKey,
      );
      setItems(result.items);
      setTotal(result.total);
      setSummary(prev=>prev?{...prev,originalFileName:result.batch.originalFileName,totalRows:result.batch.totalRows,uniqueProducts:result.batch.uniqueProducts,duplicateRows:result.batch.duplicateRows}:prev);
    }catch(e){setError((e as Error).message)}
  };

  useEffect(()=>{void api<{connected:boolean}>('/api/imports/shopify-status').then(r=>setConnected(r.connected)).catch(()=>setConnected(false))},[]);
  useEffect(()=>{if(summary)void loadRows(summary)},[summary?.id,page,pageSize,q,status]);

  const doUpload=async()=>{
    if(!file)return;
    setBusy(true);setError('');
    try{
      const result=await uploadImport(file);
      const next={...result,originalFileName:file.name};
      setSummary(next);
      setConnected(result.shopifyConnected);
      setSelected([]);
      setPage(1);
    }catch(e){setError((e as Error).message)}
    finally{setBusy(false)}
  };

  const approve=async(allFiltered:boolean)=>{
    if(!summary)return;
    const body=allFiltered
      ? {allFiltered:true,q,status,approved:true}
      : {ids:selected,approved:true};
    const result=await api<{count:number}>(`/api/imports/${summary.id}/approve`,{method:'POST',body:JSON.stringify(body)},summary.accessKey);
    setSelected([]);
    await loadRows(summary);
    return result.count;
  };

  const updateShopify=async()=>{
    if(!summary)return;
    const result=await api<JobStart>(
      `/api/imports/${summary.id}/update-shopify`,
      {method:'POST',body:JSON.stringify({ids:selected.length?selected:undefined,confirmed:true})},
      summary.accessKey,
    );
    setConfirm(false);
    setSelected([]);
    await start(result);
  };

  return <BlockStack gap="400">
    {error?<Banner tone="critical" onDismiss={()=>setError('')}>{error}</Banner>:null}
    <Card><BlockStack gap="300">
      <Text as="h2" variant="headingMd">Upload Shopify product export</Text>
      <Text as="p" tone="subdued">Upload a Shopify product CSV directly, or a ZIP containing the CSV. Only Handle, Title, and Vendor are used for analysis. Variant rows are grouped by Handle.</Text>
      <input type="file" accept=".zip,.csv,text/csv,application/zip" onChange={event=>setFile(event.target.files?.[0]??null)}/>
      <InlineStack gap="300" blockAlign="center">
        <Button variant="primary" disabled={!file||busy} loading={busy} onClick={doUpload}>Upload and analyze</Button>
        <Badge tone={connected?'success':'attention'}>{connected?'Shopify connected':'CSV-only mode'}</Badge>
      </InlineStack>
    </BlockStack></Card>

    {summary?<>
      <InlineGrid columns={{xs:2,md:4}} gap="300">
        <Card><Text as="p" tone="subdued">CSV rows</Text><Text as="p" variant="headingLg">{summary.totalRows}</Text></Card>
        <Card><Text as="p" tone="subdued">Unique products</Text><Text as="p" variant="headingLg">{summary.uniqueProducts}</Text></Card>
        <Card><Text as="p" tone="subdued">Duplicate variant rows</Text><Text as="p" variant="headingLg">{summary.duplicateRows}</Text></Card>
        <Card><Text as="p" tone="subdued">Mode</Text><Text as="p" variant="headingMd">{connected?'Shopify + CSV':'CSV export only'}</Text></Card>
      </InlineGrid>

      <Card><InlineGrid columns={{xs:1,md:4}} gap="300">
        <TextField label="Search" value={q} onChange={setQ} autoComplete="off"/>
        <Select label="Status" value={status} onChange={setStatus} options={[{label:'All',value:''},...['HIGH_CONFIDENCE','REVIEW_RECOMMENDED','REVIEW_REQUIRED','ALREADY_CORRECT','CONFLICT','UPDATED','FAILED','NO_VENDOR_FOUND'].map(value=>({label:value.replaceAll('_',' '),value}))]}/>
        <Select label="Page size" value={pageSize} onChange={setPageSize} options={['25','50','100']}/>
        <InlineStack gap="200" blockAlign="end">
          <Button disabled={!selected.length} onClick={()=>void approve(false)}>Approve selected</Button>
          <Button onClick={()=>void approve(true)}>Approve all filtered</Button>
        </InlineStack>
      </InlineGrid></Card>

      <JobCard job={job}/>

      <Card><IndexTable resourceName={{singular:'product',plural:'products'}} itemCount={items.length} selectable={false} headings={[{title:''},{title:'Product Title'},{title:'Current Vendor'},{title:'Suggested Vendor'},{title:'Confidence'},{title:'Status'},{title:'Action'}]}>
        {items.map((item,index)=><IndexTable.Row id={item.id} key={item.id} position={index}>
          <IndexTable.Cell><Checkbox label="Select" labelHidden checked={selected.includes(item.id)} onChange={checked=>setSelected(current=>checked?[...new Set([...current,item.id])]:current.filter(id=>id!==item.id))}/></IndexTable.Cell>
          <IndexTable.Cell>{item.title}<div><Text as="span" tone="subdued">{item.handle}</Text></div></IndexTable.Cell>
          <IndexTable.Cell>{item.currentVendor||'—'}</IndexTable.Cell>
          <IndexTable.Cell>{item.suggestedVendor||'—'}</IndexTable.Cell>
          <IndexTable.Cell>{item.confidence}%</IndexTable.Cell>
          <IndexTable.Cell><Badge tone={item.status==='CONFLICT'||item.status==='FAILED'?'critical':item.status==='HIGH_CONFIDENCE'||item.status==='UPDATED'?'success':'attention'}>{item.status}</Badge></IndexTable.Cell>
          <IndexTable.Cell><Button size="slim" onClick={()=>{setEditing(item);setVendor(item.suggestedVendor||'')}}>Edit</Button></IndexTable.Cell>
        </IndexTable.Row>)}
      </IndexTable>
      <div style={{paddingTop:16}}><InlineStack align="space-between">
        <Text as="p">{total} products</Text>
        <InlineStack gap="200"><Button disabled={page<=1} onClick={()=>setPage(value=>value-1)}>Previous</Button><Button disabled={page*Number(pageSize)>=total} onClick={()=>setPage(value=>value+1)}>Next</Button></InlineStack>
      </InlineStack></div></Card>

      <Card><InlineStack gap="300">
        <Button onClick={()=>void downloadImportCsv(summary.id,summary.accessKey,`${(summary.originalFileName||'products').replace(/\.(zip|csv)$/i,'')}-corrected.csv`)}>Export corrected CSV</Button>
        {connected?<Button variant="primary" disabled={!selected.length} onClick={()=>setConfirm(true)}>Update approved in Shopify</Button>:<Text as="p" tone="subdued">Connect Shopify later to apply approved vendor updates, or export the corrected CSV now.</Text>}
      </InlineStack></Card>

      <Modal open={Boolean(editing)} onClose={()=>setEditing(null)} title="Manual vendor correction" primaryAction={{content:'Save correction',onAction:async()=>{
        if(!summary||!editing)return;
        await api(`/api/imports/${summary.id}/products/${editing.id}`,{method:'PATCH',body:JSON.stringify({suggestedVendor:vendor})},summary.accessKey);
        setEditing(null);
        await loadRows(summary);
      }}}><Modal.Section><TextField label="Suggested Vendor" value={vendor} onChange={setVendor} autoComplete="off"/></Modal.Section></Modal>

      <Modal open={confirm} onClose={()=>setConfirm(false)} title="Confirm Shopify Vendor Update" primaryAction={{content:'Confirm Vendor Update',onAction:updateShopify}} secondaryActions={[{content:'Cancel',onAction:()=>setConfirm(false)}]}>
        <Modal.Section><Banner tone="warning">Only Shopify product.vendor will be changed. Current Shopify values are read again before each update and saved for undo/history.</Banner><p>Selected approved products: {selected.length}</p></Modal.Section>
      </Modal>
    </>:null}
  </BlockStack>;
}

function DashboardPage({onReview}:{onReview:()=>void}){
  const [data,setData]=useState<Dashboard|null>(null);
  const [error,setError]=useState('');
  const load=()=>api<Dashboard>('/api/dashboard').then(setData).catch(e=>setError((e as Error).message));
  const {job,start}=useJob(()=>{void load()});
  useEffect(()=>{void load()},[]);
  const run=async(path:string)=>start(await api<JobStart>(path,{method:'POST'}));
  return <BlockStack gap="400">
    {error?<Banner tone="warning">{error}. ZIP/CSV import still works without a Shopify connection.</Banner>:null}
    <InlineGrid columns={{xs:2,md:5}} gap="300">{data?Object.entries(data).map(([key,value])=><Card key={key}><Text as="p" tone="subdued">{human(key)}</Text><Text as="p" variant="headingLg">{value}</Text></Card>):null}</InlineGrid>
    <Card><InlineStack gap="300"><Button onClick={()=>run('/api/products/sync')}>Sync Products</Button><Button onClick={()=>run('/api/vendors/scan')}>Scan Vendors</Button><Button onClick={onReview}>Review Suggestions</Button></InlineStack></Card>
    <JobCard job={job}/>
  </BlockStack>;
}

function ReviewPage(){
  const [items,setItems]=useState<Product[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(1),[pageSize,setPageSize]=useState('25');
  const [q,setQ]=useState(''),[status,setStatus]=useState(''),[selected,setSelected]=useState<string[]>([]);
  const [edit,setEdit]=useState<Product|null>(null),[vendor,setVendor]=useState(''),[confirm,setConfirm]=useState(false);
  const load=()=>api<{items:Product[];total:number}>(`/api/products?page=${page}&pageSize=${pageSize}&q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`).then(r=>{setItems(r.items);setTotal(r.total)});
  const {job,start}=useJob(()=>{void load()});
  useEffect(()=>{void load()},[page,pageSize,q,status]);
  const suggestionIds=items.filter(p=>selected.includes(p.id)&&p.suggestion).map(p=>p.suggestion!.id);
  const approve=async()=>{if(!suggestionIds.length)return;await api('/api/vendors/approve',{method:'POST',body:JSON.stringify({ids:suggestionIds,approved:true})});await load()};
  const update=async()=>{const result=await api<JobStart>('/api/vendors/update',{method:'POST',body:JSON.stringify({productIds:selected,confirmed:true})});setConfirm(false);setSelected([]);await start(result)};
  return <BlockStack gap="400">
    <Card><InlineGrid columns={{xs:1,md:4}} gap="300"><TextField label="Search" value={q} onChange={setQ} autoComplete="off"/><Select label="Status" value={status} onChange={setStatus} options={[{label:'All',value:''},...['HIGH_CONFIDENCE','REVIEW_RECOMMENDED','REVIEW_REQUIRED','ALREADY_CORRECT','CONFLICT','UPDATED','NO_VENDOR_FOUND'].map(value=>({label:value.replaceAll('_',' '),value}))]}/><Select label="Page size" value={pageSize} onChange={setPageSize} options={['25','50','100']}/><InlineStack gap="200" blockAlign="end"><Button onClick={approve}>Approve selected</Button><Button variant="primary" disabled={!selected.length} onClick={()=>setConfirm(true)}>Update Shopify</Button></InlineStack></InlineGrid></Card>
    <JobCard job={job}/>
    <Card><IndexTable resourceName={{singular:'product',plural:'products'}} itemCount={items.length} selectable={false} headings={[{title:''},{title:'Product Title'},{title:'Current Vendor'},{title:'Suggested Vendor'},{title:'Confidence'},{title:'Status'},{title:'Action'}]}>
      {items.map((p,i)=><IndexTable.Row id={p.id} key={p.id} position={i}>
        <IndexTable.Cell><Checkbox label="Select" labelHidden checked={selected.includes(p.id)} onChange={checked=>setSelected(current=>checked?[...new Set([...current,p.id])]:current.filter(id=>id!==p.id))}/></IndexTable.Cell>
        <IndexTable.Cell>{p.title}<div><Text as="span" tone="subdued">{p.handle}</Text></div></IndexTable.Cell>
        <IndexTable.Cell>{p.currentVendor||'—'}</IndexTable.Cell>
        <IndexTable.Cell>{p.suggestion?.suggestedVendor||'—'}</IndexTable.Cell>
        <IndexTable.Cell>{p.suggestion?`${p.suggestion.confidence}%`:'—'}</IndexTable.Cell>
        <IndexTable.Cell>{p.suggestion?<Badge tone={p.suggestion.status==='CONFLICT'?'critical':p.suggestion.status==='HIGH_CONFIDENCE'?'success':'attention'}>{p.suggestion.status}</Badge>:'—'}</IndexTable.Cell>
        <IndexTable.Cell><Button size="slim" disabled={!p.suggestion} onClick={()=>{setEdit(p);setVendor(p.suggestion?.suggestedVendor||'')}}>Edit</Button></IndexTable.Cell>
      </IndexTable.Row>)}
    </IndexTable><div style={{paddingTop:16}}><InlineStack align="space-between"><Text as="p">{total} products</Text><InlineStack gap="200"><Button disabled={page<=1} onClick={()=>setPage(v=>v-1)}>Previous</Button><Button disabled={page*Number(pageSize)>=total} onClick={()=>setPage(v=>v+1)}>Next</Button></InlineStack></InlineStack></div></Card>
    <Modal open={confirm} onClose={()=>setConfirm(false)} title="Confirm Vendor Update" primaryAction={{content:'Confirm Vendor Update',onAction:update}} secondaryActions={[{content:'Cancel',onAction:()=>setConfirm(false)}]}><Modal.Section><Banner tone="warning">Only Shopify product.vendor will be changed.</Banner><p>Selected products: {selected.length}</p>{items.filter(p=>selected.includes(p.id)).slice(0,10).map(p=><p key={p.id}>{p.currentVendor||'Empty'} → {p.suggestion?.suggestedVendor||'No suggestion'}</p>)}</Modal.Section></Modal>
    <Modal open={Boolean(edit)} onClose={()=>setEdit(null)} title="Manual vendor correction" primaryAction={{content:'Save',onAction:async()=>{if(!edit?.suggestion)return;await api(`/api/vendors/suggestions/${edit.suggestion.id}`,{method:'PATCH',body:JSON.stringify({suggestedVendor:vendor})});setEdit(null);await load()}}}><Modal.Section><TextField label="Suggested Vendor" value={vendor} onChange={setVendor} autoComplete="off"/></Modal.Section></Modal>
  </BlockStack>;
}

function HistoryPage(){
  const [jobs,setJobs]=useState<HistoryJob[]>([]);
  const [error,setError]=useState('');
  const load=()=>api<HistoryJob[]>('/api/history').then(setJobs).catch(e=>setError((e as Error).message));
  const {job,start}=useJob(()=>{void load()});
  useEffect(()=>{void load()},[]);
  return <BlockStack gap="300">{error?<Banner tone="warning">{error}</Banner>:null}<JobCard job={job}/>{jobs.map(item=><Card key={item.id}><InlineStack align="space-between"><div><Text as="h3" variant="headingMd">{item.type} {item.id.slice(-6)}</Text><Text as="p">{item.successful} successful · {item.failed} failed · {item.records.length} records</Text></div>{item.type==='UPDATE'||item.type==='CSV_IMPORT_UPDATE'?<Button onClick={async()=>start(await api<JobStart>(`/api/history/${item.id}/undo`,{method:'POST'}))}>Undo Vendor Changes</Button>:null}</InlineStack></Card>)}</BlockStack>;
}

function human(value:string){return value.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

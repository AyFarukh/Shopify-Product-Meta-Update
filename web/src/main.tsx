import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@shopify/polaris/build/esm/styles.css';
import {
  AppProvider, Page, Card, Text, Button, BlockStack, InlineGrid, IndexTable, Badge,
  TextField, Select, Checkbox, Modal, InlineStack, ProgressBar, Banner, Tabs,
} from '@shopify/polaris';
import en from '@shopify/polaris/locales/en.json';
import { api } from './api';

type Dashboard={totalProducts:number;syncedProducts:number;productsScanned:number;vendorsDetected:number;genericVendorProducts:number;alreadyCorrect:number;reviewRequired:number;readyToUpdate:number;updated:number;failed:number};
type Suggestion={id:string;suggestedVendor:string|null;confidence:number;reason:string;source:string;status:string;approved:boolean};
type Product={id:string;handle:string;title:string;currentVendor:string;suggestion:Suggestion|null};
type Job={id:string;type:string;status:string;total:number;processed:number;successful:number;failed:number;remaining:number;percentage:number;error?:string|null};
type JobStart={queued:boolean;jobId:string};
type HistoryJob={id:string;type:string;successful:number;failed:number;records:Array<{id:string}>};

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
  const tabs=[{id:'dashboard',content:'Dashboard'},{id:'review',content:'Review Suggestions'},{id:'history',content:'History'}];
  return <AppProvider i18n={en}><Page title="Vendor Title Update"><Tabs tabs={tabs} selected={tab} onSelect={setTab}/><div style={{marginTop:16}}>{tab===0?<DashboardPage onReview={()=>setTab(1)}/>:tab===1?<ReviewPage/>:<HistoryPage/>}</div></Page></AppProvider>;
}

function DashboardPage({onReview}:{onReview:()=>void}){
  const [data,setData]=useState<Dashboard|null>(null);
  const load=()=>api<Dashboard>('/api/dashboard').then(setData);
  const {job,start}=useJob(()=>{void load()});
  useEffect(()=>{void load()},[]);
  const run=async(path:string)=>start(await api<JobStart>(path,{method:'POST'}));
  return <BlockStack gap="400">
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
  const load=()=>api<HistoryJob[]>('/api/history').then(setJobs);
  const {job,start}=useJob(()=>{void load()});
  useEffect(()=>{void load()},[]);
  return <BlockStack gap="300"><JobCard job={job}/>{jobs.map(item=><Card key={item.id}><InlineStack align="space-between"><div><Text as="h3" variant="headingMd">{item.type} {item.id.slice(-6)}</Text><Text as="p">{item.successful} successful · {item.failed} failed · {item.records.length} records</Text></div>{item.type==='UPDATE'?<Button onClick={async()=>start(await api<JobStart>(`/api/history/${item.id}/undo`,{method:'POST'}))}>Undo Vendor Changes</Button>:null}</InlineStack></Card>)}</BlockStack>;
}

function human(value:string){return value.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

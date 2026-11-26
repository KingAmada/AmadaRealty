const tiers = {ny:[1,14,'NY'], london:[15,28,'LDN'], naija:[29,42,'PAR'], dubai:[43,56,'DXB'], canada:[57,70,'SAN'], presidential:[0,0,'PV']};
const MAX_BODY = 2048;
const response = (body,status=200,headers={}) => Response.json(body,{status,headers:{
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers
}});

async function readPayload(request) {
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>MAX_BODY) throw new RangeError('too large');
  const reader=request.body?.getReader();
  if(!reader) throw new SyntaxError('missing body');
  let size=0,s='';
  const decoder=new TextDecoder('utf-8',{fatal:true});
  while(true) {
    const {value,done}=await reader.read();
    if(done) break;
    size+=value.length;
    if(size>MAX_BODY) {await reader.cancel();throw new RangeError('too large');}
    s+=decoder.decode(value,{stream:true});
  }
  return JSON.parse(s+decoder.decode());
}
function validate(input) {
  if(!input || typeof input!=='object' || Array.isArray(input))return null;
  const {tier,requestKey}=input;
  const fullName=typeof input.fullName==='string' ? input.fullName.trim().replace(/\s+/gu,' ') : '';
  const phone=typeof input.phone==='string' ? input.phone.trim() : '';
  const plot=typeof input.plot==='string' ? input.plot : '';
  if(typeof tier!=='string' || !Object.hasOwn(tiers,tier))return null;
  if(fullName.length<2 || fullName.length>80 || !/\p{L}/u.test(fullName) || /[\p{Cc}\p{Cf}<>]/u.test(fullName))return null;
  if(!/^\d{11}$/.test(phone))return null;
  if(typeof requestKey!=='string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(requestKey))return null;
  if(plot){
    if(tier==='presidential'){if(!/^PV-0[1-5]$/.test(plot))return null;}
    else if(!/^Plot \d{2}$/.test(plot) || +plot.slice(5)<tiers[tier][0] || +plot.slice(5)>tiers[tier][1])return null;
  }
  return {fullName,phone,plot,tier,requestKey};
}
async function rateKey(secret,ip,window) {
  const e=new TextEncoder();
  const k=await crypto.subtle.importKey('raw',e.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',k,e.encode(window+':'+ip)));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
function receipt(row,status) {
  return response({reference:row.reference,receivedAt:row.received_at},status);
}
export async function onRequest({request,env}) {
  if(request.method!=='POST') return response({error:'Method not allowed.'},405,{Allow:'POST'});
  const origin=request.headers.get('origin');
  if(origin ? origin!==new URL(request.url).origin : request.headers.get('sec-fetch-site')!=='same-origin') return response({error:'Open the application form on Amada Residence to submit.'},403);
  if(!(request.headers.get('content-type')||'').match(/^application\/json(?:\s*;|$)/i))return response({error:'Unsupported submission format.'},415);
  let data;
  try{data=validate(await readPayload(request));}
  catch(err){return response({error:'Invalid submission.'},err instanceof RangeError ? 413 : 400);}
  if(!data)return response({error:'Check your name, phone number and residence selection.'},400);
  const db=env.AMADA_APPLICATIONS, secret=env.AMADA_RATE_SECRET;
  const ip=request.headers.get('CF-Connecting-IP');
  if(!db || !secret || !ip)return response({error:'Applications are temporarily unavailable. Please try again.'},503);
  const {fullName,phone,tier,plot,requestKey}=data;
  try{
    const prior=await db.prepare('SELECT reference,received_at,full_name,phone,tier,plot FROM residency_applications WHERE request_key = ?').bind(requestKey).first();
    if(prior){
      if(prior.full_name===fullName && prior.phone===phone && prior.tier===tier && prior.plot===plot)return receipt(prior,200);
      return response({error:'Your details changed. Please submit again.'},409);
    }
    const window=Math.floor(Date.now()/3600000);
    const hash=await rateKey(secret,ip,window);
    const cap=await db.batch([
      db.prepare('DELETE FROM submission_limits WHERE window < ?').bind(window-1),
      db.prepare('INSERT INTO submission_limits (rate_key,window,hits) VALUES (?,?,1) ON CONFLICT(rate_key) DO UPDATE SET hits=hits+1 WHERE hits<8 RETURNING hits').bind(hash,window)
    ]);
    if(!cap[1].results?.length)return response({error:'Too many submissions from this connection. Please try again later.'},429,{'Retry-After':String(3600-Math.floor(Date.now()/1000)%3600)});
    const reference='AMR-'+tiers[tier][2]+'-'+crypto.randomUUID().replace(/-/g,'').slice(0,12).toUpperCase();
    const receivedAt=new Date().toISOString();
    const saved=await db.prepare('INSERT INTO residency_applications (reference,request_key,full_name,phone,tier,plot,received_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING RETURNING reference,received_at').bind(reference,requestKey,fullName,phone,tier,plot,receivedAt).first();
    if(saved)return receipt(saved,201);
    const existing=await db.prepare('SELECT reference,received_at FROM residency_applications WHERE request_key = ? AND full_name = ? AND phone = ? AND tier = ? AND plot = ?').bind(requestKey,fullName,phone,tier,plot).first();
    return existing ? receipt(existing,200) : response({error:'Please review your details and try again.'},409);
  }catch{
    console.error('residency_application_save_failed');
    return response({error:'We could not save your request. Please try again.'},503);
  }
}
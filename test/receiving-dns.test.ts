import {applyD1Migrations, env} from "cloudflare:test";
import {beforeEach, afterEach, expect, it, vi} from "vitest";
import {adminApp} from "../src/admin";

type Record = {id?: string;type: string;name: string;content: string;priority?: number;ttl?: number};
const name = "r.example.com";
const path = `/receiving-domains/${name}`;
const zone = "test-zone";
let existing: Record[];
let required: Record[];
let routingEnabled: boolean;
let failBatch: boolean;
let failActivation: boolean;
let activations: {name?:string}[];
let catchAllWrites: unknown[];
let writes: {url: string;body: {deletes: {id: string}[];patches: Record[];posts: Record[]}}[];
const bindings = new Proxy(env, {get(target, property, receiver) {
  return property === "CLOUDFLARE_EMAIL_ROUTING_TOKEN" ? "test-routing-token" : Reflect.get(target, property, receiver);
}});

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("INSERT INTO receiving_domains(name,zone_id,status,addresses_json,created_at) VALUES(?,?,'pending',?,?)")
    .bind(name, zone, JSON.stringify(["calendar@r.example.com"]), new Date().toISOString()).run();
  existing = [
    {id:"apex",type:"MX",name:"example.com",content:"production.example.net",priority:10,ttl:300},
    {id:"old",type:"MX",name,content:"inbound-smtp.eu-west-1.amazonaws.com",priority:10,ttl:300},
    {id:"spf",type:"TXT",name,content:"v=spf1 include:mailgun.org -all",ttl:300},
    {id:"verification",type:"TXT",name,content:"unrelated-verification",ttl:300},
  ];
  required = [
    {type:"MX",name:"example.com",content:"route1.mx.cloudflare.net.",priority:10,ttl:1},
    {type:"MX",name:"example.com",content:"route2.mx.cloudflare.net.",priority:20,ttl:1},
    {type:"MX",name:"example.com",content:"route3.mx.cloudflare.net.",priority:30,ttl:1},
    {type:"TXT",name:"example.com",content:'"v=spf1 include:_spf.mx.cloudflare.net ~all"',ttl:1},
  ];
  routingEnabled = true;
  failBatch = false;
  failActivation = false;
  activations = [];
  writes = [];
  catchAllWrites = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if(url.hostname !== "api.cloudflare.com") throw Error("Unexpected network destination");
    if(request.method !== "GET") {
      if (url.pathname.endsWith("/email/routing/dns")) {
        const body = await request.json() as {name?: string};
        activations.push(body);
        if (failActivation) return Response.json({success:false,errors:[{message:"Zone Settings Write permission required"}]},{status:403});
        return Response.json({success:true,result:{enabled:true,name:body.name ?? "example.com"}});
      }
      if (url.pathname.endsWith("/email/routing/rules/catch_all")) {
        catchAllWrites.push(await request.json());
        return Response.json({success:true,result:{}});
      }
      expect(url.pathname).toBe(`/client/v4/zones/${zone}/dns_records/batch`);
      writes.push({url:request.url,body:{deletes:[],patches:[],posts:[],...await request.json() as any}});
      if (!failBatch) {
        const batch = writes.at(-1)!.body;
        existing = existing.filter(record => !batch.deletes.some(deleted => deleted.id === record.id));
        for (const patch of batch.patches) Object.assign(existing.find(record => record.id === patch.id)!, patch);
        for (const record of batch.posts) existing.push({...record, id: `created-${existing.length}`});
      }
      return Response.json(failBatch ? {success:false,errors:[{message:"DNS Edit permission required"}]} : {success:true,result:{}}, {status:failBatch?403:200});
    }
    let result: unknown;
    if(url.pathname === "/client/v4/zones") result=url.searchParams.get("name")==="example.com" ? [{id:zone,name:"example.com"}] : [];
    else if(url.pathname.endsWith("/email/routing/rules/catch_all")) result={id:"catch_all",enabled:false,name:"",matchers:[{type:"all"}],actions:[{type:"drop"}]};
    else if(url.pathname.endsWith("/email/routing/dns")) result=required;
    else if(url.pathname===`/client/v4/zones/${zone}`) result={name:"example.com"};
    else if(url.pathname.endsWith("/email/routing/rules")) result=[{id:"existing-rule",enabled:true,matchers:[{type:"literal",field:"to",value:"calendar@r.example.com"}],actions:[{type:"worker",value:[env.WORKER_NAME]}]}];
    else if(url.pathname.endsWith("/email/routing")) result={enabled:routingEnabled};
    else if(url.pathname.endsWith("/dns_records")) result=existing.filter(r=>r.name===url.searchParams.get("name"));
    else throw Error("Unexpected Cloudflare API path");
    return Response.json({success:true,result});
  });
});
afterEach(()=>vi.unstubAllGlobals());
async function preview() {
  const response=await adminApp.fetch(new Request(`http://localhost${path}?setup=true`),bindings);
  expect(response.status).toBe(200);
  const html=await response.text();
  const snapshot=html.match(/name="snapshot" value="([a-f0-9]+)"/)?.[1];
  expect(snapshot).toBeTruthy();
  return {html,snapshot:snapshot!};
}
async function migrate(snapshot:string, mode="replace", confirm=name, origin="http://localhost") {
  return adminApp.fetch(new Request(`http://localhost${path}/migrate-dns`, {
    method:"POST",headers:{Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({snapshot,mx_mode:mode,confirm_dns:confirm}),
  }),bindings);
}

it("previews a domain-specific migration without changing DNS",async()=>{
  const {html}=await preview();
  expect(html).toContain("Migrate now");
  expect(html).not.toContain("added the record");
  expect(html).toContain("inbound-smtp.eu-west-1.amazonaws.com");
  expect(html).toContain("include:mailgun.org include:_spf.mx.cloudflare.net -all");
  expect(html).toContain('value="replace"');
  expect(html).not.toContain('value="overlap"');
  expect(html).not.toContain("production.example.net");
  expect(writes).toEqual([]);
});
it("requires explicit approval, a current preview, and same-origin Access-protected requests",async()=>{
  const {snapshot}=await preview();
  expect((await migrate(snapshot,"replace","")).status).toBe(422);
  expect((await migrate(snapshot,"replace",name,"https://other.example.org")).status).toBe(403);
  existing.push({id:"new",type:"MX",name,content:"second-provider.example.net",priority:5});
  expect((await migrate(snapshot)).status).toBe(409);
  expect((await adminApp.fetch(new Request(`https://admin.example.com${path}/migrate-dns`,{method:"POST"}),bindings)).status).toBe(401);
  expect(writes).toEqual([]);
});
it("replaces only the chosen domain's provider MX and merges SPF in one Cloudflare batch",async()=>{
  const {snapshot}=await preview();
  expect((await migrate(snapshot)).status).toBe(303);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body.deletes).toEqual([{id:"old"}]);
  expect(writes[0]!.body.patches).toEqual([{id:"spf",type:"TXT",name,ttl:300,content:"v=spf1 include:mailgun.org include:_spf.mx.cloudflare.net -all"}]);
  expect(writes[0]!.body.posts).toEqual([10,20,30].map((priority,i)=>({type:"MX",name,content:`route${i+1}.mx.cloudflare.net.`,ttl:1,priority})));
  expect(await env.DB.prepare("SELECT status FROM receiving_domains WHERE name=?").bind(name).first("status")).toBe("verified");
});
it("removes the previous provider, preserves unrelated records, and activates only the selected subdomain even when apex routing is disabled",async()=>{
  routingEnabled=false;
  existing=existing.filter(r=>r.id!=="spf");
  const {snapshot}=await preview();
  const response = await migrate(snapshot);
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe(`${path}?migrated=true`);
  expect(activations).toEqual([{name}]);
  expect(existing.filter(r=>r.name===name && r.type==="MX").map(r=>r.content)).toEqual([
    "route1.mx.cloudflare.net.","route2.mx.cloudflare.net.","route3.mx.cloudflare.net.",
  ]);
  expect(existing).toContainEqual({id:"apex",type:"MX",name:"example.com",content:"production.example.net",priority:10,ttl:300});
  expect(existing).toContainEqual({id:"verification",type:"TXT",name,content:"unrelated-verification",ttl:300});
  expect(await env.DB.prepare("SELECT status FROM receiving_domains WHERE name=?").bind(name).first("status")).toBe("verified");
});
it("restores the old provider and reports incomplete migration if activation is rejected",async()=>{
  routingEnabled=false;
  failActivation=true;
  const {snapshot}=await preview();
  const response=await migrate(snapshot);
  expect(response.status).toBe(303);
  expect(decodeURIComponent(response.headers.get("Location")!)).toContain("previous provider’s MX records were restored");
  expect(existing).toContainEqual(expect.objectContaining({name,type:"MX",content:"inbound-smtp.eu-west-1.amazonaws.com",priority:10}));
  expect(existing).toContainEqual({id:"apex",type:"MX",name:"example.com",content:"production.example.net",priority:10,ttl:300});
  expect(await env.DB.prepare("SELECT status FROM receiving_domains WHERE name=?").bind(name).first("status")).toBe("pending");
  failActivation=false;
  const refreshed=await preview();
  expect((await migrate(refreshed.snapshot)).headers.get("Location")).toBe(`${path}?migrated=true`);
  expect(existing.filter(r=>r.name===name && r.type==="MX")).toHaveLength(3);
});
it.each(["duplicate SPF","CNAME"])("blocks ambiguous DNS before any writes: %s",async(reason)=>{
  existing.push(reason==="duplicate SPF" ? {id:"second-spf",type:"TXT",name,content:"v=spf1 -all"} : {id:"cname",type:"CNAME",name,content:"alias.example.net"});
  const {snapshot}=await preview();
  expect((await migrate(snapshot)).status).toBe(409);
  expect(writes).toEqual([]);
});
it("keeps domain status unchanged if Cloudflare rejects the batch",async()=>{
  await env.DB.prepare("UPDATE receiving_domains SET status='verified' WHERE name=?").bind(name).run();
  const {snapshot}=await preview();failBatch=true;
  expect((await migrate(snapshot)).status).toBe(502);
  expect(await env.DB.prepare("SELECT status FROM receiving_domains WHERE name=?").bind(name).first("status")).toBe("verified");
});
it("does not duplicate DNS records when the target configuration is already present",async()=>{
  existing=required.map((r,i)=>({...r,id:String(i),name,content:r.type==="TXT"?"v=spf1 include:_spf.mx.cloudflare.net ~all":r.content}));
  const {snapshot}=await preview();
  expect((await migrate(snapshot)).status).toBe(303);
  expect(writes).toEqual([]);
});

async function addDomain(fields: {[key:string]:string}) {
  return adminApp.fetch(new Request("http://localhost/receiving-domains", {
    method:"POST",headers:{Origin:"http://localhost","Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams(fields),
  }),bindings);
}
it("automatically uses catch-all for apex domains and installs it when migration completes",async()=>{
  const response=await addDomain({name:"example.com",addresses:"stale@example.com"});
  expect(response.status).toBe(303);
  expect(await env.DB.prepare("SELECT addresses_json FROM receiving_domains WHERE name='example.com'").first("addresses_json")).toBe("[]");
  const previewResponse=await adminApp.fetch(new Request("http://localhost/receiving-domains/example.com"),bindings);
  const html=await previewResponse.text();
  expect(html).toContain("All addresses on this domain");
  const snapshot=html.match(/name="snapshot" value="([a-f0-9]+)"/)![1]!;
  const migrated=await adminApp.fetch(new Request("http://localhost/receiving-domains/example.com/migrate-dns",{
    method:"POST",headers:{Origin:"http://localhost","Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({snapshot,mx_mode:"replace",confirm_dns:"example.com"}),
  }),bindings);
  expect(migrated.status).toBe(303);
  expect(activations).toEqual([{}]);
  expect(catchAllWrites).toEqual([{name:"open-resend example.com",enabled:true,matchers:[{type:"all"}],actions:[{type:"worker",value:[env.WORKER_NAME]}]}]);
  expect(await env.DB.prepare("SELECT status FROM receiving_domains WHERE name='example.com'").first("status")).toBe("verified");
});
it("asks for an explicit address only after detecting a subdomain",async()=>{
  const first=await addDomain({name:"new.example.com"});
  expect(first.status).toBe(200);
  const html=await first.text();
  expect(html).toContain("Cloudflare requires explicit receiving addresses for subdomains");
  expect(html).toContain('name="addresses"');
  expect(html).toContain("calendar@new.example.com");
  expect(await env.DB.prepare("SELECT name FROM receiving_domains WHERE name='new.example.com'").first()).toBeNull();
  expect((await addDomain({name:"new.example.com",addresses:"calendar@elsewhere.example"})).status).toBe(422);
  expect((await addDomain({name:"new.example.com",addresses:""})).status).toBe(422);
  expect((await addDomain({name:"new.example.com",addresses:"calendar@new.example.com"})).status).toBe(303);
  expect(await env.DB.prepare("SELECT addresses_json FROM receiving_domains WHERE name='new.example.com'").first("addresses_json")).toBe('["calendar@new.example.com"]');
  expect(catchAllWrites).toEqual([]);
});
it("starts domain setup with only a domain-name field",async()=>{
  const response=await adminApp.fetch(new Request("http://localhost/receiving-domains"),bindings);
  const html=await response.text();
  expect(html).toContain('name="name"');
  expect(html).not.toContain('name="addresses"');
});

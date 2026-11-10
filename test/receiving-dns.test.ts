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
let writes: {url: string;body: {deletes: {id: string}[];patches: Record[];posts: Record[]}}[];
const bindings = new Proxy(env, {get(target, property, receiver) {
  return property === "CLOUDFLARE_EMAIL_ROUTING_TOKEN" ? "test-routing-token" : Reflect.get(target, property, receiver);
}});

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("INSERT INTO receiving_domains(name,zone_id,status,addresses_json,created_at) VALUES(?,?,'pending','[]',?)")
    .bind(name, zone, new Date().toISOString()).run();
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
  writes = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if(url.hostname !== "api.cloudflare.com") throw Error("Unexpected network destination");
    if(request.method !== "GET") {
      expect(url.pathname).toBe(`/client/v4/zones/${zone}/dns_records/batch`);
      writes.push({url:request.url,body:await request.json() as any});
      return Response.json(failBatch ? {success:false,errors:[{message:"DNS Edit permission required"}]} : {success:true,result:{}}, {status:failBatch?403:200});
    }
    let result: unknown;
    if(url.pathname.endsWith("/email/routing/dns")) result=required;
    else if(url.pathname===`/client/v4/zones/${zone}`) result={name:"example.com"};
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
  expect(html).toContain("inbound-smtp.eu-west-1.amazonaws.com");
  expect(html).toContain("include:mailgun.org include:_spf.mx.cloudflare.net -all");
  expect(html).toContain('value="overlap"');
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
  expect(await env.DB.prepare("SELECT status FROM receiving_domains WHERE name=?").bind(name).first("status")).toBe("pending");
});
it("adds overlapping records without deleting the existing provider or other TXT records",async()=>{
  existing=existing.filter(r=>r.id!=="spf");
  const {snapshot}=await preview();
  expect((await migrate(snapshot,"overlap")).status).toBe(303);
  expect(writes[0]!.body.deletes).toEqual([]);
  expect(writes[0]!.body.patches).toEqual([]);
  expect(writes[0]!.body.posts).toContainEqual({type:"TXT",name,content:"v=spf1 include:_spf.mx.cloudflare.net ~all",ttl:1});
});
it("allows overlap preparation but blocks removing a working provider before routing is enabled",async()=>{
  routingEnabled=false;
  const {snapshot,html}=await preview();
  expect(html).toContain("Cloudflare Email Routing is not enabled yet");
  expect((await migrate(snapshot)).status).toBe(422);
  expect(writes).toEqual([]);
  expect((await migrate(snapshot,"overlap")).status).toBe(303);
  expect(writes[0]!.body.deletes).toEqual([]);
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
  expect((await migrate(snapshot,"overlap")).status).toBe(303);
  expect(writes).toEqual([]);
});

export type Ownership='managed'|'external';
export type ComponentState='healthy'|'pending'|'warning'|'error'|'unknown'|'online'|'offline';
export interface ComponentStatus{state:ComponentState;label:string;message?:string;checkedAt?:string}
export interface RouteStatus{routeStatus:ComponentStatus;backendStatus:ComponentStatus;dnsStatus:ComponentStatus;tlsStatus:ComponentStatus}
export interface Target{scheme:'http'|'https';host:string;port:number}
export type ReconciliationState='synced'|'desired-only'|'observed-only'|'drifted'|'conflict';export type Reconciliation=ReconciliationState;
export interface RuntimeServer{url:string;status?:string}
export interface RuntimeRoute{name:string;provider:string;rule:string;service:string;middlewares:string[];entryPoints?:string[];tls:boolean;servers?:RuntimeServer[];observedAt:string;stale:boolean;status?:string}
export interface ConflictInfo{router:string;provider:string;rule:string;service:string;backend?:string[]}
export interface Route{id:string;domain:string;target:Target;https:boolean;createDns:boolean;ownership:Ownership;status:RouteStatus;reconciliation?:Reconciliation;runtime?:RuntimeRoute;conflict?:ConflictInfo;latencyMs?:number;stale?:boolean;createdAt:string;updatedAt:string}
export interface RouteInput{domain:string;target:Target;https:boolean;createDns:boolean}
export interface DnsRecord{id:string;type:'A'|'AAAA'|'CNAME';name:string;value?:string;content?:string;ownership:Ownership;proxied:boolean;status?:ComponentStatus}
export interface DNSResponse{status:string;provider:string;zone?:string;tokenConfigured:boolean;records:DnsRecord[];message?:string}
export interface Certificate{id:string;domain:string;status:ComponentStatus;expiresInDays?:number;resolver:string;ownership:Ownership}
export type Health='healthy'|'degraded'|'offline'|'unknown';
export interface ServiceResponse{address:string;health:Health;routes:string[]}
export interface ObservedService{name:string;provider:string;servers:RuntimeServer[];status?:string}
export interface ServicesResponse{desired:ServiceResponse[];observed:ObservedService[];stale:boolean}
export interface TraefikStatus{status:string;version:string;checkedAt?:string;lastSuccessAt?:string;stale:boolean;message?:string}
export interface SystemStatusResponse{api:string;database:string;runtime:string;traefik?:TraefikStatus;dns?:string;certificates?:string;message?:string;checkedAt?:string}
export interface OperationStep{name:string;status:'success'|'failed'|'skipped'|string;message?:string}
export interface OperationResult{result:'success'|'partial_failure'|string;resource?:Route;resourceId?:string;steps:OperationStep[];message:string}
export interface SettingsResponse{traefik_api_url?:string;dns_provider?:string;dns_zone?:string;dns_public_target?:string;dns_proxied?:boolean;tls_resolver?:string;tokenConfigured:boolean}
export function deriveHealth(s:RouteStatus):Health{if(s.backendStatus.state==='error')return'offline';const states=Object.values(s).map(x=>x.state);if(states.every(x=>x==='healthy'))return'healthy';if(states.some(x=>x==='warning'||x==='pending'||x==='error'))return'degraded';return'unknown'}
export type RouteErrors=Partial<Record<'domain'|'target.host'|'target.port',string>>;
export function validateRoute(v:RouteInput):RouteErrors{const e:RouteErrors={};if(!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(v.domain))e.domain='Enter a valid fully qualified domain';if(!v.target.host.trim()||!/^[a-z0-9:.-]+$/i.test(v.target.host))e['target.host']='Enter a valid host or IP';if(!Number.isInteger(v.target.port)||v.target.port<1||v.target.port>65535)e['target.port']='Port must be between 1 and 65535';return e}
export function deriveServices(rs:Route[]):ServiceResponse[]{const rank:Record<Health,number>={healthy:0,unknown:1,degraded:2,offline:3};const m=new Map<string,ServiceResponse>();rs.filter(r=>r.ownership==='managed').forEach(r=>{const address=`${r.target.scheme}://${r.target.host}:${r.target.port}`,health=deriveHealth(r.status),old=m.get(address);if(old){old.routes.push(r.domain);if(rank[health]>rank[old.health])old.health=health}else m.set(address,{address,health,routes:[r.domain]})});return[...m.values()]}
export function copyToClipboard(text:string):Promise<void>{return navigator.clipboard.writeText(text)}
export function backendURL(route:Route):string{return `${route.target.scheme}://${route.target.host}:${route.target.port}`}
export function publicURL(route:Route):string{return `${route.https?'https':'http'}://${route.domain}`}
export function resolveBackend(route:Route):string|null{if(route.runtime&&route.runtime.servers&&route.runtime.servers.length>0)return route.runtime.servers.map(s=>s.url).join(', ');if(route.ownership==='managed'&&route.target)return backendURL(route);return null}

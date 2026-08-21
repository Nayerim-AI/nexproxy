import { useEffect, useState } from "react";
import {
  Activity,
  BookOpen,
  Globe,
  Server,
  Shield,
  Settings,
  Plus,
  Trash2,
  Pencil,
  ExternalLink,
  Copy,
  Check,
  ArrowDown,
} from "lucide-react";
import { certificates, dns, routes as seed, scenario } from "./mock";
import { dataSource } from "./data";
import { api, ApiError, onUnauthorized } from "./api";
import {
  deriveHealth,
  deriveServices,
  validateRoute,
  copyToClipboard,
  backendURL,
  publicURL,
  resolveBackend,
  type ComponentStatus,
  type DnsRecord,
  type Route,
  type RouteInput,
  type ServicesResponse,
  type SystemStatusResponse,
  type ConflictInfo,
} from "./model";
type Page =
  | "dashboard"
  | "routes"
  | "dns"
  | "services"
  | "certificates"
  | "activity"
  | "settings";
const pages: [Page, string, typeof Activity][] = [
  ["dashboard", "Dashboard", Activity],
  ["routes", "Proxy Routes", Globe],
  ["dns", "DNS Records", Server],
  ["services", "Services", Activity],
  ["certificates", "Certificates", Shield],
  ["activity", "Activity", BookOpen],
  ["settings", "Settings", Settings],
];
const Badge = ({
  status,
  children,
}: {
  status?: ComponentStatus | string;
  children?: React.ReactNode;
}) => {
  const state = typeof status === "string" ? status : status?.state;
  return (
    <span className={"badge " + state}>
      {children ?? (typeof status === "string" ? status : status?.label)}
    </span>
  );
};
const Panel = ({
  title,
  children,
  label,
}: {
  title?: string;
  children: React.ReactNode;
  label?: string;
}) => (
  <section className="panel" aria-label={label}>
    {title && <h2>{title}</h2>}
    {children}
  </section>
);
const Empty = ({ title, text }: { title: string; text: string }) => (
  <div className="state">
    <h2>{title}</h2>
    <p>{text}</p>
  </div>
);
const CopyButton = ({ text, label }: { text: string; label?: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try { await copyToClipboard(text); setCopied(true); setTimeout(()=>setCopied(false), 2000); } catch {}
  };
  return (
    <button onClick={handleCopy} aria-label={label||'Copy'} className="copy-btn" title={label||'Copy to clipboard'}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
};
export default function AuthenticatedApp(){
  const bypass=scenario()!=='normal';
  const [state,setState]=useState<'loading'|'setup'|'login'|'authenticated'>(bypass?'authenticated':'loading');
  const [message,setMessage]=useState('');
  useEffect(()=>{if(bypass)return;let active=true;api.authStatus().then(async s=>{if(!active)return;if(!s.initialized){setState('setup');return}try{await api.me();if(active)setState('authenticated')}catch{if(active)setState('login')}}).catch(()=>active&&setMessage('Unable to check authentication status.'));return()=>{active=false}},[bypass]);
  useEffect(()=>{onUnauthorized(()=>{setMessage('Your session expired. Please sign in again.');setState('login')});return()=>onUnauthorized()},[]);
  if(state==='loading')return <AuthShell><div aria-label="Loading authentication" className="skeleton" /></AuthShell>;
  if(state==='setup')return <Credentials setup onSuccess={()=>{setMessage('Administrator created. Sign in to continue.');setState('login')}} />;
  if(state==='login')return <Credentials message={message} onSuccess={()=>{setMessage('');setState('authenticated')}} />;
  return <App onLogout={async()=>{try{await api.logout()}finally{setMessage('You have been signed out.');setState('login')}}}/>;
}
function AuthShell({children}:{children:React.ReactNode}){return <div className="auth-shell"><section className="panel auth-panel"><div className="logo"><Globe/> NexProxy</div>{children}</section></div>}
function Credentials({setup=false,message='',onSuccess}:{setup?:boolean;message?:string;onSuccess:()=>void}){const[user,setUser]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);const submit=async(e:React.FormEvent)=>{e.preventDefault();if(password.length<12){setError('Password must be at least 12 characters.');return}if(setup&&password!==confirm){setError('Passwords do not match.');return}setBusy(true);setError('');try{await(setup?api.setup({username:user,password}):api.login({username:user,password}));onSuccess()}catch(e){setError(setup&&e instanceof ApiError&&e.status!==401?e.message:'Invalid username or password.')}finally{setBusy(false)}};return <AuthShell><form onSubmit={submit}><h1>{setup?'Create Administrator':'Sign in'}</h1>{message&&<p role="status">{message}</p>}<label>Username<input aria-label="Username" value={user} onChange={e=>setUser(e.target.value)} required autoComplete="username"/></label><label>Password<input aria-label="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)} required autoComplete={setup?'new-password':'current-password'}/></label>{setup&&<><small>Password must be at least 12 characters.</small><label>Confirm password<input aria-label="Confirm password" type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} required autoComplete="new-password"/></label></>}{error&&<p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{setup?'Create Administrator':'Sign in'}</button></form></AuthShell>}
function App({onLogout}:{onLogout:()=>void}) {
  const [page, setPage] = useState<Page>("dashboard"),
    [rs, setRs] = useState(seed),
    [dnsRecords, setDnsRecords] = useState<DnsRecord[]>(dns),
    [modal, setModal] = useState<Route | null | undefined>(),
    [detail, setDetail] = useState<Route>(),
    [deleting, setDeleting] = useState<Route>(),
    [certificateRecords,setCertificateRecords]=useState(certificates),
    [services,setServices]=useState<ServicesResponse>(()=>({desired:deriveServices(seed),observed:[],stale:false})),
    [system,setSystem]=useState<SystemStatusResponse>(()=>({api:'healthy',database:'healthy',runtime:'connected',message:'Local mock API responding'})),
    [loading,setLoading]=useState(scenario()==='normal'),
    [loadError,setLoadError]=useState(''),[sectionErrors,setSectionErrors]=useState<string[]>([]),[operationNotice,setOperationNotice]=useState<import('./model').OperationResult>(),[reload,setReload]=useState(0);
  const sc = scenario(),
    go = (p: Page) => {
      setPage(p);
      setDetail(undefined);
    };
  useEffect(()=>{if(sc!=='normal')return;let active=true;setLoading(true);setLoadError('');setSectionErrors([]);const d=dataSource();const names=['Routes','DNS','Certificates','Services','System'];Promise.allSettled([d.routes(),d.dns(),d.certificates(),d.services(),d.system()]).then(out=>{if(!active)return;const errors:string[]=[];out.forEach((x,i)=>{if(x.status==='rejected'){errors.push(`${names[i]}: ${x.reason instanceof Error?x.reason.message:'Unable to load'}`);return}const v=x.value;if(i===0)setRs(v as Route[]);if(i===1)setDnsRecords((v as {records?:DnsRecord[]}).records||[]);if(i===2)setCertificateRecords(v as typeof certificates);if(i===3)setServices(Array.isArray(v)?{desired:v as ServicesResponse['desired'],observed:[],stale:false}:v as ServicesResponse);if(i===4)setSystem(v as SystemStatusResponse)});setSectionErrors(errors);if(errors.length===names.length)setLoadError('Unable to load dashboard data')}).finally(()=>active&&setLoading(false));return()=>{active=false}},[sc,reload]);
  const source=dataSource();
  return (
    <div className="shell">
      <aside>
        <div className="logo">
          <Globe />
          NexProxy
        </div>
        <small>OPERATIONS</small>
        {pages.map(([id, label, I]) => (
          <button
            className={page === id ? "active" : ""}
            onClick={() => go(id)}
            key={id}
          >
            <I />
            {label}
          </button>
        ))}
        <footer>
          <span className={"dot " + (sc === "error" || system.runtime!=="connected" ? "bad" : "")} /> Traefik{" "}
          {sc === "error" ? "disconnected" : system.traefik?.stale ? "stale" : system.runtime}
          <br />
          <small>{sc==='normal'?'API runtime':'Mock runtime • no network'}</small>
        </footer>
      </aside>
      <main>
        <header>
          <div>
            <b>{detail?.domain || pages.find((x) => x[0] === page)?.[1]}</b>
            <small>Local Phase 0 operations console</small>
          </div>
          <button onClick={onLogout}>Log out</button>
          {import.meta.env.DEV && (
            <label>
              Scenario{" "}
              <select
                value={sc}
                onChange={(e) =>
                  (location.search = `?scenario=${e.target.value}`)
                }
              >
                <option>normal</option>
                <option>loading</option>
                <option>empty</option>
                <option>error</option>
                <option>partial</option>
                <option>failure</option>
              </select>
            </label>
          )}
        </header>
        <div className="content">
          {sectionErrors.map(e=><p className="error" role="alert" key={e}>{e}</p>)}
          {operationNotice&&<OperationResultView result={operationNotice}/>} 
          {loading || sc === "loading" ? (
            <Skeleton />
          ) : loadError || sc === "error" ? (
            <Panel>
              <Empty
                title="Traefik disconnected"
                text={loadError||"NexProxy could not read routes because the simulated Traefik connection is unavailable."}
              />
              <button onClick={() => sc==='normal'?setReload(x=>x+1):(location.search = "")}>Retry</button>
            </Panel>
          ) : detail ? (
            <Detail
              route={detail}
              recheck={async()=>{const out=await source.recheck(detail.id);if(out.resource){setDetail(out.resource);setRs(x=>x.map(r=>r.id===out.resource!.id?out.resource!:r))}return out}}
              edit={() => setModal(detail)}
              del={() => setDeleting(detail)}
            />
          ) : (
            <PageView
              page={page}
              rs={sc === "empty" ? [] : rs}
              dnsRecords={sc === "empty" ? [] : dnsRecords}
              certificateRecords={sc === "empty" ? [] : certificateRecords}
              services={sc === "empty" ? {desired:[],observed:[],stale:false} : services}
              system={system}
              partial={sc === "partial"}
              go={go}
              open={setDetail}
              add={() => setModal(null)}
              edit={setModal}
              del={setDeleting}
            />
          )}
        </div>
      </main>
      {modal !== undefined && (
        <RouteModal
          route={modal || undefined}
          close={() => setModal(undefined)}
          operation={(v)=>modal?source.update(modal.id,v):source.create(v)}
          save={(r) => {
            setRs((x) =>
              r.id ? [...x.filter((y) => y.id !== r.id), r] : [r, ...x],
            );
            setModal(undefined);
          }}
        />
      )}
      {deleting && (
        <Confirm
          route={deleting}
          close={() => setDeleting(undefined)}
          yes={async(removeDns) => {
            let out:import('./model').OperationResult;try{out=await source.remove(deleting.id,removeDns)}catch(e){setOperationNotice({result:'failed',steps:[],message:e instanceof Error?e.message:'Delete failed'});setDeleting(undefined);return}
            setOperationNotice(out);
            if(out.result!=='success'||(out.resourceId&&out.resourceId!==deleting.id)){setDeleting(undefined);setReload(x=>x+1);return}
            setRs((x) => x.filter((r) => r.id !== deleting.id));
            if (removeDns)
              setDnsRecords((x) =>
                x.filter(
                  (d) =>
                    !(d.ownership === "managed" && d.name === deleting.domain),
                ),
              );
            setDeleting(undefined);
          }}
        />
      )}
    </div>
  );
}
function Skeleton() {
  return (
    <div aria-label="Loading" className="skeletons">
      {[1, 2, 3, 4].map((x) => (
        <div className="skeleton" key={x} />
      ))}
    </div>
  );
}
function PageView({
  page,
  rs,
  dnsRecords,
  certificateRecords,
  services,
  system,
  partial,
  go,
  open,
  add,
  edit,
  del,
}: {
  page: Page;
  rs: Route[];
  dnsRecords: DnsRecord[];
  certificateRecords: typeof certificates;
  services: ServicesResponse;
  system: SystemStatusResponse;
  partial: boolean;
  go: (p: Page) => void;
  open: (r: Route) => void;
  add: () => void;
  edit: (r: Route) => void;
  del: (r: Route) => void;
}) {
  if (page === "dashboard") {
    const health = rs.map((r) => deriveHealth(r.status)),
      bad = rs.filter((r) => deriveHealth(r.status) !== "healthy");
    return (
      <>
        <div className="stats">
          {[
            ["Total Routes", rs.length],
            ["Healthy", health.filter((x) => x === "healthy").length],
            ["Degraded", health.filter((x) => x === "degraded").length],
            ["Offline", health.filter((x) => x === "offline").length],
            ["Unknown / Issues", health.filter((x) => x === "unknown").length],
          ].map(([x, n]) => (
            <Panel title={String(x)} key={x}>
              <strong>{n}</strong>
            </Panel>
          ))}
        </div>
        <Panel title="Traefik status">
          <Badge status={system.runtime==='connected'?'healthy':system.runtime}>{system.runtime}</Badge>
          {system.traefik?.stale && <Badge status="warning">Stale</Badge>}
          <span className="muted"> {system.traefik?.message || system.message || (system.runtime==='not_configured'?'Traefik not configured':system.runtime==='disconnected'?'Traefik disconnected':'Traefik runtime status')}</span>
        </Panel>
        {partial && (
          <div className="notice">
            Partial success: DNS created; route application failed.
          </div>
        )}
        <Panel title="Route Map — Domain → Destination" label="Route Map">
          {rs.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Destination</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rs.map((r) => {
                    const dest = r.ownership === 'managed'
                      ? `${r.target.scheme}://${r.target.host}:${r.target.port}`
                      : resolveBackend(r) || 'Runtime only';
                    return (
                      <tr key={r.id}>
                        <td>
                          <button className="route-name" aria-label={"View " + r.domain} onClick={() => open(r)}>
                            <b>{r.domain}</b>
                          </button>
                          {r.ownership === 'managed' && <Badge status="managed" />}
                          {r.ownership === 'external' && <Badge status="external" />}
                        </td>
                        <td><code>{dest}</code></td>
                        <td><Badge status={deriveHealth(r.status)} /></td>
                        <td>
                          <button onClick={() => open(r)} title="View details"><Pencil size={14} /></button>
                          <a href={publicURL(r)} target="_blank" rel="noopener noreferrer" title="Open in browser" style={{marginLeft:4}}><ExternalLink size={14} /></a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No routes configured yet.</p>
          )}
        </Panel>
        <Panel title="Needs Attention" label="Needs Attention">
          {bad.length ? (
            bad.map((r) => (
              <button className="route-link" onClick={() => open(r)} key={r.id}>
                {r.domain} <Badge status={deriveHealth(r.status)} />
              </button>
            ))
          ) : (
            <p>All routes healthy.</p>
          )}
        </Panel>
        <Panel title="Recent Routes">
          <RouteTable rs={rs.slice(0, 3)} open={open} edit={edit} del={del} />
          <button onClick={() => go("routes")}>View All Routes</button>
        </Panel>
      </>
    );
  }
  if (page === "routes")
    return <Routes rs={rs} open={open} add={add} edit={edit} del={del} />;
  if (page === "dns") return <DnsRecords records={dnsRecords} />;
  if (page === "services")
    return services.desired.length || services.observed.length ? (
      <div className="cards">
        {services.stale && <div className="notice">Observed services are stale.</div>}
        {services.desired.map((s) => (
          <Panel title={s.address} key={s.address}>
            <Badge status={s.health} />
            <p>{s.routes.join(", ")}</p>
          </Panel>
        ))}
        {services.observed.map((s) => <Panel title={s.name} key={`${s.provider}:${s.name}`}><Badge status={s.status||'unknown'} /> <Badge status="external">Observed • {s.provider}</Badge><p>{s.servers.map(x=>x.url).join(', ')||'No backend servers'}</p></Panel>)}
      </div>
    ) : (
      <Panel>
        <Empty title="No services" text="No backend services are available." />
      </Panel>
    );
  if (page === "certificates")
    return (
      <Panel title="Certificates">
        {!certificateRecords.length ? (
          <Empty
            title="No certificates"
            text="Observed certificates appear here."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Ownership</th>
                  <th>Status</th>
                  <th>Expiry</th>
                  <th>Resolver</th>
                </tr>
              </thead>
              <tbody>
                {certificateRecords.map((c) => (
                  <tr key={c.id}>
                    <td>{c.domain}</td>
                    <td>
                      <Badge status={c.ownership} />
                    </td>
                    <td>
                      <Badge status={c.status} />
                    </td>
                    <td>{c.expiresInDays ? `${c.expiresInDays} days` : "—"}</td>
                    <td>{c.resolver}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    );
  if (page === "activity")
    return scenario()==='normal' ? <ActivityView /> : (
      <Panel title="Activity"><div className="timeline">{[
            "Route created by admin@example.com",
            "DNS record updated by operator@example.com",
            "Route deleted by admin@example.com",
            "Certificate observed by system",
          ].map((x) => (
            <p key={x}>
              {x}
              <small> 19 Aug 2026 • local mock event</small>
            </p>
          ))}
        </div>
      </Panel>
    );
  return <SettingsView />;
}
function ActivityView(){const [items,setItems]=useState<Array<{id:string;message:string;createdAt:string}>>([]);const [error,setError]=useState('');useEffect(()=>{dataSource().activity().then(x=>setItems(x as typeof items)).catch(e=>setError(e instanceof Error?e.message:'Activity load failed'))},[]);return <Panel title="Activity">{error&&<p className="error" role="alert">{error}</p>}<div className="timeline">{items.map(x=><p key={x.id}>{x.message}<small> {new Date(x.createdAt).toLocaleString()}</small></p>)}</div></Panel>}
function SettingsView() {
  const [result, setResult] = useState(""),[values,setValues]=useState<import('./model').SettingsResponse>({tokenConfigured:false}),[error,setError]=useState('');
  useEffect(()=>{if(scenario()==='normal')dataSource().settings().then(setValues).catch(e=>setError(e instanceof Error?e.message:'Settings load failed'))},[]);
  if(scenario()==='normal'){const set=(key:keyof import('./model').SettingsResponse,value:string|boolean)=>setValues(v=>({...v,[key]:value}));const payload={traefik_api_url:values.traefik_api_url||'',dns_provider:values.dns_provider||'',dns_zone:values.dns_zone||'',dns_public_target:values.dns_public_target||'',dns_proxied:!!values.dns_proxied,tls_resolver:values.tls_resolver||''};return <Panel title="Settings"><label>Traefik API URL<input type="url" aria-label="Traefik API URL" placeholder="http://traefik:8080" value={values.traefik_api_url||''} onChange={e=>set('traefik_api_url',e.target.value)}/></label><label>DNS Provider<select aria-label="DNS Provider" value={values.dns_provider||''} onChange={e=>set('dns_provider',e.target.value)}><option value="">Disabled</option><option value="cloudflare">Cloudflare</option></select></label><label>DNS Zone<input aria-label="DNS Zone" value={values.dns_zone||''} onChange={e=>set('dns_zone',e.target.value)}/></label><label>Public DNS Target<input aria-label="Public DNS Target" value={values.dns_public_target||''} onChange={e=>set('dns_public_target',e.target.value)}/></label><label><input type="checkbox" checked={!!values.dns_proxied} onChange={e=>set('dns_proxied',e.target.checked)}/> Proxied by default</label><label>TLS Resolver<input aria-label="TLS Resolver" value={values.tls_resolver||''} onChange={e=>set('tls_resolver',e.target.value)}/></label><p>Cloudflare token: <b>{values.tokenConfigured?'Configured':'Not configured'}</b>. Supply it through the NexProxy secret file; tokens are never stored in settings.</p><button onClick={()=>{setError('');setResult('');dataSource().saveSettings(payload).then(()=>setResult('Settings saved')).catch(e=>setError(e instanceof Error?e.message:'Settings save failed'))}}>Save settings</button><button onClick={()=>{setError('');setResult('Testing connection…');dataSource().testTraefik().then(x=>setResult(x.status==='connected'?`Connected${x.version?` to Traefik ${x.version}`:''}`:`Connection failed: ${x.message||x.status}`)).catch(e=>{setResult('');setError(`Connection failed: ${e instanceof Error?e.message:'Traefik test failed'}`)})}}>Test Connection</button>{result&&<p role="status">{result}</p>}{error&&<p role="alert" className="error">{error}</p>}</Panel>;}
  return (
    <div className="cards">
      {["Traefik", "DNS Provider", "Defaults", "Application"].map((x) => (
        <Panel title={x} key={x}>
          <p className="muted">Local demonstration settings.</p>
          {(x === "Traefik" || x === "DNS Provider") && (
            <button onClick={() => setResult(`${x} mock test passed`)}>
              Run local mock test
            </button>
          )}
        </Panel>
      ))}
      {result && <p role="status">{result}. No network request was made.</p>}
    </div>
  );
}
function DnsRecords({records}:{records:DnsRecord[]}) {
  const [query,setQuery]=useState(''),[type,setType]=useState<'all'|DnsRecord['type']>('all');
  const visible=records.filter(record=>
    (type==='all'||record.type===type) && `${record.name} ${record.value||record.content||''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return <Panel title="DNS Records">
    <p className="muted">DNS records managed by this proxy. External records remain read-only.</p>
    {!records.length ? <Empty title="No DNS records" text="Proxy-related records appear here."/> : <>
      <div className="dns-toolbar">
        <label>Search DNS records<input type="search" aria-label="Search DNS records" placeholder="Name or value" value={query} onChange={e=>setQuery(e.target.value)}/></label>
        <label>Record type<select aria-label="Record type" value={type} onChange={e=>setType(e.target.value as typeof type)}><option value="all">All types</option><option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option></select></label>
        <small>{visible.length} of {records.length} records</small>
      </div>
      {!visible.length ? <Empty title="No matching DNS records" text="Change the search term or record type filter."/> : <div className="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Ownership</th><th>Status</th><th>Proxied</th><th>Actions</th></tr></thead><tbody>{visible.map(d=>{const value=d.value||d.content||'';return <tr key={d.id}><td>{d.type}</td><td>{d.name}</td><td><code>{value}</code><CopyButton text={value} label={`Copy DNS value for ${d.name}`}/></td><td><Badge status={d.ownership}/></td><td><Badge status={d.status||'unknown'}/></td><td>{d.proxied?'Yes':'No'}</td><td>{d.ownership==='external'?<span className="muted">Unavailable <small>External Read Only</small></span>:<span className="muted">Managed</span>}</td></tr>})}</tbody></table></div>}
    </>}
  </Panel>;
}
function Routes(p: {
  rs: Route[];
  open: (r: Route) => void;
  add: () => void;
  edit: (r: Route) => void;
  del: (r: Route) => void;
}) {
  const [q, setQ] = useState(""),
    [filter, setFilter] = useState("All");
  const shown = p.rs.filter(
    (r) =>
      r.domain.toLowerCase().includes(q.toLowerCase()) &&
      (filter === "All" ||
        (filter === "Issues"
          ? deriveHealth(r.status) !== "healthy"
          : r.ownership === filter.toLowerCase())),
  );
  return (
    <Panel title="Proxy Routes">
      <div className="actions">
        <input
          type="search"
          aria-label="Search routes"
          placeholder="Search domain"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="primary" onClick={p.add}>
          <Plus />
          Add route
        </button>
      </div>
      <div className="filters">
        {["All", "Managed", "External", "Issues"].map((x) => (
          <button
            className={filter === x ? "active" : ""}
            onClick={() => setFilter(x)}
            key={x}
          >
            {x}
          </button>
        ))}
      </div>
      {shown.length ? (
        <RouteTable rs={shown} open={p.open} edit={p.edit} del={p.del} />
      ) : (
        <Empty
          title="No matching routes"
          text="Adjust search or create a managed route."
        />
      )}
    </Panel>
  );
}
function RouteTable({
  rs,
  open,
  edit,
  del,
}: {
  rs: Route[];
  open: (r: Route) => void;
  edit: (r: Route) => void;
  del: (r: Route) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {[
              "Domain",
              "Destination",
              "Ownership",
              "Reconciliation",
              "Health / Route",
              "Backend",
              "DNS",
              "TLS",
              "Actions",
            ].map((x) => (
              <th key={x}>{x}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rs.map((r) => {
            const dest = r.ownership === 'managed'
              ? `${r.target.scheme}://${r.target.host}:${r.target.port}`
              : resolveBackend(r) || 'Runtime only';
            return (
              <tr key={r.id}>
                <td>
                  <button
                    className="route-name"
                    aria-label={"View " + r.domain}
                    onClick={() => open(r)}
                  >
                    <b>{r.domain}</b>
                  </button>
                  {r.runtime?.stale && <Badge status="warning">Stale</Badge>}
                </td>
                <td><code>{dest}</code></td>
                <td>
                  <Badge status={r.ownership} />
                  {r.ownership==='external' && <><Badge status="external">External</Badge><Badge status="unknown">Read Only</Badge><small>{r.runtime?.provider}</small></>}
                </td>
                <td><Badge status={r.reconciliation||'neutral'}>{r.reconciliation||'Not reconciled'}</Badge></td>
                {Object.values(r.status).map((s, i) => (
                  <td key={i}>
                    <Badge status={s} />
                  </td>
                ))}
                <td>
                  {r.ownership === "managed" ? (
                    <>
                      <button
                        aria-label={"Edit " + r.domain}
                        onClick={(e) => {
                          e.stopPropagation();
                          edit(r);
                        }}
                      >
                        <Pencil />
                      </button>
                      <button
                        aria-label={"Delete " + r.domain}
                        onClick={(e) => {
                          e.stopPropagation();
                          del(r);
                        }}
                      >
                        <Trash2 />
                      </button>
                    </>
                  ) : (
                    <button onClick={() => open(r)}>View</button>
                  )}
                  <a href={publicURL(r)} target="_blank" rel="noopener noreferrer" title="Open in browser" style={{marginLeft:4}}><ExternalLink size={14}/></a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function OperationResultView({result}:{result:import('./model').OperationResult}){return <div className={`progress ${result.result}`} aria-live="polite"><b>{result.result}</b>{result.steps.map((s,i)=><span key={`${s.name}-${i}`}>{s.name} <Badge status={s.status}>{s.status}</Badge>{s.message&&<> — {s.message}</>}</span>)}<p>{result.message}</p></div>}
function Detail({
  route,
  recheck,
  edit,
  del,
}: {
  route: Route;
  recheck: () => Promise<import('./model').OperationResult>;
  edit: () => void;
  del: () => void;
}) {
  const health = deriveHealth(route.status),[checking,setChecking]=useState(false),[checkResult,setCheckResult]=useState<import('./model').OperationResult>(),[checkError,setCheckError]=useState('');
  const backend = resolveBackend(route);
  const pubUrl = publicURL(route);
  const backUrl = route.ownership === 'managed' ? backendURL(route) : backend;
  const hasTarget = route.ownership === 'managed' && Boolean(route.target?.scheme && route.target.host && route.target.port > 0);

  return (
    <>
      <div className="actions">
        <h1 style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
          <span style={{fontSize:20}}>{route.domain}</span>
          <CopyButton text={route.domain} label="Copy domain" />
          <Badge status={route.ownership} />
          <Badge status={route.reconciliation||'unknown'}>{route.reconciliation||'Unknown'}</Badge>
          <Badge status={health} />
        </h1>
        {route.ownership === "managed" && (
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <button disabled={checking} onClick={async()=>{setChecking(true);setCheckError('');setCheckResult(undefined);try{setCheckResult(await recheck())}catch(e){setCheckError(e instanceof Error?e.message:'Recheck failed')}finally{setChecking(false)}}}>{checking?'Rechecking…':'Recheck'}</button>
            <button onClick={edit}><Pencil size={14}/> Edit</button>
            <button className="danger" onClick={del}><Trash2 size={14}/> Delete</button>
            <a href={pubUrl} target="_blank" rel="noopener noreferrer" className="primary"><ExternalLink size={14}/> Open</a>
          </div>
        )}
        {route.ownership === "external" && (
          <div style={{display:'flex',gap:8}}>
            <a href={pubUrl} target="_blank" rel="noopener noreferrer" className="primary"><ExternalLink size={14}/> Open</a>
          </div>
        )}
      </div>
      {checkResult&&<OperationResultView result={checkResult}/>} {checkError&&<p className="error" role="alert">{checkError}</p>}

      {/* Conflict explanation */}
      {route.reconciliation==='conflict' && (
        <Panel title="Conflict Explanation">
          <div className="notice" style={{marginBottom:12}}>
            This domain overlaps with an existing Traefik route. NexProxy did not modify it.
          </div>
          {route.conflict && <div>
            <p><b>Existing Router:</b> <code>{route.conflict.router}</code> <CopyButton text={route.conflict.router} label="Copy router" /></p>
            <p><b>Provider:</b> <code>{route.conflict.provider}</code></p>
            <p><b>Rule:</b> <code>{route.conflict.rule}</code></p>
            <p><b>Service:</b> <code>{route.conflict.service}</code> <CopyButton text={route.conflict.service} label="Copy service" /></p>
            {route.conflict.backend && route.conflict.backend.length > 0 && (
              <p><b>Backend:</b> {route.conflict.backend.map(b=>`<code>${b}</code>`).join(', ')} <CopyButton text={route.conflict.backend.join(', ')} label="Copy backend" /></p>
            )}
          </div>}
        </Panel>
      )}

      {/* Connection Flow Diagram */}
      <Panel title="Proxy Connection">
        <div className="connection-flow">
          {/* Domain node */}
          <div className="flow-node primary">
            <div className="flow-label">{route.domain}</div>
            <div className="flow-sub">{route.ownership === 'managed' ? 'Managed Route' : 'External Route'}</div>
            <CopyButton text={route.domain} label="Copy domain" />
          </div>

          <div className="flow-arrow">
            <span>↓</span>
            <small>{route.https ? 'HTTPS' : 'HTTP'}</small>
          </div>

          {/* Traefik node */}
          <div className="flow-node secondary">
            <div className="flow-label">Traefik</div>
            {route.runtime ? (
              <div className="flow-details">
                <div>Router: <code>{route.runtime.name}</code> <CopyButton text={route.runtime.name} label="Copy router" /></div>
                {route.runtime.entryPoints && <div>Entrypoint: <code>{route.runtime.entryPoints.join(', ')}</code></div>}
                {route.runtime.tls && <div>TLS: <Badge status="healthy">Enabled</Badge></div>}
                <div>Provider: <code>{route.runtime.provider}</code></div>
              </div>
            ) : (
              <div className="muted">No runtime data available</div>
            )}
          </div>

          <div className="flow-arrow">
            <span>↓</span>
            <small>HTTP</small>
          </div>

          {/* Backend node */}
          <div className="flow-node tertiary">
            <div className="flow-label">
              {backend ? <code>{backend}</code> : <span className="muted">Backend unresolved</span>}
              {backend && <CopyButton text={backend} label="Copy backend URL" />}
            </div>
            {route.runtime?.servers && route.runtime.servers.length > 0 && (
              <div className="flow-details">
                {route.runtime.servers.map((s, i) => (
                  <div key={i}>
                    {s.url} {s.status && <Badge status={s.status === 'enabled' ? 'healthy' : 'unknown'}>{s.status}</Badge>}
                  </div>
                ))}
              </div>
            )}
            {route.ownership === 'managed' && route.status.backendStatus && (
              <div className="flow-details">
                <Badge status={route.status.backendStatus} />
                {route.status.backendStatus.state === 'online' && route.latencyMs != null && (
                  <span>{route.latencyMs} ms</span>
                )}
              </div>
            )}
          </div>
        </div>
      </Panel>

      {/* Service name display */}
      {route.runtime && route.runtime.service && (
        <Panel title="Service">
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <code>{route.runtime.service}</code>
            <CopyButton text={route.runtime.service} label="Copy service" />
          </div>
        </Panel>
      )}

      {/* Status cards for managed routes */}
      {route.ownership==='managed' && <div className="stats status-cards">
        {Object.entries(route.status).map(([k, s]) => (
          <Panel title={k.replace("Status", "")} key={k}>
            <Badge status={s} />
            <p>{s.message}</p>
            <small>
              {route.latencyMs ? `${route.latencyMs} ms • ` : ""}
              {route.runtime?.stale ? "Stale • " : ""}checked {s.checkedAt || "never"}
            </small>
          </Panel>
        ))}
      </div>}

      {/* Full connection information table */}
      <Panel title="Connection Information">
        <dl className="info-table" role="group" aria-label="Connection Information">
          <InfoRow label="Domain" value={route.domain} copyable />
          <InfoRow label="Public URL" value={pubUrl} copyable />
          <InfoRow label="Backend URL" value={backUrl || 'Not available'} copyable={!!backUrl} />
          <InfoRow label="Router" value={route.runtime?.name || 'Not available'} copyable={!!route.runtime?.name} />
          <InfoRow label="Provider" value={route.runtime?.provider || 'Not available'} />
          <InfoRow label="Service" value={route.runtime?.service || 'Not available'} copyable={!!route.runtime?.service} />
          <InfoRow label="Target Protocol" value={hasTarget ? route.target.scheme.toUpperCase() : 'Not available'} />
          <InfoRow label="Target Host" value={hasTarget ? route.target.host : 'Not available'} />
          <InfoRow label="Target Port" value={hasTarget ? String(route.target.port) : 'Not available'} />
          <InfoRow label="Entrypoint" value={route.runtime?.entryPoints?.join(', ') || 'Not available'} />
          <InfoRow label="TLS" value={route.https ? 'Enabled' : 'Disabled'} />
          <InfoRow label="Ownership" value={route.ownership} />
          <InfoRow label="Reconciliation" value={route.reconciliation || 'Not reconciled'} />
          <InfoRow label="Last Checked" value={route.runtime?.observedAt || 'Never'} />
        </dl>
      </Panel>

      {/* Managed route details */}
      {route.ownership==='managed' && <Panel title="Route Configuration">
        <p>
          Target{" "}
          <code>
            {route.target.scheme}://{route.target.host}:{route.target.port}
          </code>{" "}
          <CopyButton text={backUrl!} label="Copy backend URL" />
        </p>
        <details>
          <summary>Config Preview</summary>
          <pre>{`routers:
  nexproxy-${route.id}:
    rule: Host(\`${route.domain}\`)
    entryPoints:
      - ${route.https ? 'websecure' : 'web'}
    service: nexproxy-${route.id}-service
services:
  nexproxy-${route.id}-service:
    loadBalancer:
      servers:
        - url: ${route.target.scheme}://${route.target.host}:${route.target.port}`}</pre>
        </details>
      </Panel>}

      {/* External route details */}
      {route.ownership==='external' && route.runtime && (
        <Panel title="Observed Traefik Route">
          <p>Router <code>{route.runtime.name}</code> <CopyButton text={route.runtime.name} label="Copy router" /></p>
          <p>Provider <b>{route.runtime.provider}</b></p>
          <p>Rule <code>{route.runtime.rule}</code></p>
          <p>Service <code>{route.runtime.service}</code> <CopyButton text={route.runtime.service} label="Copy service" /></p>
          <p>Entrypoints: {route.runtime.entryPoints?.join(', ') || '—'}</p>
          <p>TLS: {route.runtime.tls ? 'Yes' : 'No'}</p>
          {route.runtime.servers && route.runtime.servers.length > 0 && (
            <p>Backend servers: {route.runtime.servers.map(s=>`${s.url}${s.status?` (${s.status})`:''}`).join(', ')}</p>
          )}
          <p>Observed at: {route.runtime.observedAt}</p>
          <p>Stale: {route.runtime.stale ? 'Yes' : 'No'}</p>
          <p>Middlewares: {route.runtime.middlewares?.join(', ') || 'None'}</p>
        </Panel>
      )}
    </>
  );
}

const InfoRow = ({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) => (
  <div className="info-row" data-testid="connection-field">
    <dt>{label}</dt>
    <dd>
      <code>{value}</code>
      {copyable && <CopyButton text={value} label={`Copy ${label}`} />}
    </dd>
  </div>
);
type Op =
  | "idle"
  | "validating"
  | "submitting"
  | "success"
  | "partial_success"
  | "error";
function OperationProgress({ op, result }: { op: Op;result?:import('./model').OperationResult }) {
  if(result)return <OperationResultView result={result}/>;
  return (
    <div className={"progress " + op} aria-live="polite">
      <b>{op.replace("_", " ")}</b>
      {[
        "Validate fields",
        "Create DNS record",
        "Apply Traefik route",
        "Verify TLS",
      ].map((x, i) => (
        <span key={x}>
          {x}{" "}
          {op === "success"
            ? "✓"
            : op === "partial_success"
              ? i < 2
                ? "✓"
                : i === 2
                  ? "✕"
                  : "—"
              : "…"}
        </span>
      ))}
    </div>
  );
}
function RouteModal({
  route,
  close,
  save,
  operation,
}: {
  route?: Route;
  close: () => void;
  save: (r: Route) => void;
  operation:(v:RouteInput)=>Promise<import('./model').OperationResult>;
}) {
  const [v, setV] = useState<RouteInput>(
      route
        ? {
            domain: route.domain,
            target: route.target,
            https: route.https,
            createDns: route.createDns,
          }
        : {
            domain: "",
            target: { scheme: "http", host: "", port: 8080 },
            https: true,
            createDns: true,
          },
    ),
    [touched, setTouched] = useState(false),
    [op, setOp] = useState<Op>("idle"),[operationResult,setOperationResult]=useState<import('./model').OperationResult>();
  const errors = validateRoute(v),
    valid = !Object.keys(errors).length;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [close]);
  const fields = [
    {
      key: "domain",
      label: "Domain",
      value: v.domain,
      set: (x: string) => setV({ ...v, domain: x }),
      error: errors.domain,
    },
    {
      key: "host",
      label: "Backend host",
      value: v.target.host,
      set: (x: string) => setV({ ...v, target: { ...v.target, host: x } }),
      error: errors["target.host"],
    },
    {
      key: "port",
      label: "Backend port",
      value: v.target.port,
      set: (x: string) =>
        setV({ ...v, target: { ...v.target, port: Number(x) } }),
      error: errors["target.port"],
    },
  ];
  const submit = async() => {
    setTouched(true);
    setOp("validating");
    if (!valid) {
      setOp("idle");
      return;
    }
    setOp("submitting");
    if(scenario()==='normal'){try{const out=await operation(v);setOperationResult(out);setApiMessage(out.message);if(out.resource)setApiResult(out.resource);setOp(out.result==='success'&&!!out.resource?'success':out.resource?'partial_success':'error')}catch(e){setApiMessage(e instanceof Error?e.message:'Route operation failed');setOp('error')}return}
    setTimeout(
      () =>
        setOp(
          scenario() === "partial"
            ? "partial_success"
            : scenario() === "failure"
              ? "error"
              : "success",
        ),
      200,
    );
  };
  const partialStatus = {
    routeStatus: {
      state: "error",
      label: "Apply failed",
      message: "Traefik route was not applied",
    },
    backendStatus: {
      state: "unknown",
      label: "Unknown",
      message: "Not checked",
    },
    dnsStatus: {
      state: "healthy",
      label: "Resolved",
      message: "DNS record created",
    },
    tlsStatus: {
      state: "pending",
      label: "Pending",
      message: "Waiting for route",
    },
  } as const;
  const [apiResult,setApiResult]=useState<Route>();const[apiMessage,setApiMessage]=useState('');const result = apiResult||{
    ...route,
    ...v,
    id: route?.id || `r${Date.now()}`,
    ownership: "managed" as const,
    status:
      route?.status ||
      (scenario() === "partial" ? partialStatus : seed[0].status),
    createdAt: route?.createdAt || new Date().toISOString(),
    updatedAt: route?.updatedAt || new Date().toISOString(),
  };
  return (
    <div className="overlay">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={route ? "Edit route" : "Add route"}
      >
        <h2>{route ? "Edit" : "Create"} Proxy Route</h2>
        {!route && <section className="presets" aria-label="Route presets">
          <p className="muted">Start with a preset, then review the route before saving.</p>
          <div className="actions">
            <button type="button" onClick={()=>setV({...v,target:{scheme:'http',host:v.target.host,port:8080},https:true,createDns:true})}>Web app (HTTP)</button>
            <button type="button" onClick={()=>setV({...v,target:{scheme:'https',host:v.target.host,port:443},https:true,createDns:true})}>Secure backend (HTTPS)</button>
            <button type="button" onClick={()=>setV({...v,target:{scheme:'http',host:v.target.host,port:80},https:false,createDns:false})}>Internal service</button>
          </div>
        </section>}
        {fields.map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              aria-label={f.label}
              value={f.value}
              onChange={(e) => {
                setTouched(true);
                f.set(e.target.value);
              }}
            />
            {touched && f.error && <em>{f.error}</em>}
          </label>
        ))}
        <label>
          Scheme
          <select
            value={v.target.scheme}
            onChange={(e) =>
              setV({
                ...v,
                target: {
                  ...v.target,
                  scheme: e.target.value as "http" | "https",
                },
              })
            }
          >
            <option>http</option>
            <option>https</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={v.https}
            onChange={(e) => setV({ ...v, https: e.target.checked })}
          />{" "}
          Enable HTTPS
        </label>
        <label>
          <input
            type="checkbox"
            checked={v.createDns}
            onChange={(e) => setV({ ...v, createDns: e.target.checked })}
          />{" "}
          Create DNS record
        </label>
        <section className="route-preview" aria-label="Route preview">
          <h3>Route preview</h3>
          <dl>
            <div><dt>Public address</dt><dd><code>{v.domain ? `${v.https?'https':'http'}://${v.domain}` : 'Enter a domain'}</code></dd></div>
            <div><dt>Backend</dt><dd><code>{v.target.host ? `${v.target.scheme}://${v.target.host}:${v.target.port}` : 'Enter a backend host'}</code></dd></div>
            <div><dt>DNS</dt><dd>{v.createDns ? 'DNS record will be created' : 'DNS will not be changed'}</dd></div>
            <div><dt>TLS</dt><dd>{v.https ? 'HTTPS and TLS will be enabled' : 'HTTP only; TLS will not be configured'}</dd></div>
          </dl>
        </section>
        {op !== "idle" && <OperationProgress op={op} result={operationResult} />}{" "}
        {op === "error" && (
          <p className="error">
            {apiMessage||'Route application failed. Mock rollback completed; no local changes kept.'}
          </p>
        )}
        <div className="actions">
          <button onClick={close}>Cancel</button>
          {op === "success" ? (
            <button className="primary" onClick={() => scenario()==='normal' ? apiResult&&save(apiResult) : save(result)}>
              Done
            </button>
          ) : op === "partial_success" ? (
            <button className="primary" onClick={() => scenario()==='normal' ? apiResult&&save(apiResult) : save(result)}>
              View Proxy
            </button>
          ) : (
            <button
              className="primary"
              disabled={!valid || op === "submitting" || op === "validating"}
              onClick={submit}
            >
              Save route
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
function Confirm({
  route,
  close,
  yes,
}: {
  route: Route;
  close: () => void;
  yes: (removeDns: boolean) => void;
}) {
  const [removeDns, setRemoveDns] = useState(route.createDns);
  return (
    <div className="overlay">
      <div className="modal" role="alertdialog">
        <h2>Delete managed route?</h2>
        <p>
          Remove <b>{route.domain}</b> from local mock configuration.
        </p>
        <label>
          <input
            type="checkbox"
            checked={removeDns}
            onChange={(e) => setRemoveDns(e.target.checked)}
          />{" "}
          Remove managed DNS record
        </label>
        <div className="actions">
          <button onClick={close}>Cancel</button>
          <button className="danger" onClick={() => yes(removeDns)}>
            Delete route
          </button>
        </div>
      </div>
    </div>
  );
}

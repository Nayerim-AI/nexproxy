import {cleanup, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import App from './App';

const response=(value:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}}));

describe('Traefik settings',()=>{
  beforeEach(()=>{history.replaceState({},'',location.pathname);});
  afterEach(()=>{cleanup();vi.unstubAllGlobals()});
  it('loads and saves only the Traefik API URL',async()=>{
    const fetch=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
      const path=String(input);
      if(path==='/api/auth/status')return response({initialized:true});
      if(path==='/api/auth/me')return response({username:'admin'});
      if(path==='/api/routes'||path==='/api/dns'||path==='/api/certificates')return response([]);
      if(path==='/api/services')return response({desired:[],observed:[],stale:false});
      if(path==='/api/system/status')return response({api:'healthy',database:'healthy',runtime:'not_configured'});
      if(path==='/api/settings'&&!init?.method)return response({traefik_api_url:'http://traefik:8080'});
      if(path==='/api/settings'&&init?.method==='PATCH')return response({});
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch',fetch);
    render(<App/>);
    await userEvent.click(await screen.findByRole('button',{name:'Settings'}));
    const input=await screen.findByLabelText('Traefik API URL');
    expect(input).toHaveValue('http://traefik:8080');
    await userEvent.clear(input); await userEvent.type(input,'https://proxy.example/api');
    await userEvent.click(screen.getByRole('button',{name:'Save settings'}));
    await screen.findByText('Settings saved');
    expect(fetch).toHaveBeenCalledWith('/api/settings',expect.objectContaining({method:'PATCH',body:JSON.stringify({traefik_api_url:'https://proxy.example/api',dns_provider:'',dns_zone:'',dns_public_target:'',dns_proxied:false,tls_resolver:''})}));
  });
  it('tests through NexProxy and reports connected feedback',async()=>{
    vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
      const path=String(input);
      if(path==='/api/auth/status')return response({initialized:true});
      if(path==='/api/auth/me')return response({username:'admin'});
      if(path==='/api/routes'||path==='/api/dns'||path==='/api/certificates')return response([]);
      if(path==='/api/services')return response({desired:[],observed:[],stale:false});
      if(path==='/api/system/status')return response({api:'healthy',database:'healthy',runtime:'connected'});
      if(path==='/api/settings')return response({traefik_api_url:''});
      if(path==='/api/traefik/test'&&init?.method==='POST')return response({status:'connected',version:'3.2',stale:false});
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(<App/>); await userEvent.click(await screen.findByRole('button',{name:'Settings'}));
    await screen.findByLabelText('Traefik API URL'); await userEvent.click(screen.getByRole('button',{name:'Test Connection'}));
    expect(await screen.findByText('Connected to Traefik 3.2')).toBeInTheDocument();
  });
});

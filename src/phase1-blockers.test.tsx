import {cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import App from './App';

const json=(value:unknown)=>Promise.resolve(new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}}));

describe('Phase 1 API truthfulness',()=>{
  beforeEach(()=>{
    history.replaceState({},'',location.pathname);
    vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
      const path=String(input);
      if(path==='/api/auth/status')return json({initialized:true});
      if(path==='/api/auth/me')return json({username:'admin'});
      if(path==='/api/routes')return json([]);
      if(path==='/api/dns'||path==='/api/certificates')return json([]);
      if(path==='/api/services')return json([{address:'https://backend-only.example:9443',health:'offline',routes:['backend-owned.example']}]);
      if(path==='/api/system/status')return json({api:'healthy',database:'healthy',runtime:'unknown',message:'Traefik integration is not enabled'});
      throw new Error(`Unexpected request: ${path}`);
    }));
  });
  afterEach(()=>{cleanup();vi.unstubAllGlobals()});

  it('renders normal-mode Traefik unknown state and backend message, never Connected',async()=>{
    render(<App/>);
    expect(await screen.findByText('unknown')).toBeInTheDocument();
    expect(screen.getByText(/Traefik integration is not enabled/)).toBeInTheDocument();
    expect(screen.queryByText(/Connected/i)).not.toBeInTheDocument();
  });

  it('renders backend services even when routes differ',async()=>{
    render(<App/>);
    await screen.findByText('unknown');
    await userEvent.click(screen.getByRole('button',{name:'Services'}));
    expect(screen.getByRole('heading',{name:'https://backend-only.example:9443'})).toBeInTheDocument();
    expect(screen.getByText('backend-owned.example')).toBeInTheDocument();
  });
});

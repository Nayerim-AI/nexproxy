import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { mockScenariosAllowed } from './mock';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const dashboardBodies: Record<string, unknown> = {
  '/api/routes': [], '/api/dns': [], '/api/certificates': [],
  '/api/services': { desired: [], observed: [], stale: false },
  '/api/system/status': { api: 'healthy', database: 'healthy', runtime: 'connected' },
};
function mockFetch(options: { initialized?: boolean; authenticated?: boolean; loginStatus?: number } = {}) {
  const { initialized = true, authenticated = false, loginStatus = 200 } = options;
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/auth/status') return json({ initialized });
    if (path === '/api/auth/me') return authenticated ? json({ username: 'admin' }) : json({ error: { message: 'unauthorized' } }, 401);
    if (path === '/api/auth/setup') return json({ username: 'admin' });
    if (path === '/api/auth/login') return loginStatus === 200 ? json({ username: 'admin' }) : json({ error: { message: 'sensitive detail' } }, loginStatus);
    if (path === '/api/auth/logout') return json({ ok: true });
    if (path in dashboardBodies) return json(dashboardBodies[path]);
    return json({ error: { message: `unexpected ${init?.method || 'GET'} ${path}` } }, 500);
  });
}

beforeEach(() => { history.replaceState({}, '', location.pathname); vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Phase 2.5 frontend authentication', () => {
  it('shows auth loading and no dashboard while status is unresolved', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<App />);
    expect(screen.getByLabelText('Loading authentication')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('shows administrator setup when auth is not initialized', async () => {
    vi.stubGlobal('fetch', mockFetch({ initialized: false })); render(<App />);
    expect(await screen.findByRole('heading', { name: 'Create Administrator' })).toBeInTheDocument();
  });

  it('validates setup minimum length and password confirmation', async () => {
    const fetchMock = mockFetch({ initialized: false }); vi.stubGlobal('fetch', fetchMock); render(<App />);
    await userEvent.type(await screen.findByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create Administrator' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least 12 characters');
    await userEvent.clear(screen.getByLabelText('Password')); await userEvent.type(screen.getByLabelText('Password'), 'long-password-1');
    await userEvent.clear(screen.getByLabelText('Confirm password')); await userEvent.type(screen.getByLabelText('Confirm password'), 'long-password-2');
    await userEvent.click(screen.getByRole('button', { name: 'Create Administrator' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match');
    expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/setup', expect.anything());
  });

  it('moves successful setup to explicit login instead of dashboard', async () => {
    vi.stubGlobal('fetch', mockFetch({ initialized: false })); render(<App />);
    await userEvent.type(await screen.findByLabelText('Username'), 'admin'); await userEvent.type(screen.getByLabelText('Password'), 'long-password-1'); await userEvent.type(screen.getByLabelText('Confirm password'), 'long-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create Administrator' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Administrator created');
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('shows login when initialized but unauthenticated', async () => {
    vi.stubGlobal('fetch', mockFetch()); render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders dashboard after valid login while concurrent dashboard APIs resolve', async () => {
    vi.stubGlobal('fetch', mockFetch()); render(<App />); await screen.findByRole('heading', { name: 'Sign in' });
    await userEvent.type(screen.getByLabelText('Username'), 'admin'); await userEvent.type(screen.getByLabelText('Password'), 'long-password-1'); await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument());
  });

  it('uses a generic error for invalid login', async () => {
    vi.stubGlobal('fetch', mockFetch({ loginStatus: 401 })); render(<App />); await screen.findByRole('heading', { name: 'Sign in' });
    await userEvent.type(screen.getByLabelText('Username'), 'admin'); await userEvent.type(screen.getByLabelText('Password'), 'long-password-1'); await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password'); expect(screen.queryByText('sensitive detail')).not.toBeInTheDocument();
  });

  it('centrally returns to session-expired login when a later protected API returns 401', async () => {
    const fetchMock = mockFetch({ authenticated: true }); vi.stubGlobal('fetch', fetchMock); render(<App />);
    expect(await screen.findByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
    fetchMock.mockImplementationOnce(() => json({ error: { message: 'expired' } }, 401));
    await userEvent.click(screen.getByRole('button', { name: 'Proxy Routes' })); await userEvent.click(screen.getByRole('button', { name: 'Add route' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Domain' }), 'new.example.com'); await userEvent.type(screen.getByRole('textbox', { name: /Backend host/ }), '10.0.0.1');
    await userEvent.click(screen.getByRole('button', { name: 'Save route' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent('session expired');
  });

  it('calls logout and returns to login', async () => {
    const fetchMock = mockFetch({ authenticated: true }); vi.stubGlobal('fetch', fetchMock); render(<App />); await screen.findByRole('button', { name: 'Dashboard' });
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument(); expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
  });

  it('never writes authentication tokens to web storage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem'); vi.stubGlobal('fetch', mockFetch()); render(<App />); await screen.findByRole('heading', { name: 'Sign in' });
    await userEvent.type(screen.getByLabelText('Username'), 'admin'); await userEvent.type(screen.getByLabelText('Password'), 'long-password-1'); await userEvent.click(screen.getByRole('button', { name: 'Sign in' })); await screen.findByRole('button', { name: 'Dashboard' });
    expect(local).not.toHaveBeenCalled();
  });

  it('disables scenario/mock bypass under production flags', () => {
    expect(mockScenariosAllowed({ DEV: false, MODE: 'production' })).toBe(false);
  });
});

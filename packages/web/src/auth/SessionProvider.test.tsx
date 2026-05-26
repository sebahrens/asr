import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from './SessionProvider';
import { useSession } from './useSession';

function SessionProbe() {
  const session = useSession();

  return (
    <output aria-label="session">{JSON.stringify({ sub: session.sub, roles: session.roles })}</output>
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

describe('SessionProvider', () => {
  it('provides mock session env values without rendering a competing auth banner', () => {
    vi.stubEnv('VITE_MOCK_SUB', 'u1');
    vi.stubEnv('VITE_MOCK_ROLES', 'Compliance');

    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );

    expect(screen.getByLabelText('session')).toHaveTextContent(
      JSON.stringify({ sub: 'u1', roles: ['Compliance'] }),
    );
    expect(screen.queryByText('Mock auth: Compliance')).not.toBeInTheDocument();
  });

  it('throws when useSession is called outside SessionProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<SessionProbe />)).toThrow('useSession must be used within SessionProvider');

    consoleError.mockRestore();
  });
});

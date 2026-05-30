import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionContext } from '../auth/SessionProvider';
import { BrandProvider } from '../branding/BrandProvider';
import { ReviewAppShell } from './ReviewAppShell';

function renderShell() {
  return render(
    <BrandProvider>
      <SessionContext.Provider value={{ sub: 'reviewer', name: 'Reviewer', roles: ['Compliance'], authMode: 'mock' }}>
        <MemoryRouter initialEntries={['/review']}>
          <ReviewAppShell current="review">
            <main>Review content</main>
          </ReviewAppShell>
        </MemoryRouter>
      </SessionContext.Provider>
    </BrandProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('ReviewAppShell responsive navigation', () => {
  it('opens the mobile primary navigation drawer on review routes', () => {
    renderShell();

    fireEvent.click(screen.getByRole('button', { name: /open primary navigation/i }));

    const mobileNav = screen.getByRole('complementary', { name: /mobile primary navigation/i });
    expect(mobileNav).toBeInTheDocument();
    expect(within(mobileNav).getByRole('link', { name: /browse/i })).toHaveAttribute('href', '/');
    expect(within(mobileNav).getByRole('link', { name: /publish/i })).toHaveAttribute('href', '/publish');
    expect(within(mobileNav).getByRole('link', { name: /review/i })).toHaveAttribute('aria-current', 'page');
    expect(within(mobileNav).getByText('reviewer')).toBeInTheDocument();
  });

  it('closes the review mobile drawer from its internal close control', () => {
    renderShell();

    fireEvent.click(screen.getByRole('button', { name: /open primary navigation/i }));
    const mobileNav = screen.getByRole('complementary', { name: /mobile primary navigation/i });

    fireEvent.click(within(mobileNav).getByRole('button', { name: /close primary navigation/i }));

    expect(screen.queryByRole('complementary', { name: /mobile primary navigation/i })).not.toBeInTheDocument();
  });
});

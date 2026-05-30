import { Link, useSearchParams } from 'react-router-dom';
import { BrandLogo } from '../branding/BrandLogo';
import { PRODUCT_NAME } from '../product';

interface ErrorMessage {
  eyebrow: string;
  title: string;
  body: string;
  devHint?: string;
}

function describeRequiredRoles(roles: string[]): string {
  if (roles.length === 0) {
    return 'a role you do not have';
  }

  if (roles.length === 1) {
    return `the ${roles[0]} role`;
  }

  return `${roles.slice(0, -1).join(', ')} or ${roles[roles.length - 1]} role`;
}

function getErrorMessage(code: string | null, roles: string[]): ErrorMessage {
  if (code === '403') {
    return {
      eyebrow: 'Access denied',
      title: 'You do not have permission to view this page',
      body: `This page requires ${describeRequiredRoles(roles)}. Your current session is missing it — sign in as a user with that role to continue.`,
      devHint: 'Dev mode: set VITE_MOCK_ROLES in your environment (e.g. VITE_MOCK_ROLES=Compliance) and reload to grant the role.',
    };
  }

  if (code === '404') {
    return {
      eyebrow: 'Not found',
      title: 'Page not found',
      body: 'The requested registry page does not exist. Return to browse and try another path.',
    };
  }

  return {
    eyebrow: 'Error',
    title: 'Something went wrong',
    body: 'The registry could not render this page. Return to browse and try again.',
  };
}

function parseRoles(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

export function ErrorPage() {
  const [searchParams] = useSearchParams();
  const code = searchParams.get('code');
  const roles = parseRoles(searchParams.get('roles'));
  const message = getErrorMessage(code, roles);
  const showDevHint = import.meta.env.DEV && Boolean(message.devHint);

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <Link className="logo" to="/" aria-label={`${PRODUCT_NAME} home`}>
            <BrandLogo />
          </Link>
        </div>
      </header>
      <main className="not-found-main">
        <section
          className="not-found-state"
          role="alert"
          aria-live="assertive"
          aria-labelledby="error-page-title"
        >
          <p className="eyebrow">{message.eyebrow}</p>
          <h1 id="error-page-title">{message.title}</h1>
          <p>{message.body}</p>
          {showDevHint ? (
            <p className="error-page-dev-hint">{message.devHint}</p>
          ) : null}
          <div className="not-found-actions">
            <Link className="primary-link" to="/">Browse skills</Link>
          </div>
        </section>
      </main>
    </>
  );
}

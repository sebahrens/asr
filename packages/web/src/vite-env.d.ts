/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BRAND?: 'pwc' | 'neutral';
  readonly VITE_AUTH_MODE?: 'mock' | 'msal';
  readonly VITE_ENABLE_MOCK_AUTH?: string;
  readonly VITE_MOCK_ROLES?: string;
  readonly VITE_MOCK_SUB?: string;
  readonly VITE_ENTRA_CLIENT_ID?: string;
  readonly VITE_ENTRA_TENANT_ID?: string;
  readonly VITE_ENTRA_AUTHORITY?: string;
  readonly VITE_ENTRA_SCOPES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

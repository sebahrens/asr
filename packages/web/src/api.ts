const API_URL = import.meta.env.VITE_API_URL || '';

export function apiUrl(path: string): string {
  return apiUrlWithBase(path, API_URL);
}

export function apiUrlWithBase(path: string, baseUrl: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  if (normalizedBase.length === 0) {
    return normalizedPath;
  }

  const basePath = getBasePath(normalizedBase);
  if (basePath && (normalizedPath === basePath || normalizedPath.startsWith(`${basePath}/`))) {
    return `${normalizedBase.slice(0, -basePath.length)}${normalizedPath}`;
  }

  return `${normalizedBase}${normalizedPath}`;
}

function getBasePath(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return normalizeBasePath(url.pathname);
  } catch {
    return baseUrl.startsWith('/') ? normalizeBasePath(baseUrl) : undefined;
  }
}

function normalizeBasePath(pathname: string): string | undefined {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized && normalized !== '/' ? normalized : undefined;
}

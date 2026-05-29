const API_URL = import.meta.env.VITE_API_URL || '';

export function apiUrl(path: string): string {
  return apiUrlWithBase(path, API_URL);
}

export function apiUrlWithBase(path: string, baseUrl: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (baseUrl.length === 0) {
    return normalizedPath;
  }

  return `${baseUrl.replace(/\/+$/, '')}${normalizedPath}`;
}

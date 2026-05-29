import { Component, type ErrorInfo, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ErrorPage } from './routes/ErrorPage';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export function reportTopLevelReactError(error: Error, errorInfo: ErrorInfo) {
  console.error('Top-level React render error', {
    error,
    componentStack: errorInfo.componentStack,
  });
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportTopLevelReactError(error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <MemoryRouter initialEntries={['/error']}>
          <ErrorPage />
        </MemoryRouter>
      );
    }

    return this.props.children;
  }
}

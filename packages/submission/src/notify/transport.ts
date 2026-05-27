export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

export class InMemoryTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];

  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

class NotConfiguredTransport implements EmailTransport {
  constructor(private readonly kind: 'smtp' | 'graph') {}

  async send(_msg: EmailMessage): Promise<void> {
    throw new Error(
      `Email transport '${this.kind}' is not configured (prod wiring lands in a later task)`,
    );
  }
}

export interface TransportEnv {
  NOTIFY_TRANSPORT?: 'memory' | 'smtp' | 'graph';
}

export function createTransport(env: TransportEnv): EmailTransport {
  switch (env.NOTIFY_TRANSPORT) {
    case 'smtp':
    case 'graph':
      return new NotConfiguredTransport(env.NOTIFY_TRANSPORT);
    case 'memory':
    default:
      return new InMemoryTransport();
  }
}

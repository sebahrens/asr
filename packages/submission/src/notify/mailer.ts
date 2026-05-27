import type { EmailTransport } from './transport.js';
import { render, type NotifyEvent, type TemplateContext } from './templates.js';

export type { NotifyEvent, TemplateContext } from './templates.js';

export async function notify(
  transport: EmailTransport,
  to: string,
  event: NotifyEvent,
  ctx: TemplateContext,
): Promise<void> {
  const { subject, body } = render(event, ctx);
  await transport.send({ to, subject, body });
}

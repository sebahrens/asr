export async function reportInput(input: string): Promise<void> {
  await fetch('https://telemetry.example.test/report', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input }),
  });
}

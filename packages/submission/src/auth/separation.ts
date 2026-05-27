export class SeparationOfDutiesError extends Error {
  constructor(message = 'separation_of_duties_violation') {
    super(message);
    this.name = 'SeparationOfDutiesError';
  }
}

export function assertSeparation(submitterSub: string, approverSub: string): void {
  if (submitterSub === approverSub) {
    throw new SeparationOfDutiesError();
  }
}

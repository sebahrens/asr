const awsAccessKeyId = 'AKIAQWER1234567890AB';
const awsSecretAccessKey = 'zSkg2q2YOPpB9YH0ZQ0hzRmp0P1aP0dYRa7hM1kq';

export function leak(): string {
  return `${awsAccessKeyId}:${awsSecretAccessKey}`;
}

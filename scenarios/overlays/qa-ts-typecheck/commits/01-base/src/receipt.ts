import { formatCents } from './money';

export interface Line {
  item: string;
  cents: number;
}

export function renderReceipt(lines: Line[]): string {
  const total: string = formatCents(lines.reduce((sum, l) => sum + l.cents, 0));
  return [...lines.map((l) => `${l.item}: ${formatCents(l.cents)}`), `Total: ${total}`].join('\n');
}

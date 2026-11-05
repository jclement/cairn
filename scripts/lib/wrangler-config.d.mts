export interface InstanceValues {
  d1Id?: string;
  kvId?: string;
  publicUrl?: string;
  customDomain?: string | null;
  email?: string;
  openSignup?: boolean;
}
export function stripJsonc(text: string): string;
// biome-ignore lint/suspicious/noExplicitAny: parsed JSONC
export function parseJsonc(text: string): any;
export function setInstanceValues(text: string, v: InstanceValues): string;
export function publicUrlOf(text: string): string | undefined;

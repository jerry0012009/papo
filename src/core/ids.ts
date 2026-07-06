import { nanoid } from "nanoid";

export function makeId(prefix: string): string {
  return `${prefix}_${nanoid(10)}`;
}

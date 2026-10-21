import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Default greeting. */
export const DEFAULT_GREETING = 'Hello';

export interface Person {
  name: string;
  title?: string;
}

// A class with enough members to be split per method.
export class Greeter {
  private count = 0;

  constructor(private readonly greeting: string = DEFAULT_GREETING) {}

  /** Greet one person. */
  greet(person: Person): string {
    this.count++;
    return `${this.greeting}, ${person.title ?? ''} ${person.name}`.trim();
  }

  get greeted(): number {
    return this.count;
  }
}

export function loadPeople(file: string): Promise<Person[]> {
  return readFile(path.resolve(file), 'utf8').then((raw) => JSON.parse(raw) as Person[]);
}

export const shout = (s: string) => s.toUpperCase();

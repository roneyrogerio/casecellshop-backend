import * as fc from 'fast-check';
import { expect } from 'vitest';

// Os nomes começam por `expect` para o `vitest/expect-expect` reconhecê-los como asserção (.oxlintrc.json).

export function expectProperty<T>(property: fc.IPropertyWithHooks<T>): void {
  fc.assert(property);
}

export async function expectAsyncProperty<T>(
  property: fc.IAsyncPropertyWithHooks<T>,
): Promise<void> {
  await fc.assert(property);
}

// Controle negativo: a propriedade tem de achar um contraexemplo na versão quebrada.
export function expectFalsified<T>(property: fc.IPropertyWithHooks<T>): void {
  expect(fc.check(property).failed).toBe(true);
}

export async function expectFalsifiedAsync<T>(
  property: fc.IAsyncPropertyWithHooks<T>,
): Promise<void> {
  expect((await fc.check(property)).failed).toBe(true);
}

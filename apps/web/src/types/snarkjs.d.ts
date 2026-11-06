declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: unknown,
      zkey: unknown,
      logger?: unknown,
      wtnsCalcOptions?: unknown,
      proverOptions?: { singleThread?: boolean },
    ): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
  export const zKey: {
    contribute(oldKey: unknown, newKey: unknown, name: string, entropy: string, logger?: unknown): Promise<Uint8Array>;
  };
  export const curves: { getCurveFromName(name: string, options?: { singleThread?: boolean }): Promise<unknown> };
  export const wtns: { calculate(input: Record<string, unknown>, wasm: unknown, out: unknown): Promise<void> };
}

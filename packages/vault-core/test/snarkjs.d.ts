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
  export const wtns: { calculate(input: Record<string, unknown>, wasm: unknown, out: unknown): Promise<void> };
}

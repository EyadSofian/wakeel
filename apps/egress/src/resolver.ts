import { lookup } from "node:dns/promises";

/**
 * DNS is a port so tests can play a rebinding attacker (build plan 3.1). The proxy resolves each
 * hop exactly once and dials the address it checked; it never lets the HTTP client resolve again.
 */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface Resolver {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

/** The operating system's resolver (getaddrinfo), every address it returns, in its order. */
export const systemResolver: Resolver = {
  async resolve(hostname) {
    const answers = await lookup(hostname, { all: true, order: "verbatim" });
    return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  },
};

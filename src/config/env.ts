/**
 * Runtime environment. Every value is optional — the game is fully playable
 * with none of them set. `mockMode` is the single source of truth for
 * "pretend the backend and the chain exist".
 */

const raw = import.meta.env as Record<string, string | undefined>;

const str = (k: string, fallback = ''): string => (raw[k] ?? fallback).trim();
const num = (k: string, fallback: number): number => {
  const v = Number.parseFloat(str(k));
  return Number.isFinite(v) ? v : fallback;
};
const bool = (k: string, fallback = false): boolean => {
  const v = str(k).toLowerCase();
  return v === '' ? fallback : v === 'true' || v === '1' || v === 'yes';
};

export type SolanaNetwork = 'devnet' | 'testnet' | 'mainnet-beta';

const network = (['devnet', 'testnet', 'mainnet-beta'] as const).includes(
  str('VITE_SOLANA_NETWORK', 'devnet') as SolanaNetwork,
)
  ? (str('VITE_SOLANA_NETWORK', 'devnet') as SolanaNetwork)
  : 'devnet';

const supabaseUrl = str('VITE_SUPABASE_URL');
const supabaseAnonKey = str('VITE_SUPABASE_ANON_KEY');
const convoyMint = str('VITE_CONVOY_MINT');

const forceMock = bool('VITE_FORCE_MOCK', false);

export const env = {
  /** Cloud persistence + server leaderboard available. */
  supabase: {
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
    enabled: !forceMock && supabaseUrl.length > 0 && supabaseAnonKey.length > 0,
  },
  solana: {
    network,
    rpcUrl: str('VITE_SOLANA_RPC_URL', `https://api.${network === 'mainnet-beta' ? 'mainnet-beta' : network}.solana.com`),
    mint: convoyMint,
    symbol: str('VITE_CONVOY_SYMBOL', 'CONVOY'),
    decimals: num('VITE_CONVOY_DECIMALS', 9),
    treasury: str('VITE_CONVOY_TREASURY'),
    minHolderBalance: num('VITE_MIN_HOLDER_BALANCE', 100),
    entryFee: num('VITE_EXPEDITION_ENTRY_FEE', 25),
    /** Real chain reads are only attempted when a mint is configured. */
    enabled: !forceMock && convoyMint.length > 0,
  },
  /** No backend, no chain: simulate both so every screen still works. */
  get mockMode(): boolean {
    return forceMock || (!this.supabase.enabled && !this.solana.enabled);
  },
  forceMock,
} as const;

export const TOKEN = env.solana.symbol;
